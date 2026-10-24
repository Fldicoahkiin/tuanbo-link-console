// The offline music-analysis runtime in the official package: Python, its packages, the models and their licenses
// come from a prepared build machine (output/music-analysis), not from git. Its file tree is pinned in
// release-pin.json; files copied from this repository (musicWorkerFiles) are checked by git instead.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pinned = ['runtime', 'models', 'licenses'];
/** The worker modules and notices from tools/music-analysis that sit beside the pinned runtime; the package.json
 * extraResources filter lists the same names. */
export const musicWorkerFiles = ['worker.py', 'analyze.py', 'phrase_structure.py', 'assets.py', 'contracts.py', 'consensus.py', 'evaluate.py',
  'semantic_evaluation.py', 'pyproject.toml', 'uv.lock', 'DISTRIBUTION_NOTICE.md'];

async function files(root, prefix) {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`音乐分析运行时不允许链接：${path}`);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`音乐分析运行时文件类型无效：${path}`);
  }
  return result;
}

export async function musicRuntimeTree(directory) {
  const paths = (await Promise.all(pinned.map(prefix => files(directory, prefix)))).flat().sort();
  const tree = createHash('sha256');
  let bytes = 0;
  for (const path of paths) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, path))) { hash.update(chunk); bytes += chunk.length; }
    tree.update(`${path}\0${hash.digest('hex')}\n`);
  }
  return { files: paths.length, bytes, sha256: tree.digest('hex') };
}

export async function verifyMusicRelease(directory) {
  const pin = JSON.parse(await readFile(join(here, 'release-pin.json'), 'utf8'));
  const tree = await musicRuntimeTree(directory);
  if (JSON.stringify(tree) !== JSON.stringify(pin.outputs)) throw new Error(`音乐分析运行时与 release-pin.json 不一致：${directory} ${JSON.stringify(tree)}`);
  return tree;
}

// node tools/music-analysis/release-pin.mjs <packaged runtime directory> [--write]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, flag] = process.argv.slice(2);
  if (!directory || (flag && flag !== '--write')) throw new Error('用法：node tools/music-analysis/release-pin.mjs <package-runtime.mjs 的输出目录> [--write]');
  const tree = await musicRuntimeTree(resolve(directory));
  if (flag === '--write') {
    const file = join(here, 'release-pin.json');
    const { provenance } = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, `${JSON.stringify({ version: 1, outputs: tree, provenance }, null, 2)}\n`);
  }
  console.log(JSON.stringify(tree));
}
