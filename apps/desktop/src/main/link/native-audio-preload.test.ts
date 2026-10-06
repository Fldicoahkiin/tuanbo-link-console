import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlaybackSnapshot } from '@tb/schema';
import type { NativeAudioLease } from './native-audio-cache';
import { NativeAudioPreload } from './native-audio-preload';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-audio-preload-'));
  const path = join(directory, 'source.wav'); await writeFile(path, 'audio fixture');
  const snapshot: PlaybackSnapshot = { version: 1, projectId: 'p', itemId: 'next', revision: 7,
    audio: { relativePath: 'source.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
    startMs: 1000, endMs: 9000, positionMs: 1500, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 0.8 };
  const release = vi.fn(() => Promise.resolve()), error = vi.fn(), measured = vi.fn();
  const lease: NativeAudioLease = { path: join(directory, 'decoded.pcm'), baseMs: 1000, streaming: true, frames: 480000,
    durationMs: 10000, sampleRate: 48000, completion: Promise.resolve({ ok: true }), release };
  const prepare = vi.fn(() => Promise.resolve(lease));
  const preload = new NativeAudioPreload({ cache: { prepare }, resolveAudio: () => path, error, measured });
  return { preload, path, snapshot, lease, prepare, release, error, measured };
}

it('预填充不发设备指令，精确复用下一首音源；音量变化不重新解码，接管后由播放租约清理', async () => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalledWith('下一节目音频预填充', expect.any(Number)));
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(await f.preload.take('p.tblink', { ...f.snapshot, volume: 0 })).toBe(f.lease);
  await f.preload.cancel(); expect(f.release).not.toHaveBeenCalled();
  await f.lease.release(); expect(f.release).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
});

it.each(['project', 'revision', 'position'] as const)('切换 %s 后不能套用旧预填充', async change => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalled());
  expect(await f.preload.take(change === 'project' ? 'other.tblink' : 'p.tblink', {
    ...f.snapshot, ...(change === 'revision' ? { revision: 8 } : {}), ...(change === 'position' ? { positionMs: 5000 } : {})
  })).toBeNull();
  expect(f.release).toHaveBeenCalledOnce();
});

it('音频原文件在预热后发生变化，释放缓存并明确阻止使用旧内容', async () => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalled());
  await writeFile(f.path, 'changed audio');
  await expect(f.preload.take('p.tblink', f.snapshot)).rejects.toThrow('原文件发生变化');
  expect(f.release).toHaveBeenCalledOnce();
});

it('停止取消在途预填充，迟到完成只能释放，不能重新成为待播音源', async () => {
  const f = await fixture(); let complete: ((value: NativeAudioLease) => void) | undefined;
  f.prepare.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled());
  const cancelled = f.preload.cancel(); complete!(f.lease); await cancelled;
  expect(f.release).toHaveBeenCalledOnce(); expect(await f.preload.take('p.tblink', f.snapshot)).toBeNull();
});
