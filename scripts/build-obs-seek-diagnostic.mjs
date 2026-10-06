import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// DIAGNOSTIC ONLY. Builds the official media source, without OBS encoders or
// outputs, for a disposable portable OBS. Never install this in the user's OBS.
const [sourcePath, depsPath, destination, mode] = process.argv.slice(2);
assert(sourcePath && depsPath && destination && ['baseline', 'eof', 'accurate'].includes(mode),
  'Usage: node scripts/build-obs-seek-diagnostic.mjs <OBS 32.2.2 source> <matching deps> <new output> baseline|eof|accurate');
const source = resolve(sourcePath), deps = resolve(depsPath), output = resolve(destination);
const zig = resolve('tools/obs/native-preview/compiler/zig-x86_64-windows-0.14.1/zig.exe');
const run = (args) => promisify(execFile)(zig, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output); // Fixed test binaries must not be overwritten.
const module = '#include <obs-module.h>\nOBS_DECLARE_MODULE()\nOBS_MODULE_USE_DEFAULT_LOCALE("obs-ffmpeg", "en-US")\nextern struct obs_source_info ffmpeg_source;\nbool obs_module_load(void) { ffmpeg_source.id = "tblink_seek_diagnostic"; obs_register_source(&ffmpeg_source); return true; }\n';
await writeFile(join(output, 'module.c'), module);
await writeFile(join(output, 'obsconfig.h'), '#pragma once\n#define OBS_DATA_PATH "data"\n#define OBS_PLUGIN_PATH "obs-plugins"\n#define OBS_INSTALL_PREFIX ""\n#define OBS_RELEASE_CANDIDATE 0\n#define OBS_BETA 0\n');
// The official Windows headers name MSVC intrinsics. This diagnostic compiler
// uses Clang's atomic operations with the same (or stronger) ordering.
await writeFile(join(output, 'compiler-atomics.h'), '#pragma once\n#define __iso_volatile_load32(ptr) __atomic_load_n((ptr), __ATOMIC_RELAXED)\n#define __iso_volatile_load8(ptr) __atomic_load_n((ptr), __ATOMIC_RELAXED)\n#define _InterlockedExchange8(ptr, val) __atomic_exchange_n((ptr), (val), __ATOMIC_SEQ_CST)\n');
const original = await readFile(join(source, 'shared/media-playback/media-playback/media.c'), 'utf8');
let media = original;
if (mode !== 'baseline') {
  const branch = '\t\t\t\tif (!actively_seeking) {\n\t\t\t\t\tm->eof = true;\n\t\t\t\t} else {\n\t\t\t\t\tbreak;\n\t\t\t\t}';
  assert(media.includes(branch), 'Unexpected official EOF implementation');
  media = media.replace('\tbool actively_seeking = m->seek_next_ts && m->pause;\n', '')
    .replace(branch, '\t\t\t\tm->eof = true;')
    .replace('static void seek_to(mp_media_t *m, int64_t pos)\n{',
      'static void seek_to(mp_media_t *m, int64_t pos)\n{\n\tm->eof = false;');
}
if (mode === 'accurate') {
  const block = '\tif (m->has_video && m->is_local_file) {\n\t\tmp_decode_flush(&m->v);\n\t\tif (m->seek_next_ts && m->pause && m->v_preload_cb && mp_media_prepare_frames(m))\n\t\t\tmp_media_next_video(m, true);\n\t}\n\tif (m->has_audio && m->is_local_file)\n\t\tmp_decode_flush(&m->a);';
  assert(media.includes(block), 'Unexpected official seek implementation');
  media = media.replace(block, `\tif (m->has_video && m->is_local_file) mp_decode_flush(&m->v);
\tif (m->has_audio && m->is_local_file) mp_decode_flush(&m->a);
\tif (m->is_local_file && m->seek_next_ts && m->pause) {
\t\tint64_t target = av_rescale(pos, 100000, m->speed);
\t\tfor (;;) {
\t\t\tpthread_mutex_lock(&m->mutex);
\t\t\tbool cancelled = m->kill || m->reset || m->seek;
\t\t\tpthread_mutex_unlock(&m->mutex);
\t\t\tif (cancelled || !mp_media_prepare_frames(m)) break;
\t\t\tbool advance = false;
\t\t\t/* Millisecond requests round a rational frame position. Select
\t\t\t * the nearest decoded video frame, not a preceding GOP keyframe. */
\t\t\tif (m->has_video && m->v.frame_ready && m->v.next_pts - m->v.last_duration / 2 <= target) {
\t\t\t\tm->v.frame_ready = false; advance = true;
\t\t\t}
\t\t\tif (m->has_audio && m->a.frame_ready && m->a.next_pts <= target) {
\t\t\t\tm->a.frame_ready = false; advance = true;
\t\t\t}
\t\t\tif (!advance) {
\t\t\t\tif (m->has_video && m->v_preload_cb) mp_media_next_video(m, true);
\t\t\t\tbreak;
\t\t\t}
\t\t}
\t}`);
}
await writeFile(join(output, 'media.c'), media);

