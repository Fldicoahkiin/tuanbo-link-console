import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
if (process.argv.length !== 6) throw new Error('参数：安装后的 EXE、真实音源、时长毫秒、新证据目录');
const executable = resolve(process.argv[2]), audio = resolve(process.argv[3]);
const durationMs = Number(process.argv[4]), directory = resolve(process.argv[5]);
assert.ok(Number.isFinite(durationMs) && durationMs > 0);
await mkdir(directory);
const resources = join(dirname(executable), 'resources/music-analysis');
const manifest = JSON.parse(await readFile(join(resources, 'runtime-manifest.json'), 'utf8'));
for (const file of manifest.files) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(join(resources, file.path))) { hash.update(chunk); bytes += chunk.length; }
  assert.equal(hash.digest('hex'), file.sha256, file.path);
  assert.equal(bytes, file.bytes, file.path);
}
await copyFile(audio, join(directory, '验收音乐.wav'));
const sha256 = createHash('sha256').update(await readFile(join(directory, '验收音乐.wav'))).digest('hex');
const source = { assetId: 'music', relativePath: '验收音乐.wav', sha256, durationMs };
const projectPath = join(directory, '安装版音乐验收.tblink');
const app = await launchPackagedDesktop({ executable, directory, chromium });
const reports = [];
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible({ timeout: 20000 });
  const state = await page.evaluate(() => globalThis.window.tbLink.getAutomaticMusicStatus());
  assert.equal(state.available, true); assert.deepEqual(state.devices, ['cpu']);
  const project = await page.evaluate(() => globalThis.window.tbLink.createProject('安装版音乐验收'));
  project.rundown.push({ id: 'song', title: '安装版实际音源', referenceAudio: source });
  await writeFile(projectPath, JSON.stringify(project));
  for (const kind of ['first', 'cached']) {
    const taskId = randomUUID(), started = performance.now();
    await page.evaluate(request => globalThis.window.tbLink.startAutomaticMusicAnalysis(request), { version: 1, taskId, projectPath, source, device: 'cpu' });
    await expect.poll(async () => {
      const status = await page.evaluate(() => globalThis.window.tbLink.getAutomaticMusicStatus());
      const job = status.jobs.find(item => item.taskId === taskId);
      if (job?.state === 'failed') throw new Error(job.message);
      return job?.state;
    }, { timeout: 250000, intervals: [1000, 2000] }).toBe('completed');
    const job = await page.evaluate(async id => (await globalThis.window.tbLink.getAutomaticMusicStatus()).jobs.find(item => item.taskId === id), taskId);
    assert.ok(job.candidates.items.some(item => item.kind === 'beat'));
    assert.ok(job.candidates.items.some(item => item.kind === 'section'));
    assert.equal(job.summary.cached, kind === 'cached');
    reports.push({ kind, elapsedSeconds: (performance.now() - started) / 1000, job });
    console.log(`${kind}: 完成，${reports.at(-1).elapsedSeconds.toFixed(2)} 秒`);
  }
  await page.screenshot({ path: join(directory, 'installed-workspace.png') });
} finally { await app.close(); }
await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ executable, checkedAt: new Date().toISOString(), verifiedFiles: manifest.files.length, source, reports }, null, 2));
console.log('安装版真实 IPC → 随包 Python → 全部本地模型 → 结果及缓存检查通过');
