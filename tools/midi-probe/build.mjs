import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'bin');
const exe = join(bin, 'tblink-midi-probe.exe');
const stamp = join(bin, 'build.json');
const recipe = createHash('sha256').update(await readFile(join(here, 'probe.c'))).update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
if (process.platform !== 'win32') throw new Error('MIDI 检测组件必须在 Windows 构建');
if (existsSync(exe) && existsSync(stamp)) {
  const previous = JSON.parse(await readFile(stamp, 'utf8'));
  if (previous.recipe === recipe && previous.sha256 === createHash('sha256').update(await readFile(exe)).digest('hex')) process.exit(0);
}
const compiler = join(here, '../obs/native-preview/compiler/zig-x86_64-windows-0.14.1/zig.exe');
if (!existsSync(compiler)) throw new Error('请先构建 OBS 原生组件以准备项目固定版本的编译器');
await mkdir(bin, { recursive: true });
const result = spawnSync(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', join(here, 'probe.c'), '-lwinmm', '-o', exe], { windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('MIDI 检测组件构建失败');
await writeFile(stamp, JSON.stringify({ recipe, sha256: createHash('sha256').update(await readFile(exe)).digest('hex') }, null, 2));
