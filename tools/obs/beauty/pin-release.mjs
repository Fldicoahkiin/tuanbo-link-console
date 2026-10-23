// After rebuilding beauty (build.mjs / build-runtime.mjs), record the sources and built files that releases
// may ship. Keeps the hand-written provenance in release-pin.json; update it to say how this build was made.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePin } from './distribution.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const work = resolve(source, '../../../artifacts/beauty-prototype');
const file = join(source, 'release-pin.json');
const { provenance } = JSON.parse(await readFile(file, 'utf8'));
await writeFile(file, `${JSON.stringify({ version: 1, ...await releasePin(source, work), provenance }, null, 2)}\n`);
console.log(`已更新 ${file}；请同时更新其中的 provenance 说明本次构建来源`);
