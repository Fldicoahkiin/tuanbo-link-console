import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const { build } = require('esbuild');
const work = join(root, 'artifacts/beauty-prototype');
await mkdir(work, { recursive: true });
const directory = await mkdtemp(join(work, 'install-acceptance-'));
const modulePath = join(directory, 'installer.mjs');
await build({ entryPoints: [join(root, 'apps/desktop/src/main/link/beauty-plugin-install.ts')], outfile: modulePath,
  bundle: true, platform: 'node', format: 'esm', target: 'node22' });
const { installBeautyPlugin } = await import(pathToFileURL(modulePath).href);
const programData = join(directory, 'program-data');
const first = await installBeautyPlugin(work, programData);
assert(first.includes('已安装'));
const hashes = {};
for (const [source, target] of [['plugin/beauty.effect', 'data/beauty.effect'], ['plugin/tblink-beauty.dll', 'bin/64bit/tblink-beauty.dll']]) {
  const expected = await readFile(join(work, source));
  const installed = await readFile(join(programData, 'obs-studio/plugins/tblink-beauty', target));
  assert.deepEqual(installed, expected);
  hashes[target] = createHash('sha256').update(installed).digest('hex');
}
const second = await installBeautyPlugin(work, programData);
assert.equal(second, '美颜组件已就绪');
assert.deepEqual(await readdir(join(programData, 'obs-studio/plugins')), ['tblink-beauty']);
const transaction = join(programData, 'obs-studio/tblink-beauty-installations', randomUUID());
await mkdir(join(transaction, 'staged'), { recursive: true });
await writeFile(join(transaction, 'pending'), 'tblink-beauty-installation-1\n');
const target = join(programData, 'obs-studio/plugins/tblink-beauty');
await rename(target, join(transaction, 'previous'));
const recovery = await installBeautyPlugin(work, programData);
assert(recovery.includes('上次中断'));
for (const [file, hash] of Object.entries(hashes)) assert.equal(createHash('sha256').update(await readFile(join(target, file))).digest('hex'), hash);
assert.equal(await installBeautyPlugin(work, programData), '美颜组件已就绪');
const result = { passed: true, directory, hashes, first, second, recovery,
  interruptedDirectoryRecovery: true,
  scope: 'Real built resources installed into isolated ProgramData; no system OBS configuration changed. Does not prove installed OBS load or packaged distribution.' };
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
