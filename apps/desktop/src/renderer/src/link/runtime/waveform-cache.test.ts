import { it, expect, vi } from 'vitest';
import type { LinkWaveform, LinkWaveformResult } from '@tb/schema';
import { WaveformCache } from './waveform-cache';

const source = { projectPath: 'C:/show.tblink', sha256: 'hash', durationMs: 1000, url: 'tblink://audio/source' };
/** A one-level waveform whose buckets are `peaks`; the cache only passes it on and weighs it. */
const song = (peaks: number[]): LinkWaveform => ({ sampleRate: 48_000, sampleCount: peaks.length * 96, spectrum: null,
  levels: [{ samplesPerBucket: 96, wave: Int16Array.from(peaks.flatMap(peak => [-peak * 32767, peak * 32767])), rhythm: null }] });
const top = (result: LinkWaveformResult): number => Math.max(...result.waveform.levels[0]!.wave) / 32767;
const verified = (peaks: number[] | LinkWaveform): Promise<LinkWaveformResult> => Promise.resolve({ state: 'verified', waveform: Array.isArray(peaks) ? song(peaks) : peaks });
it('播放器和编辑器共享在途请求；切页后复用原精度峰值', async () => {
  const peaks = song([0, 1, 0.1]), generate = vi.fn(() => verified(peaks)), cache = new WaveformCache(generate);
  const player = cache.acquire(source), editor = cache.acquire(source);
  expect((await player.result).waveform).toBe(peaks); expect((await editor.result).waveform).toBe(peaks);
  expect((await player.settled()).waveform).toBe(peaks);
  player.release(); editor.release();
  const reopened = cache.acquire({ ...source, url: 'tblink://audio/renewed-url' });
  expect((await reopened.result).waveform).toBe(peaks); reopened.release();
  expect(generate).toHaveBeenCalledExactlyOnceWith({ ...source, rebuild: false });
});
it('没核对过的旧波形先给出，再只重建一次；各页面共用重建结果', async () => {
  const generate = vi.fn((request: typeof source & { rebuild: boolean }): Promise<LinkWaveformResult> =>
    Promise.resolve(request.rebuild ? { state: 'verified', waveform: song([0.9]) } : { state: 'unverified', waveform: song([0.1]) }));
  const cache = new WaveformCache(generate);
  const player = cache.acquire(source), editor = cache.acquire(source);
  const result = await player.result; expect([result.state, top(result)]).toEqual(['unverified', expect.closeTo(0.1, 3)]);
  const settled = await player.settled(); expect([settled.state, top(settled)]).toEqual(['verified', expect.closeTo(0.9, 3)]);
  expect(await editor.settled()).toBe(settled);
  expect(generate.mock.calls.map(([request]) => request.rebuild)).toEqual([false, true]);
  player.release(); editor.release();
});
it('淘汰未使用的超预算样本，不淘汰当前音源；工程和内容哈希隔离', async () => {
  const generate = vi.fn(() => verified([0.1, 0.9])), cache = new WaveformCache(generate, 4, 1);
  const active = cache.acquire(source); await active.result;
  const other = cache.acquire({ ...source, projectPath: 'C:/other.tblink' }); await other.result; other.release();
  const same = cache.acquire(source); await same.result; expect(generate).toHaveBeenCalledTimes(2);
  same.release(); active.release();
  const different = cache.acquire({ ...source, sha256: 'changed' }); await different.result; different.release();
  const original = cache.acquire(source); await original.result; original.release();
  expect(generate).toHaveBeenCalledTimes(4);
});
it('失败明确返回，不因多个挂载自动重试', async () => {
  const generate = vi.fn((): Promise<LinkWaveformResult> => Promise.reject(new Error('缓存损坏')));
  const cache = new WaveformCache(generate), first = cache.acquire(source);
  await expect(first.result).rejects.toThrow('缓存损坏'); first.release();
  const again = cache.acquire(source); await expect(again.result).rejects.toThrow('缓存损坏'); again.release();
  expect(generate).toHaveBeenCalledTimes(1);
});
it('链接失效失败后，重新打开拿到新链接时再读一次；同一个旧链接不重试', async () => {
  const generate = vi.fn((value: typeof source): Promise<LinkWaveformResult> => value.url === source.url ? Promise.reject(new Error('波形素材链接已失效')) : verified([0.5]));
  const cache = new WaveformCache(generate), stale = cache.acquire(source);
  await expect(stale.result).rejects.toThrow('链接已失效'); stale.release();
  const same = cache.acquire(source); await expect(same.result).rejects.toThrow('链接已失效'); same.release();
  expect(generate).toHaveBeenCalledTimes(1);
  const renewed = cache.acquire({ ...source, url: 'tblink://audio/renewed-url' });
  expect(top(await renewed.result)).toBeCloseTo(0.5, 3); renewed.release();
  const later = cache.acquire({ ...source, url: 'tblink://audio/another-url' }); expect(top(await later.result)).toBeCloseTo(0.5, 3); later.release();
  expect(generate).toHaveBeenCalledTimes(2);
});
