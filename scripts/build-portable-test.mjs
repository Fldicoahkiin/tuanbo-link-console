// Explicit, isolated cross-machine test distribution. Never used by release scripts.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { portableTestPackage, testPackageVersion } from './release-config.mjs';

if (process.platform !== 'win32') throw new Error('测试安装包必须在 Windows 构建');
if (!process.argv[2]) throw new Error('请指定一个尚不存在的独立构建目录');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const destination = resolve(process.argv[2]);
await mkdir(destination); // Refuse to overwrite an existing build or a running test.
await mkdir(join(destination, 'temp'));
const distribution = join(destination, 'distribution.json');
await writeFile(distribution, JSON.stringify({ channel: 'portable-test', version: 1 }));
const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
const gitText = (args) => { const result = git(args); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`git ${args[0]} 失败：${result.stderr}`); return result.stdout.trim(); };
const commitCount = Number(gitText(['rev-list', '--count', 'HEAD']));
const version = testPackageVersion({
  packageVersion: JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version,
  tags: gitText(['tag', '--list', 'v*']).split('\n').filter(Boolean),
  commitCount, sha: gitText(['rev-parse', '--short=7', 'HEAD']), dirty: gitText(['status', '--porcelain']) !== ''
});
const env = { ...process.env, TBLINK_INTERNAL_DISTRIBUTION_FILE: distribution, TBLINK_BUILD_VERSION: version,
  TEMP: join(destination, 'temp'), TMP: join(destination, 'temp') };
const requireDesktop = createRequire(join(desktop, 'package.json'));
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: desktop, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`构建失败：${script}，退出码 ${result.status}`);
}
// Existing build scripts verify their source hashes; native test binaries elsewhere are untouched.
for (const script of ['tools/obs/native-preview/build.mjs', 'tools/ibt/build.mjs', 'tools/midi-probe/build.mjs', 'tools/playback-engine/build.mjs']) run(join(root, script));
const musicRuntime = join(destination, 'music-analysis');
run(join(root, 'tools/music-analysis/package-runtime.mjs'), [musicRuntime]);
const appOut = join(destination, 'app-out');
run(join(dirname(requireDesktop.resolve('electron-vite/package.json')), 'bin/electron-vite.js'), ['build', '--outDir', appOut]);
const desktopPackage = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const name = portableTestPackage.productName;
const config = {
  ...desktopPackage.build,
  appId: portableTestPackage.appId, productName: name,
  extraMetadata: { name: portableTestPackage.name, productName: name, version },
  // The fourth part of the Windows file version; X.Y.Z-test.N is not a valid Windows version.
  buildNumber: String(commitCount),
  directories: { ...desktopPackage.build.directories, output: destination },
  files: [{ from: appOut, to: 'out', filter: ['**/*', '!**/*.map'] }, 'build/icon.ico', 'package.json'],
  extraResources: [...desktopPackage.build.extraResources, { from: musicRuntime, to: 'music-analysis' }],
  publish: null,
  win: { ...desktopPackage.build.win, artifactName: portableTestPackage.artifactPrefix + '${version}-${arch}.exe' },
  nsis: { ...desktopPackage.build.nsis, shortcutName: name, uninstallDisplayName: name, runAfterFinish: false }
};
const configPath = join(destination, 'builder.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
run(join(dirname(requireDesktop.resolve('electron-builder/package.json')), 'cli.js'), ['--config', configPath, '--publish', 'never']);
const verification = spawnSync(process.execPath, [join(root, 'scripts/verify-desktop-artifacts.mjs'), '--test-dist', destination], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (verification.error) throw verification.error;
if (verification.status !== 0) throw new Error(`测试安装包校验失败，退出码 ${verification.status}；不要分发 ${destination}`);
console.log(`免激活测试安装包 ${version} 已生成并通过校验：${destination}`);
