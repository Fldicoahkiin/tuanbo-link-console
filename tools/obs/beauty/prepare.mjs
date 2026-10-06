import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const work = resolve(root, '../../../artifacts/beauty-prototype');
if (process.platform !== 'win32') throw new Error('Native Windows required');
const manifest = JSON.parse(await readFile(join(root, 'assets.json'), 'utf8'));
await mkdir(work, { recursive: true });
for (const asset of Object.values(manifest)) {
  const destination = join(work, asset.file);
  let bytes;
  try { bytes = await readFile(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes && createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Existing asset checksum mismatch: ${destination}. Inspect the file before replacing it.`);
  }
  if (!bytes) {
    console.log(`Downloading ${asset.url}`);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${asset.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Downloaded asset checksum mismatch: ${asset.file}`);
    await writeFile(destination, bytes);
  }
}
await mkdir(join(work, 'sdk'), { recursive: true });
const extraction = spawnSync('tar.exe', ['-xf', join(work, manifest.sdk.file), '-C', join(work, 'sdk')], { stdio: 'inherit', windowsHide: true });
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) throw new Error(`SDK extraction failed (${extraction.status})`);
console.log('Development assets verified. Nothing installed into user OBS.');
