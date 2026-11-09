import { it, expect, vi } from 'vitest';
import { WaveformCache } from './waveform-cache';

const source = { projectPath: 'C:/show.tblink', sha256: 'hash', durationMs: 1000, url: 'tblink://audio/source' };
it('播放器和编辑器共享在途请求；切页后复用原精度峰值', async () => {
  const peaks = [0, 1, 0.1], generate = vi.fn(() => Promise.resolve(peaks)), cache = new WaveformCache(generate);
  const player = cache.acquire(source), editor = cache.acquire(source);
  expect(await player.result).toBe(peaks); expect(await editor.result).toBe(peaks);
  player.release(); editor.release();
  const reopened = cache.acquire({ ...source, url: 'tblink://audio/renewed-url' });
  expect(await reopened.result).toBe(peaks); reopened.release();
  expect(generate).toHaveBeenCalledTimes(1);
});
it('淘汰未使用的超预算样本，不淘汰当前音源；工程和内容哈希隔离', async () => {
  const generate = vi.fn(() => Promise.resolve([0.1, 0.9])), cache = new WaveformCache(generate, 16, 1);
  const active = cache.acquire(source); await active.result;
  const other = cache.acquire({ ...source, projectPath: 'C:/other.tblink' }); await other.result; other.release();
  const same = cache.acquire(source); await same.result; expect(generate).toHaveBeenCalledTimes(2);
  same.release(); active.release();
  const different = cache.acquire({ ...source, sha256: 'changed' }); await different.result; different.release();
  const original = cache.acquire(source); await original.result; original.release();
  expect(generate).toHaveBeenCalledTimes(4);
});
it('失败明确返回，不因多个挂载自动重试', async () => {
  const generate = vi.fn((): Promise<number[]> => Promise.reject(new Error('缓存损坏')));
  const cache = new WaveformCache(generate), first = cache.acquire(source);
  await expect(first.result).rejects.toThrow('缓存损坏'); first.release();
  const again = cache.acquire(source); await expect(again.result).rejects.toThrow('缓存损坏'); again.release();
  expect(generate).toHaveBeenCalledTimes(1);
});
it('链接失效失败后，重新打开拿到新链接时再读一次；同一个旧链接不重试', async () => {
  const generate = vi.fn((value: typeof source): Promise<number[]> => value.url === source.url ? Promise.reject(new Error('波形素材链接已失效')) : Promise.resolve([0.5]));
  const cache = new WaveformCache(generate), stale = cache.acquire(source);
  await expect(stale.result).rejects.toThrow('链接已失效'); stale.release();
  const same = cache.acquire(source); await expect(same.result).rejects.toThrow('链接已失效'); same.release();
  expect(generate).toHaveBeenCalledTimes(1);
  const renewed = cache.acquire({ ...source, url: 'tblink://audio/renewed-url' });
  expect(await renewed.result).toEqual([0.5]); renewed.release();
  const later = cache.acquire({ ...source, url: 'tblink://audio/another-url' }); expect(await later.result).toEqual([0.5]); later.release();
  expect(generate).toHaveBeenCalledTimes(2);
});
