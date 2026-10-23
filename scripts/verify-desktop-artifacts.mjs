import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { embeddedDistributionChannel, portableTestPackage, readAsarFile, validatePackagedUpdateConfig, validateReleaseVersion } from './release-config.mjs';

const requireDist = process.argv.includes('--dist');
const root = process.cwd();
const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
validateReleaseVersion(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), desktopPackage);
const testDistribution = process.argv.indexOf('--test-dist');
if (testDistribution !== -1) {
  if (!process.argv[testDistribution + 1]) fail('用法：node scripts/verify-desktop-artifacts.mjs --test-dist <测试包构建目录>');
  report(verifyTestDistribution(resolve(process.argv[testDistribution + 1])), '免激活测试包产物校验通过');
}
const requiredBuildFiles = [
  'apps/desktop/out/main/index.cjs',
  'apps/desktop/out/preload/index.cjs',
  'apps/desktop/out/renderer/index.html',
  'tools/midi-probe/bin/tblink-midi-probe.exe',
  'tools/ibt/bin/ibt.exe',
  'tools/ibt/bin/COPYING',
  'tools/ibt/bin/marsyas-source.zip',
  'tools/ibt/bin/build.mjs',
  'tools/ibt/bin/README.md',
  'tools/ibt/bin/build.json'
];

const missing = requiredBuildFiles.filter((file) => !existsSync(join(root, file)));
if (missing.length > 0) fail(`缺少桌面构建产物：\n${missing.map((file) => `- ${file}`).join('\n')}`);

const preload = readFileSync(join(root, 'apps/desktop/out/preload/index.cjs'), 'utf8');
const main = readFileSync(join(root, 'apps/desktop/out/main/index.cjs'), 'utf8');
const checks = [
  { name: 'typed-link-preload', ok: preload.includes('tbLink'), detail: 'preload exposes tbLink' },
  { name: 'legacy-runtime-removed', ok: !preload.includes('tbRuntime'), detail: 'preload does not expose tbRuntime' },
  { name: 'program-window-removed', ok: !main.includes('openProgramWindow'), detail: 'main has no Program window API' },
  { name: 'obs-helper-removed', ok: !main.includes('obs-helper-client') && !main.includes('tuanbo-obs-helper'), detail: 'main has no libobs helper path' }
];

