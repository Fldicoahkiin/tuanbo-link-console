import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'bin');
const exe = join(bin, 'tblink-process-identity.exe');
const stamp = join(bin, 'build.json');
const recipe = createHash('sha256').update(await readFile(join(here, 'identity.c'))).update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
if (process.platform !== 'win32') throw new Error('进程识别组件必须在 Windows 构建');
if (existsSync(exe) && existsSync(stamp)) {
  const previous = JSON.parse(await readFile(stamp, 'utf8'));
  if (previous.recipe === recipe && previous.sha256 === createHash('sha256').update(await readFile(exe)).digest('hex')) process.exit(0);
}
const compiler = join(here, '../obs/native-preview/compiler/zig-x86_64-windows-0.14.1/zig.exe');
if (!existsSync(compiler)) throw new Error('请先构建 OBS 原生组件以准备项目固定版本的编译器');
await mkdir(bin, { recursive: true });
const result = spawnSync(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Werror', join(here, 'identity.c'), '-o', exe], { windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('进程识别组件构建失败');
// Check the fresh build on this machine: it must describe this Node process by its own path and command line,
// and report a PID that does not exist as an error instead of guessing.
const absentPid = 4294967292;
const probe = spawnSync(exe, [String(process.pid), String(absentPid)], { windowsHide: true, encoding: 'utf8' });
if (probe.error) throw probe.error;
if (probe.status !== 0) throw new Error(`进程识别组件自检失败（${probe.status}）：${probe.stderr}`);
const [self, absent, ...extra] = JSON.parse(probe.stdout);
// Windows reports the image's final path, so a Node reached through a symlink or junction is compared by its real path too.
const ownPaths = [process.execPath, realpathSync.native(process.execPath)].map(path => path.toLowerCase());
if (extra.length !== 0 || self?.pid !== process.pid || typeof self.path !== 'string' || !ownPaths.includes(self.path.toLowerCase())
  || !/^\d+$/.test(self.creationTime) || typeof self.commandLine !== 'string' || !self.commandLine.includes('build.mjs')
  || !Number.isInteger(self.handleCount) || self.handleCount <= 0) {
  throw new Error(`进程识别组件没有正确识别当前进程：${probe.stdout}`);
}
if (absent?.pid !== absentPid || !Number.isInteger(absent.error) || 'path' in absent) throw new Error(`进程识别组件没有拒绝不存在的进程：${probe.stdout}`);
if (spawnSync(exe, [], { windowsHide: true }).status !== 2) throw new Error('进程识别组件没有拒绝缺少参数的调用');
await writeFile(stamp, JSON.stringify({ recipe, sha256: createHash('sha256').update(await readFile(exe)).digest('hex') }, null, 2));
