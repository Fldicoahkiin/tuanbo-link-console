import { mkdtemp, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReferenceAudioCache } from './reference-audio-cache';
import { hashFile } from './link-project-service';

const owned: string[] = [];
async function clean(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await clean(child); else await unlink(child);
  }
  await rmdir(path);
}
afterEach(async () => { for (const path of owned.splice(0)) await clean(path); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-audio-reuse-')); owned.push(directory);
  const source = join(directory, 'source.mp4'), project = join(directory, 'show.tblink');
  await writeFile(source, 'source'); await mkdir(join(directory, 'assets'));
  const extract = vi.fn(async () => {
    const path = join(directory, 'assets', 'audio.wav'); await writeFile(path, await readFile(source));
    return { assetId: 'original', relativePath: 'assets/audio.wav', sha256: await hashFile(path), durationMs: 40000 };
  });
  return { directory, project, source, extract, cache: new ReferenceAudioCache(hashFile) };
}
it('同一素材并发只提取一次，重开服务仍复用，并返回独立音轨身份', async () => {
  const f = await fixture();
  const results = await Promise.all([f.cache.ensure(f.project, f.source, f.extract), f.cache.ensure(f.project, f.source, f.extract)]);
  const reopened = await new ReferenceAudioCache(hashFile).ensure(f.project, f.source, f.extract);
  expect(f.extract).toHaveBeenCalledTimes(1);
  expect(results[0].relativePath).toBe(reopened.relativePath);
  expect(new Set([...results, reopened].map(entry => entry.assetId)).size).toBe(3);
});
it('被替换的原片重新提取，损坏音轨不能复用或静默重建', async () => {
  const f = await fixture(); await f.cache.ensure(f.project, f.source, f.extract);
  await writeFile(f.source, 'changed-source');
  const updated = await f.cache.ensure(f.project, f.source, f.extract);
  expect(f.extract).toHaveBeenCalledTimes(2);
  await writeFile(join(f.directory, updated.relativePath), 'tampered');
  await expect(f.cache.ensure(f.project, f.source, f.extract)).rejects.toThrow('原声音轨文件已改变');
  expect(f.extract).toHaveBeenCalledTimes(2);
});
it('提取途中原片变化不会发布可复用结果，失败仅在用户再次调用时重新执行', async () => {
  const f = await fixture();
  const extract = vi.fn(async () => { const result = await f.extract(); await writeFile(f.source, 'replaced'); return result; });
  await expect(f.cache.ensure(f.project, f.source, extract)).rejects.toThrow('原素材在音轨准备期间发生变化');
  await expect(readFile(join(f.directory, 'cache', 'reference-audio', `${await hashFile(f.source)}.json`))).rejects.toThrow();
  await f.cache.ensure(f.project, f.source, f.extract);
  expect(extract).toHaveBeenCalledTimes(1);
});

it('确认无音轨的视频也可复用检测结果，其他提取错误不会伪装成无音轨', async () => {
  const f = await fixture();
  const silent = vi.fn<() => ReturnType<typeof f.extract>>().mockRejectedValue(new Error('素材不包含音频轨道'));
  await expect(f.cache.ensure(f.project, f.source, silent)).rejects.toThrow('素材不包含音频轨道');
  await expect(new ReferenceAudioCache(hashFile).ensure(f.project, f.source, silent)).rejects.toThrow('素材不包含音频轨道');
  expect(silent).toHaveBeenCalledTimes(1);
  await writeFile(f.source, 'broken');
  const broken = vi.fn<() => ReturnType<typeof f.extract>>().mockRejectedValue(new Error('解码器读取失败'));
  await expect(f.cache.ensure(f.project, f.source, broken)).rejects.toThrow('解码器读取失败');
  await expect(f.cache.ensure(f.project, f.source, broken)).rejects.toThrow('解码器读取失败');
  expect(broken).toHaveBeenCalledTimes(2);
});
