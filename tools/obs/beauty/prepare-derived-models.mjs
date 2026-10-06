import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const work = resolve(source, '../../../artifacts/beauty-prototype');
const manifest = JSON.parse(await readFile(join(source, 'derived-models.json'), 'utf8'));
const supplied = process.argv.slice(2);
if (supplied.length !== 2) throw new Error('Usage: node prepare-derived-models.mjs <raw-heads.onnx> <skin-probability.onnx>');
const models = [manifest.personInstances, manifest.skinProbability];
const verified = await Promise.all(models.map(async (model, index) => {
  const bytes = await readFile(resolve(supplied[index]));
  if (createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error(`Derived model checksum mismatch: ${model.file}`);
  const target = join(work, model.file);
  try {
    if (!(await lstat(target)).isFile()) throw new Error(`Derived model target is not a regular file: ${target}`);
    const existing = await readFile(target);
    if (createHash('sha256').update(existing).digest('hex') !== model.sha256) throw new Error(`Existing derived model differs: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { bytes, target };
}));
for (const { bytes, target } of verified) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
console.log('Verified derived models staged; no application or OBS configuration changed.');
