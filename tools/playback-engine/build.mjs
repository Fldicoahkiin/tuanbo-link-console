import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'win32') throw new Error('正式播放引擎必须在 Windows 构建');
const files = ['engine.h', 'engine.c', 'audio.c', 'midi.c', 'midi-output.c', 'midi-input.c', 'devices.c', 'signal.h', 'signal.c', 'signal-test.c', 'probe.c', 'build.mjs'];
const hash = createHash('sha256');
for (const file of files) hash.update(await readFile(join(here, file)));
const recipe = hash.digest('hex');
const bin = process.env.TBLINK_PLAYBACK_BUILD_DIR ? resolve(process.env.TBLINK_PLAYBACK_BUILD_DIR) : join(here, 'bin');
const artifacts = resolve(here, '../../artifacts');
if (bin !== join(here, 'bin') && !bin.startsWith(artifacts + sep)) throw new Error('独立播放引擎构建必须位于本工作区 artifacts 中');
const exe = join(bin, 'tblink-playback.exe'), stamp = join(bin, 'build.json');
if (existsSync(exe) && existsSync(stamp)) {
  const previous = JSON.parse(await readFile(stamp, 'utf8'));
  if (previous.recipe === recipe && previous.sha256 === createHash('sha256').update(await readFile(exe)).digest('hex')) process.exit(0);
}
const compiler = join(here, '../obs/native-preview/compiler/zig-x86_64-windows-0.14.1/zig.exe');
if (!existsSync(compiler)) throw new Error('缺少仓库固定的 Windows 编译器，请先构建 OBS 原生组件');
await mkdir(bin, { recursive: true });
const result = spawnSync(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Werror', ...['engine.c', 'audio.c', 'midi.c', 'midi-output.c', 'midi-input.c', 'devices.c', 'signal.c'].map(file => join(here, file)), '-lole32', '-luuid', '-lwinmm', '-lavrt', '-luser32', '-o', exe], { windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('正式播放引擎编译失败');
const probe = spawnSync(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Werror', join(here, 'probe.c'), '-lwinmm', '-o', join(bin, 'tblink-playback-probe.exe')], { windowsHide: true, stdio: 'inherit' });
if (probe.error) throw probe.error;
if (probe.status !== 0) throw new Error('原生 MIDI 验收接收器编译失败');
const signalTest = join(bin, 'tblink-signal-test.exe');
const signalBuild = spawnSync(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Werror', join(here, 'signal.c'), join(here, 'signal-test.c'), '-o', signalTest], { windowsHide: true, stdio: 'inherit' });
if (signalBuild.error) throw signalBuild.error;
if (signalBuild.status !== 0) throw new Error('音频信号验收组件编译失败');
const verified = spawnSync(signalTest, [], { windowsHide: true, stdio: 'inherit' });
if (verified.error) throw verified.error;
if (verified.status !== 0) throw new Error('原生采样音量或频谱计算未通过');
await writeFile(stamp, JSON.stringify({ protocol: 4, recipe, sha256: createHash('sha256').update(await readFile(exe)).digest('hex') }, null, 2));
