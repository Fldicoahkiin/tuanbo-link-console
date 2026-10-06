import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint, recordBuild, verifyBeautyDistribution } from './distribution.mjs';

async function fixture() {
  const original = dirname(fileURLToPath(import.meta.url));
  const artifacts = resolve(original, '../../../artifacts/beauty-distribution-tests');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'case-'));
  const source = join(directory, 'source'), work = join(directory, 'work'), packaged = join(directory, 'packaged');
  await mkdir(source);
  for (const entry of await readdir(original, { withFileTypes: true })) if (entry.isFile()) await cp(join(original, entry.name), join(source, entry.name));
  await mkdir(join(work, 'plugin'), { recursive: true });
  await mkdir(join(work, 'runtime/tblink-beauty-worker/_internal'), { recursive: true });
  for (const file of ['plugin/beauty.effect', 'plugin/tblink-beauty.dll', 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe', 'runtime/tblink-beauty-worker/_internal/dependency.dll', 'face.task', 'body.task', 'proposal.onnx', 'semantic.onnx']) await writeFile(join(work, file), file);
  for (const license of ['YUNET_LICENSE.txt', 'SEMANTIC_LICENSE.txt', 'SEMANTIC_NOTICE.txt', 'RTMDET_LICENSE.txt', 'RTMDET_NOTICE.txt']) await cp(join(source, license), join(work, license));
  const assets = {};
  for (const [key, file] of [['model', 'face.task'], ['bodyLiteModel', 'body.task'], ['proposalModel', 'proposal.onnx'], ['semanticModel', 'semantic.onnx']]) assets[key] = { file, sha256: createHash('sha256').update(await readFile(join(work, file))).digest('hex') };
  await writeFile(join(source, 'assets.json'), JSON.stringify(assets));
  const derived = {};
  for (const [key, file] of [['personInstances', 'instance.onnx'], ['skinProbability', 'skin-probability.onnx']]) {
    await writeFile(join(work, file), file);
    derived[key] = { file, sha256: createHash('sha256').update(file).digest('hex') };
  }
  await writeFile(join(source, 'derived-models.json'), JSON.stringify(derived));
  for (const kind of ['plugin', 'runtime']) await recordBuild(source, work, kind, await sourceFingerprint(source, kind));
  await cp(work, packaged, { recursive: true });
  return { source, work, packaged };
}

test('完整分发通过，丢失运行时依赖或被替换的插件被拒绝', async () => {
  const { source, work, packaged } = await fixture();
  assert.deepEqual(await verifyBeautyDistribution(source, work, packaged), { files: 15, verified: true });
  const dependency = join(packaged, 'runtime/tblink-beauty-worker/_internal/dependency.dll');
  await rename(dependency, `${dependency}.missing`);
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /文件清单不完整/);
  await rename(`${dependency}.missing`, dependency);
  await writeFile(join(packaged, 'plugin/tblink-beauty.dll'), 'corrupted');
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /文件不一致/);
});

test('源码变化或模型损坏不能复用原构建', async () => {
  const { source, work } = await fixture();
  const worker = await readFile(join(source, 'worker.py'));
  await writeFile(join(source, 'worker.py'), 'modified');
  await assert.rejects(verifyBeautyDistribution(source, work), /构建已过期/);
  await writeFile(join(source, 'worker.py'), worker);
  await writeFile(join(work, 'face.task'), 'corrupted');
  await assert.rejects(verifyBeautyDistribution(source, work), /模型校验失败/);
});

test('构建中途源码发生变化拒绝生成新指纹', async () => {
  const { source, work } = await fixture();
  const before = await sourceFingerprint(source, 'plugin');
  await writeFile(join(source, 'beauty.c'), 'modified during build');
  await assert.rejects(recordBuild(source, work, 'plugin', before), /构建期间发生变化/);
});

test('GPU 执行与进程监护模块变动也使运行时构建失效', async () => {
  const { source } = await fixture();
  const before = await sourceFingerprint(source, 'runtime');
  for (const file of ['owner_watch.py', 'proposal_views.py', 'directml_execution.py', 'directml_proposals.py', 'directml_segmentation.py', 'body_instances.py', 'person_instances.py', 'instance_hybrid.py', 'rtmdet_instances.py', 'rtmdet_postprocess.py', 'derived-models.json']) {
    assert.match(before[file], /^[a-f0-9]{64}$/);
    const original = await readFile(join(source, file));
    await writeFile(join(source, file), 'modified');
    const current = await sourceFingerprint(source, 'runtime');
    assert.notEqual(current[file], before[file]);
    await writeFile(join(source, file), original);
  }
});

test('安装包缺失补检模型或替换许可文本时拒绝分发', async () => {
  const { source, work, packaged } = await fixture();
  const proposal = join(packaged, 'proposal.onnx');
  await rename(proposal, `${proposal}.missing`);
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /ENOENT/);
  await rename(`${proposal}.missing`, proposal);
  await writeFile(join(packaged, 'YUNET_LICENSE.txt'), 'incorrect license');
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /许可不一致/);
});

test('分割模型损坏或缺少转换声明时拒绝分发', async () => {
  const { source, work, packaged } = await fixture();
  const model = join(packaged, 'semantic.onnx');
  await writeFile(model, 'corrupted');
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /模型校验失败/);
  await cp(join(work, 'semantic.onnx'), model);
  await rename(join(packaged, 'SEMANTIC_NOTICE.txt'), join(packaged, 'SEMANTIC_NOTICE.txt.missing'));
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /ENOENT/);
});

test('新实例模型或GPU皮肤概率模型损坏均拒绝分发', async () => {
  const { source, work, packaged } = await fixture();
  for (const file of ['instance.onnx', 'skin-probability.onnx']) {
    await writeFile(join(packaged, file), 'corrupted');
    await assert.rejects(verifyBeautyDistribution(source, work, packaged), /模型校验失败/);
    await cp(join(work, file), join(packaged, file));
  }
  await writeFile(join(packaged, 'RTMDET_NOTICE.txt'), 'incorrect attribution');
  await assert.rejects(verifyBeautyDistribution(source, work, packaged), /许可不一致/);
});
