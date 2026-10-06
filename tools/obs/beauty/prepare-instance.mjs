import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(source,'instance-assets.json'),'utf8'));
const output = resolve(source,'../../../artifacts/beauty-prototype/person-instance');
await mkdir(output,{ recursive:true });
for (const asset of manifest.files) {
  assert(['model.xml','model.bin'].includes(asset.file), 'Unexpected instance asset');
  const path = join(output,asset.file);
  let data;
  try { data = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(asset.url,{ signal:AbortSignal.timeout(120000) });
    assert(response.ok, `Instance asset request failed: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    assert(data.length > 0 && data.length < 40_000_000,'Unexpected instance asset size');
    for (const algorithm of ['sha256','sha384']) assert.equal(createHash(algorithm).update(data).digest('hex'),asset[algorithm],`${asset.file} ${algorithm} mismatch`);
    await writeFile(path,data,{ flag:'wx' });
  }
  for (const algorithm of ['sha256','sha384']) assert.equal(createHash(algorithm).update(data).digest('hex'),asset[algorithm],`${asset.file} ${algorithm} mismatch`);
  console.log(`Verified ${asset.file}: ${data.length} bytes`);
}