// Build import libraries from the exact installed DLL export names. No code
// injection, memory offsets or private libobs structures are used at runtime.
async function importLibrary(name) {
  const dll = join('C:/Program Files/obs-studio/bin/64bit', name), bytes = await readFile(dll);
  const pe = bytes.readUInt32LE(0x3c), count = bytes.readUInt16LE(pe + 6);
  const optional = pe + 24, size = bytes.readUInt16LE(pe + 20);
  assert.equal(bytes.readUInt16LE(optional), 0x20b);
  const sections = Array.from({ length: count }, (_, i) => {
    const at = optional + size + i * 40;
    return { va: bytes.readUInt32LE(at + 12), size: Math.max(bytes.readUInt32LE(at + 8), bytes.readUInt32LE(at + 16)), offset: bytes.readUInt32LE(at + 20) };
  });
  const offset = rva => { const section = sections.find(s => rva >= s.va && rva < s.va + s.size); assert(section, 'RVA outside PE sections'); return section.offset + rva - section.va; };
  const table = offset(bytes.readUInt32LE(optional + 112));
  const namesAt = offset(bytes.readUInt32LE(table + 32)), names = [];
  for (let i = 0; i < bytes.readUInt32LE(table + 24); i++) {
    const at = offset(bytes.readUInt32LE(namesAt + i * 4));
    names.push(bytes.toString('ascii', at, bytes.indexOf(0, at)));
  }
  const definition = join(output, `${name}.def`), library = join(output, `${name}.lib`);
  await writeFile(definition, `LIBRARY ${basename(name)}\nEXPORTS\n${names.join('\n')}\n`);
  await run(['dlltool', '-m', 'i386:x86-64', '-d', definition, '-l', library]);
  return { library, name, sha256: hash(bytes) };
}
const imports = await Promise.all(['obs.dll', 'w32-pthreads.dll'].map(importLibrary));
const include = [output, join(source, 'libobs'), join(source, 'deps/w32-pthreads'),
  join(source, 'shared/media-playback'), join(source, 'shared/media-playback/media-playback'), join(deps, 'include')];
const sources = ['decode.c', 'cache.c', 'media-playback.c'].map(file => join(source, 'shared/media-playback/media-playback', file));
const binary = join(output, 'tblink-seek-diagnostic.dll');
const args = ['cc', '-target', 'x86_64-windows-gnu', '-shared', '-O2', '-DPTW32_STATIC_LIB',
  '-include', join(output, 'compiler-atomics.h'),
  ...include.flatMap(path => ['-I', path]), join(output, 'module.c'), join(output, 'media.c'), ...sources,
  join(source, 'plugins/obs-ffmpeg/obs-ffmpeg-source.c'), ...imports.map(value => value.library),
  ...['avcodec', 'avformat', 'avutil', 'avdevice', 'swscale'].map(name => join(deps, 'lib', `${name}.lib`)), '-o', binary];
const result = await run(args).catch(async error => {
  await writeFile(join(output, 'compile-error.txt'), String(error.stderr || error));
  throw new Error(`Diagnostic compilation failed; details: ${join(output, 'compile-error.txt')}`);
});
if (result.stderr) process.stderr.write(result.stderr);
await writeFile(join(output, 'manifest.json'), JSON.stringify({ diagnosticOnly: true, version: '32.2.2', mode,
  scope: 'Separate diagnostic media source. Official OBS sources/encoders/outputs remain installed. Disposable OBS only.',
  originalMediaSha256: hash(original), changedMediaSha256: hash(media), imports,
  sha256: hash(await readFile(binary)), args }, null, 2));
console.log(binary);