if (requireDist) {
  if (process.platform !== 'win32') fail('--dist 发布校验必须在 Windows 原生环境运行');
  const distDirectory = join(root, process.env.TBLINK_DIST_DIRECTORY ?? 'apps/desktop/dist');
  if (!existsSync(distDirectory)) fail('缺少 apps/desktop/dist，请先运行 pnpm dist');
  const files = listFiles(distDirectory);
  const expectedInstallerName = `Tuanbo-Link-Console-${desktopPackage.version}-x64.exe`;
  const installer = files.find((file) => relative(distDirectory, file).replaceAll('\\', '/') === expectedInstallerName);
  const unpackedExecutable = files.find((file) => relative(distDirectory, file).replaceAll('\\', '/') === 'win-unpacked/团播联动台.exe');
  const updateMetadata = files.find((file) => relative(distDirectory, file).replaceAll('\\', '/') === 'latest.yml');
  const packagedUpdateConfig = files.find((file) => relative(distDirectory, file).replaceAll('\\', '/') === 'win-unpacked/resources/app-update.yml');
  const updateConfigText = packagedUpdateConfig ? readFileSync(packagedUpdateConfig, 'utf8') : '';
  validatePackagedUpdateConfig(updateConfigText, desktopPackage.build.publish);
  const packagedBridge = join(distDirectory, 'win-unpacked/resources/obs/tblink-realtime-preview.dll');
  const builtBridge = join(root, 'tools/obs/native-preview/tblink-realtime-preview.dll');
  const bridgeMatches = existsSync(packagedBridge) && existsSync(builtBridge)
    && readFileSync(packagedBridge).equals(readFileSync(builtBridge));
  // Release builds compile out the development activation bypass; asar stores bundles uncompressed.
  const packagedApp = join(distDirectory, 'win-unpacked/resources/app.asar');
  const packagedAppBytes = existsSync(packagedApp) ? readFileSync(packagedApp) : undefined;
  const testAccessMarkers = ['TBLINK_LOCAL_TEST_ACCESS', '.local-test-access', '本机开发测试通道']
    .filter((marker) => !packagedAppBytes || packagedAppBytes.includes(Buffer.from(marker)));
  const packagedIdentity = packagedAppBytes ? JSON.parse(readAsarFile(packagedApp, 'package.json').toString('utf8')) : undefined;
  const packagedDistribution = packagedAppBytes ? embeddedDistributionChannel(readAsarFile(packagedApp, 'out/main/index.cjs')) : 'missing app.asar';
  const installerVersionInfo = installer ? readWindowsVersionInfo(installer) : undefined;
  const appVersionInfo = unpackedExecutable ? readWindowsVersionInfo(unpackedExecutable) : undefined;
  checks.push(
    { name: 'bundled-midi-driver-probe', ok: existsSync(join(distDirectory, 'win-unpacked/resources/midi/tblink-midi-probe.exe')) && readFileSync(join(distDirectory, 'win-unpacked/resources/midi/tblink-midi-probe.exe')).equals(readFileSync(join(root, 'tools/midi-probe/bin/tblink-midi-probe.exe'))), detail: 'isolated MIDI driver probe matches this build' },
    { name: 'bundled-ibt-engine-and-source', ok: ['ibt.exe', 'COPYING', 'marsyas-source.zip', 'build.mjs', 'README.md', 'build.json'].every(file => {
      const packaged = join(distDirectory, 'win-unpacked/resources/ibt', file);
      return existsSync(packaged) && readFileSync(packaged).equals(readFileSync(join(root, 'tools/ibt/bin', file)));
    }), detail: 'IBT engine, corresponding source, license and build instructions match this build' },
    { name: 'bundled-obs-native-bridge', ok: bridgeMatches, detail: bridgeMatches ? 'packaged DLL matches this build; no runtime compiler required' : 'missing or mismatched OBS bridge DLL' },
    { name: 'release-excludes-test-distribution', ok: packagedDistribution === null, detail: packagedDistribution === null ? 'main bundle has no activation-free or internal distribution' : `main bundle carries ${packagedDistribution}` },
    // NSIS installs per user into a folder named after the package name; Electron keeps userData under productName.
    { name: 'release-package-identity', ok: packagedIdentity?.name === desktopPackage.name && packagedIdentity?.productName === desktopPackage.productName,
      detail: `name=${packagedIdentity?.name}, productName=${packagedIdentity?.productName}` },
    { name: 'release-excludes-local-test-access', ok: testAccessMarkers.length === 0, detail: packagedAppBytes ? (testAccessMarkers.length === 0 ? 'app.asar has no development activation bypass' : `app.asar contains ${testAccessMarkers.join(', ')}`) : 'missing app.asar' },
    { name: 'windows-nsis-installer', ok: Boolean(installer), detail: installer ? relative(root, installer) : 'missing' },
    { name: 'windows-unpacked-executable', ok: Boolean(unpackedExecutable), detail: unpackedExecutable ? relative(root, unpackedExecutable) : 'missing' },
    { name: 'windows-update-metadata', ok: Boolean(updateMetadata), detail: updateMetadata ? relative(root, updateMetadata) : 'missing latest.yml' },
    {
      name: 'packaged-company-update-config',
      ok: Boolean(packagedUpdateConfig),
      detail: packagedUpdateConfig ? relative(root, packagedUpdateConfig) : 'missing app-update.yml'
    },
    {
      name: 'windows-installer-version-info',
      ok: installerVersionInfo?.ProductName === desktopPackage.productName
        && installerVersionInfo?.FileDescription === desktopPackage.description
        && installerVersionInfo?.FileVersion === desktopPackage.version,
      detail: formatVersionInfo(installerVersionInfo)
    },
    {
      name: 'windows-app-version-info',
      ok: appVersionInfo?.ProductName === desktopPackage.productName
        && appVersionInfo?.FileDescription === desktopPackage.productName
        && appVersionInfo?.FileVersion === desktopPackage.version,
      detail: formatVersionInfo(appVersionInfo)
    }
  );
}

