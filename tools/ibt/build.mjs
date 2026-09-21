import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build only from the public upstream revision. No BeatEdit distribution files are used.
const revision = '92df3ceaa94aa73a8bf03edf751a790bc87b157f';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const output = join(root, 'output'), source = join(output, 'ibt-source'), build = join(output, 'ibt-build');
const bin = join(here, 'bin'), executable = join(bin, 'ibt.exe');
const recipe = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(join(here, 'README.md'))).digest('hex');
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`IBT 构建失败：${command} (${result.status})`);
};
if (process.platform !== 'win32') throw new Error('IBT 当前构建目标为 Windows x64');
if (['build.json', 'ibt.exe', 'marsyas-source.zip', 'COPYING', 'build.mjs', 'README.md'].every(file => existsSync(join(bin, file)))) {
  const stamp = JSON.parse(await readFile(join(bin, 'build.json'), 'utf8'));
  const digest = createHash('sha256').update(await readFile(executable)).digest('hex');
  if (stamp.recipe === recipe && stamp.revision === revision && stamp.sha256 === digest) process.exit(0);
}
await mkdir(output, { recursive: true }); await mkdir(bin, { recursive: true });
const compiler = join(root, 'tools/obs/native-preview/compiler/zig-x86_64-windows-0.14.1/zig.exe');
if (!existsSync(compiler)) run(process.execPath, [join(root, 'tools/obs/native-preview/build.mjs')]);
if (!existsSync(source)) {
  run('git', ['init', source]);
  run('git', ['remote', 'add', 'origin', 'https://github.com/marsyas/marsyas.git'], source);
  run('git', ['fetch', '--depth', '1', 'origin', revision], source);
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], source);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true });
if (head.status !== 0 || head.stdout.trim() !== revision) throw new Error('IBT 源码版本与固定版本不一致');
const changed = spawnSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8', windowsHide: true });
if (changed.status !== 0 || changed.stdout.trim()) throw new Error('IBT 上游源码存在修改，请使用固定版本的干净源码');
const dependencies = join(output, 'ibt-build-tools');
const cmake = join(dependencies, 'cmake/data/bin/cmake.exe'), ninja = join(dependencies, 'bin/ninja.exe');
if (!existsSync(cmake) || !existsSync(ninja)) run('python', ['-m', 'pip', 'install', '--target', dependencies, 'cmake==4.4.3', 'ninja==1.13.2']);
const ar = join(output, 'ibt-ar.cmd'), ranlib = join(output, 'ibt-ranlib.cmd');
await writeFile(ar, `@"${compiler}" ar %*\r\n`); await writeFile(ranlib, `@"${compiler}" ranlib %*\r\n`);
const option = (name, value) => `-D${name}=${value.replaceAll('\\', '/')}`;
run(cmake, ['-S', source, '-B', build, '-G', 'Ninja',
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', option('CMAKE_MAKE_PROGRAM', ninja),
  option('CMAKE_C_COMPILER', compiler), '-DCMAKE_C_COMPILER_ARG1=cc',
  option('CMAKE_CXX_COMPILER', compiler), '-DCMAKE_CXX_COMPILER_ARG1=c++',
  option('CMAKE_AR', ar), option('CMAKE_RANLIB', ranlib), '-DCMAKE_BUILD_TYPE=Release',
  '-DMARSYAS_STATIC=ON', '-DMARSYAS_AUDIOIO=OFF', '-DMARSYAS_MIDIIO=OFF', '-DWITH_CPP11=OFF', '-DCMAKE_CXX_STANDARD=11']);
run(cmake, ['--build', build, '--target', 'ibt', '-j', '4']);
await copyFile(join(build, 'bin/ibt.exe'), executable);
await copyFile(join(source, 'COPYING'), join(bin, 'COPYING'));
run('git', ['archive', '--format=zip', '--prefix=marsyas/', '-o', join(bin, 'marsyas-source.zip'), revision], source);
await copyFile(fileURLToPath(import.meta.url), join(bin, 'build.mjs'));
await copyFile(join(here, 'README.md'), join(bin, 'README.md'));
await writeFile(join(bin, 'build.json'), JSON.stringify({ revision, recipe, compiler: 'Zig 0.14.1', sha256: createHash('sha256').update(await readFile(executable)).digest('hex') }, null, 2));
