import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceFingerprint, recordBuild } from './distribution.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const startedInputs = await sourceFingerprint(root, 'plugin');
const work = resolve(root, '../../../artifacts/beauty-prototype');
const archive = join(work, 'obs-source.zip');
const { sdk: { sha256: digest } } = JSON.parse(await readFile(join(root, 'assets.json'), 'utf8'));
const compiler = resolve(root, '../native-preview/compiler/zig-x86_64-windows-0.14.1/zig.exe');
const sdk = join(work, 'sdk/obs-studio-32.0.4/libobs');
const output = join(work, 'plugin');
function run(args) {
  const result = spawnSync(compiler, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Beauty build failed (${result.status})`);
}
if (process.platform !== 'win32') throw new Error('Native Windows required');
await access(compiler);
await access(join(sdk, 'obs-module.h'));
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== digest) throw new Error('OBS SDK archive SHA-256 mismatch');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'obsconfig.h'), '#pragma once\n#define OBS_INSTALL_PREFIX ""\n#define OBS_DATA_PATH "data"\n');
// Import library from the small, explicit set of official libobs APIs used here.
const source = (await Promise.all(['beauty.c', 'live.h', 'comparison.h'].map(file => readFile(join(root, file), 'utf8')))).join('\n');
const imports = [...new Set(source.match(/\b(?:obs_[a-z_]+|gs_[a-z0-9_]+|bfree|bzalloc|blog)\s*(?=\()/g))]
  .map(name => name.trim()).filter(name => !['obs_module_load', 'obs_module_name', 'obs_module_description', 'obs_current_module'].includes(name))
  .filter(name => !['obs_register_source', 'obs_module_file'].includes(name));
imports.push('obs_register_source_s', 'obs_find_module_file', 'bmalloc');
await writeFile(join(output, 'obs.def'), `LIBRARY obs.dll\nEXPORTS\n${imports.join('\n')}\n`);
run(['dlltool', '-m', 'i386:x86-64', '-d', join(output, 'obs.def'), '-l', join(output, 'obs.lib')]);
run(['cc', '-target', 'x86_64-windows-gnu', '-shared', '-O2', '-Wall', '-Wextra', '-Werror', '-I', sdk, '-I', output,
  join(root, 'beauty.c'), join(output, 'obs.lib'), '-ladvapi32', '-o', join(output, 'tblink-beauty.dll')]);
await cp(join(root, 'beauty.effect'), join(output, 'beauty.effect'));
run(['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Werror', join(root, 'transport-test.c'), '-ladvapi32', '-o', join(output, 'transport-test.exe')]);
const tested = spawnSync(join(output, 'transport-test.exe'), [], { stdio: 'inherit', windowsHide: true });
if (tested.error) throw tested.error;
if (tested.status !== 0) throw new Error(`Transport tests failed (${tested.status})`);
await recordBuild(root, work, 'plugin', startedInputs);
console.log(`Built ${join(output, 'tblink-beauty.dll')}`);
