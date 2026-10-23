import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const inputs = {
  plugin: ['beauty.c', 'beauty.effect', 'face.h', 'live.h', 'comparison.h', 'contours.h', 'build.mjs', 'assets.json', 'distribution.mjs'],
  runtime: ['body_instances.py', 'person_instances.py', 'instance_hybrid.py', 'instance-assets.json', 'INSTANCE_LICENSE.txt', 'INSTANCE_NOTICE.txt', 'requirements-instance.txt', 'worker.py', 'owner_watch.py', 'analyzer.py', 'face_proposals.py', 'proposal_views.py', 'directml_proposals.py', 'directml_segmentation.py', 'directml_execution.py', 'face_landmark_region.py', 'face_segmentation.py', 'semantic_frame.py', 'profile_skin.py', 'inference_options.py', 'detect.py', 'body.py', 'body_stabilizer.py', 'landmarks.py', 'stabilizer.py', 'transport.py', 'assets.json', 'YUNET_LICENSE.txt', 'SEMANTIC_LICENSE.txt', 'SEMANTIC_NOTICE.txt', 'requirements.txt', 'requirements.lock.txt', 'requirements-build.txt', 'build-runtime.mjs', 'distribution.mjs']
};
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
// Source inputs are text: the same file checked out with CRLF (Windows autocrlf) or LF has one fingerprint.
const textHash = async path => createHash('sha256').update((await readFile(path, 'utf8')).replaceAll('\r\n', '\n')).digest('hex');

inputs.runtime.push('rtmdet_instances.py', 'rtmdet_postprocess.py', 'derived-models.json',
  'RTMDET_LICENSE.txt', 'RTMDET_NOTICE.txt', 'prepare-derived-models.mjs');

export async function sourceFingerprint(source, kind) {
  if (!inputs[kind]) throw new Error('未知美颜构建类型');
  return Object.fromEntries(await Promise.all(inputs[kind].map(async file => [file, await textHash(join(source, file))])));
}

async function inventory(directory, prefix = '') {
  const entries = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`美颜分发不允许链接：${path}`);
    if (entry.isDirectory()) entries.push(...await inventory(directory, path));
    else if (entry.isFile()) entries.push(path);
    else throw new Error(`美颜分发文件类型无效：${path}`);
  }
  return entries.sort();
}

export async function recordBuild(source, work, kind, startedInputs) {
  const current = await sourceFingerprint(source, kind);
  if (JSON.stringify(current) !== JSON.stringify(startedInputs)) throw new Error('美颜源码在构建期间发生变化，请重新构建');
  const paths = kind === 'plugin' ? ['beauty.effect', 'tblink-beauty.dll'] : await inventory(join(work, 'runtime/tblink-beauty-worker'));
  const base = join(work, kind === 'plugin' ? 'plugin' : 'runtime/tblink-beauty-worker');
  const outputs = Object.fromEntries(await Promise.all(paths.map(async path => [path, await hash(join(base, path))])));
  await writeFile(join(work, `${kind}/build-integrity.json`), JSON.stringify({ version: 1, kind, inputs: current, outputs }, null, 2));
}

export async function verifyBeautyDistribution(source, work, packaged) {
  let files = 0;
  for (const kind of ['plugin', 'runtime']) {
    const record = JSON.parse(await readFile(join(work, `${kind}/build-integrity.json`), 'utf8'));
    const current = await sourceFingerprint(source, kind);
    if (record.version !== 1 || record.kind !== kind || JSON.stringify(record.inputs) !== JSON.stringify(current))
      throw new Error(`美颜 ${kind} 构建已过期，请重新构建`);
    const base = kind === 'plugin' ? 'plugin' : 'runtime/tblink-beauty-worker';
    const expected = kind === 'plugin' ? ['beauty.effect', 'tblink-beauty.dll'] : await inventory(join(work, base));
    if (!record.outputs || JSON.stringify(Object.keys(record.outputs).sort()) !== JSON.stringify(expected.slice().sort()))
      throw new Error(`美颜 ${kind} 文件清单与构建不一致`);
    if (packaged && kind === 'runtime' && JSON.stringify(await inventory(join(packaged, base))) !== JSON.stringify(expected))
      throw new Error('安装包美颜运行时文件清单不完整');
    for (const file of expected) {
      if (!/^[a-f0-9]{64}$/.test(record.outputs[file]) || await hash(join(work, base, file)) !== record.outputs[file])
        throw new Error(`美颜构建文件损坏：${base}/${file}`);
      if (packaged) {
        const path = join(packaged, base, file);
        if (!(await lstat(path)).isFile() || await hash(path) !== record.outputs[file]) throw new Error(`安装包美颜文件不一致：${base}/${file}`);
      }
      files++;
    }
  }
  const assets = JSON.parse(await readFile(join(source, 'assets.json'), 'utf8'));
  const derived = JSON.parse(await readFile(join(source, 'derived-models.json'), 'utf8'));
  const models = ['model', 'bodyLiteModel', 'proposalModel', 'semanticModel'].map(key => assets[key]);
  models.push(derived.personInstances, derived.skinProbability);
  for (const { file, sha256 } of models) {
    if (await hash(join(work, file)) !== sha256 || (packaged && await hash(join(packaged, file)) !== sha256)) throw new Error(`美颜模型校验失败：${file}`);
    files++;
  }
  for (const license of ['YUNET_LICENSE.txt', 'SEMANTIC_LICENSE.txt', 'SEMANTIC_NOTICE.txt', 'RTMDET_LICENSE.txt', 'RTMDET_NOTICE.txt']) {
    if (packaged && await hash(join(packaged, license)) !== await hash(join(source, license))) throw new Error(`安装包美颜模型许可不一致：${license}`);
    files++;
  }
  return { files, verified: true };
}