report(checks, requireDist ? 'Windows 桌面构建与发布产物校验通过' : '桌面构建产物校验通过');

function report(results, success) {
  for (const check of results) console.log(`${check.ok ? 'ok' : 'fail'}  ${check.name}  ${check.detail}`);
  const failed = results.filter((check) => !check.ok);
  if (failed.length > 0) fail(`桌面产物校验失败：\n${failed.map((check) => `- ${check.name}: ${check.detail}`).join('\n')}`);
  console.log(success);
  process.exit(0);
}

/** The test package must stay apart from the official app and can never reach the official update feed. */
function verifyTestDistribution(directory) {
  if (process.platform !== 'win32') fail('--test-dist 校验必须在 Windows 原生环境运行');
  if (!existsSync(directory)) fail(`缺少测试包构建目录：${directory}`);
  const entries = readdirSync(directory);
  const installerName = `${portableTestPackage.artifactPrefix}${desktopPackage.version}-x64.exe`;
  const installer = join(directory, installerName);
  const executable = join(directory, 'win-unpacked', `${portableTestPackage.productName}.exe`);
  const packagedApp = join(directory, 'win-unpacked/resources/app.asar');
  const effectiveConfig = join(directory, 'builder-effective-config.yaml');
  const identity = existsSync(packagedApp) ? JSON.parse(readAsarFile(packagedApp, 'package.json').toString('utf8')) : undefined;
  const distribution = existsSync(packagedApp) ? embeddedDistributionChannel(readAsarFile(packagedApp, 'out/main/index.cjs')) : null;
  const executableInfo = existsSync(executable) ? readWindowsVersionInfo(executable) : undefined;
  const configText = existsSync(effectiveConfig) ? readFileSync(effectiveConfig, 'utf8') : '';
  return [
    { name: 'test-installer', ok: existsSync(installer), detail: installerName },
    { name: 'test-executable-version-info', ok: executableInfo?.ProductName === portableTestPackage.productName && executableInfo?.FileVersion === desktopPackage.version, detail: formatVersionInfo(executableInfo) },
    { name: 'test-package-identity', ok: identity?.name === portableTestPackage.name && identity?.productName === portableTestPackage.productName,
      detail: `name=${identity?.name}, productName=${identity?.productName}; install folder and userData follow these` },
    { name: 'test-app-id', ok: new RegExp(`^appId: ${portableTestPackage.appId.replaceAll('.', '\\.')}$`, 'm').test(configText), detail: existsSync(effectiveConfig) ? 'builder-effective-config.yaml' : 'missing builder-effective-config.yaml' },
    { name: 'test-embeds-portable-distribution', ok: distribution === 'portable-test', detail: `main bundle distribution=${distribution}` },
    { name: 'test-has-no-update-config', ok: !existsSync(join(directory, 'win-unpacked/resources/app-update.yml')), detail: 'no app-update.yml: the package never reads a feed' },
    { name: 'test-has-no-official-feed-files', ok: !entries.includes('latest.yml') && !entries.some((name) => name.startsWith('Tuanbo-Link-Console-')),
      detail: 'no latest.yml and no Tuanbo-Link-Console-* installer that publish-update.py would accept' }
  ];
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

function readWindowsVersionInfo(file) {
  const encoded = Buffer.from(file, 'utf16le').toString('base64');
  const script = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $i=(Get-Item -LiteralPath $p -ErrorAction Stop).VersionInfo; @{ProductName=$i.ProductName;FileDescription=$i.FileDescription;FileVersion=$i.FileVersion;ProductVersion=$i.ProductVersion}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }));
}

function formatVersionInfo(versionInfo) {
  if (!versionInfo) return 'missing';
  return `product=${versionInfo.ProductName}, description=${versionInfo.FileDescription}, fileVersion=${versionInfo.FileVersion}, productVersion=${versionInfo.ProductVersion}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
