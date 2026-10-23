import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { validateReleaseVersion, validateUpdateMetadata, verifyUpdateSignature } from './release-config.mjs';

const root = process.cwd();
const desktopPackage = readJson(join(root, 'apps/desktop/package.json'));
const rootPackage = readJson(join(root, 'package.json'));
validateReleaseVersion(rootPackage, desktopPackage);
const distDirectory = join(root, process.env.TBLINK_DIST_DIRECTORY ?? 'apps/desktop/dist');
const expectedInstallerName = `Tuanbo-Link-Console-${desktopPackage.version}-x64.exe`;
if (process.platform !== 'win32') fail('Windows release manifest 必须在 Windows 原生环境生成');
if (!existsSync(distDirectory)) fail('缺少 apps/desktop/dist，请先运行 pnpm dist');

const artifactPaths = listFiles(distDirectory).filter((file) => {
  const relativePath = relative(distDirectory, file).replaceAll('\\', '/');
  return relativePath === expectedInstallerName
    || relativePath === `${expectedInstallerName}.blockmap`
    || relativePath === 'latest.yml'
    || relativePath === 'win-unpacked/团播联动台.exe'
    || relativePath === 'win-unpacked/resources/app.asar';
}).sort();
const artifacts = artifactPaths.map((file) => {
  const data = readFileSync(file);
  return {
    path: relative(root, file).replaceAll('\\', '/'),
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    ...(extname(file).toLowerCase() === '.exe' ? { authenticode: readAuthenticodeStatus(file) } : {})
  };
});
const installer = artifacts.find((artifact) => basename(artifact.path) === expectedInstallerName);
const unpacked = artifacts.find((artifact) => artifact.path.endsWith('/win-unpacked/团播联动台.exe'));
const installerVersionInfo = installer ? readWindowsVersionInfo(join(root, installer.path)) : undefined;
// Clients compare this releaseDate with the license's updatesUntil; publish-update.py binds latest.yml to this manifest by sha256.
const updateMetadata = readUpdateMetadata();
// Unsigned candidates are for install acceptance only; the server's publish step refuses releaseSignature null.
const releaseSignature = readReleaseSignature();
const appVersionInfo = unpacked ? readWindowsVersionInfo(join(root, unpacked.path)) : undefined;
const checks = [
  { name: 'windows-nsis-installer', ok: Boolean(installer), detail: installer?.path ?? 'missing' },
  { name: 'windows-unpacked-executable', ok: Boolean(unpacked), detail: unpacked?.path ?? 'missing' },
  {
    name: 'authenticode-status-recorded',
    ok: artifacts.filter((artifact) => artifact.path.endsWith('.exe')).every((artifact) => typeof artifact.authenticode === 'string'),
    detail: artifacts.filter((artifact) => artifact.path.endsWith('.exe')).map((artifact) => `${basename(artifact.path)}=${artifact.authenticode}`).join(', ')
  },
  {
    // Code signing is optional (no certificate); a signature that is present must be valid on both files.
    name: 'authenticode-signed-or-unsigned',
    ok: installer?.authenticode === unpacked?.authenticode && ['NotSigned', 'Valid'].includes(installer?.authenticode),
    detail: `installer=${installer?.authenticode ?? 'missing'}, app=${unpacked?.authenticode ?? 'missing'}`
  },
  { name: 'release-signature-valid-or-absent', ok: !('error' in releaseSignature), detail: 'error' in releaseSignature ? releaseSignature.error : releaseSignature.kid ?? 'unsigned: install acceptance only' },
  { name: 'update-metadata-matches-installer', ok: 'releaseDate' in updateMetadata, detail: 'releaseDate' in updateMetadata ? `version=${updateMetadata.version}, releaseDate=${updateMetadata.releaseDate}` : updateMetadata.error },
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
];
const failed = checks.filter((check) => !check.ok);
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  productName: '团播联动台',
  version: String(desktopPackage.version),
  ...readGitState(),
  platform: process.platform,
  architecture: process.arch,
  toolchain: {
    node: process.version,
    pnpm: String(rootPackage.packageManager).replace('pnpm@', ''),
    electron: String(desktopPackage.build.electronVersion)
  },
  update: 'releaseDate' in updateMetadata ? { releaseDate: updateMetadata.releaseDate, sha512: updateMetadata.sha512 } : null,
  releaseSignature: 'kid' in releaseSignature && releaseSignature.kid ? { kid: releaseSignature.kid } : null,
  signing: {
    authenticode: installer?.authenticode ?? 'missing',
    smartScreenNoticeRequired: installer?.authenticode !== 'Valid'
  },
  summary: {
    artifactCount: artifacts.length,
    totalBytes: artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
    checksPassed: checks.length - failed.length,
    checksFailed: failed.length
  },
  artifacts,
  checks
};
const outputPath = join(distDirectory, 'release-manifest.json');
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release manifest written: ${relative(root, outputPath)}`);
for (const check of checks) console.log(`${check.ok ? 'ok' : 'fail'}  ${check.name}  ${check.detail}`);
if (failed.length > 0) fail(`发布清单校验失败：\n${failed.map((check) => `- ${check.name}: ${check.detail}`).join('\n')}`);

function readUpdateMetadata() {
  const feed = join(distDirectory, 'latest.yml');
  if (!installer || !existsSync(feed)) return { error: 'missing installer or latest.yml' };
  try {
    return validateUpdateMetadata(readFileSync(feed, 'utf8'), { version: desktopPackage.version, installerName: expectedInstallerName, installerBytes: readFileSync(join(root, installer.path)) });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readReleaseSignature() {
  const feed = join(distDirectory, 'latest.yml');
  if (!installer || !existsSync(feed)) return { error: 'missing installer or latest.yml' };
  try {
    const publicKeys = readJson(join(root, 'apps/desktop/src/main/link/release-public-keys.json'));
    return { kid: verifyUpdateSignature(readFileSync(feed, 'utf8'), { installerName: expectedInstallerName, installerBytes: readFileSync(join(root, installer.path)), publicKeys }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readAuthenticodeStatus(file) {
  const encoded = Buffer.from(file, 'utf16le').toString('base64');
  const script = `Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); (Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop).Status.ToString()`;
  return execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
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

function readGitState() {
  const candidates = ['git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'];
  for (const command of candidates) {
    try {
      return {
        gitSha: execFileSync(command, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        gitWorkingTreeDirty: execFileSync(command, ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
      };
    } catch (error) {
      if (command === candidates.at(-1)) throw error;
    }
  }
  throw new Error('Git executable not found');
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

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function fail(message) { console.error(message); process.exit(1); }