const fingerprintDigest = fingerprint => createHash('sha256').update(JSON.stringify(Object.entries(fingerprint).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

/** The files a release ships from the beauty build: plugin, frozen worker and the pinned models. */
async function releaseTree(source, root) {
  const assets = JSON.parse(await readFile(join(source, 'assets.json'), 'utf8'));
  const derived = JSON.parse(await readFile(join(source, 'derived-models.json'), 'utf8'));
  const models = [...['model', 'bodyLiteModel', 'proposalModel', 'semanticModel'].map(key => assets[key].file), derived.personInstances.file, derived.skinProbability.file];
  const paths = ['plugin/beauty.effect', 'plugin/tblink-beauty.dll', ...(await inventory(join(root, 'runtime/tblink-beauty-worker'))).map(path => `runtime/tblink-beauty-worker/${path}`), ...models].sort();
  const lines = [];
  let bytes = 0;
  for (const path of paths) {
    const data = await readFile(join(root, path));
    bytes += data.length;
    lines.push(`${path}\0${createHash('sha256').update(data).digest('hex')}\n`);
  }
  return { files: paths.length, bytes, sha256: createHash('sha256').update(lines.join('')).digest('hex') };
}

/** Current sources and the built files, written to release-pin.json after a beauty rebuild. */
export async function releasePin(source, work) {
  return { sources: { plugin: fingerprintDigest(await sourceFingerprint(source, 'plugin')), runtime: fingerprintDigest(await sourceFingerprint(source, 'runtime')) },
    outputs: await releaseTree(source, work) };
}

/** Release packaging trusts the pin in the repository, not the build machine's own records: the sources must be
 * the ones the pinned build was made from, and the build and the packaged copy must be exactly the pinned files. */
export async function verifyBeautyRelease(source, work, packaged) {
  const pin = JSON.parse(await readFile(join(source, 'release-pin.json'), 'utf8'));
  const current = await releasePin(source, work);
  for (const kind of ['plugin', 'runtime']) {
    if (current.sources[kind] !== pin.sources[kind]) throw new Error(`美颜 ${kind} 源码与 release-pin.json 不一致：源码改动后需重新构建并更新发布指纹`);
  }
  if (JSON.stringify(current.outputs) !== JSON.stringify(pin.outputs)) throw new Error(`美颜构建产物与 release-pin.json 不一致：${JSON.stringify(current.outputs)}`);
  if (packaged) {
    const shipped = await releaseTree(source, packaged);
    if (JSON.stringify(shipped) !== JSON.stringify(pin.outputs)) throw new Error(`安装包美颜文件与 release-pin.json 不一致：${JSON.stringify(shipped)}`);
    for (const license of ['YUNET_LICENSE.txt', 'SEMANTIC_LICENSE.txt', 'SEMANTIC_NOTICE.txt', 'RTMDET_LICENSE.txt', 'RTMDET_NOTICE.txt']) {
      if (await textHash(join(packaged, license)) !== await textHash(join(source, license))) throw new Error(`安装包美颜模型许可不一致：${license}`);
    }
  }
  return { files: pin.outputs.files, verified: true };
}
