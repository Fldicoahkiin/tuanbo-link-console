import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlaybackSnapshot } from '@tb/schema';
import type { NativeAudioCache, NativeAudioLease } from './native-audio-cache';
import type { DecodeResult } from './native-audio-decode';
import { NativeAudioPreload } from './native-audio-preload';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-audio-preload-'));
  const path = join(directory, 'source.wav'); await writeFile(path, 'audio fixture');
  const snapshot: PlaybackSnapshot = { version: 1, projectId: 'p', itemId: 'next', revision: 7,
    audio: { relativePath: 'source.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
    startMs: 1000, endMs: 9000, positionMs: 1500, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 0.8 };
  const release = vi.fn(() => Promise.resolve()), error = vi.fn(), measured = vi.fn();
  const lease: NativeAudioLease = { path: join(directory, 'decoded.pcm'), baseMs: 1000, streaming: true, frames: 480000,
    durationMs: 10000, availableMs: 10000, sampleRate: 48000, completion: Promise.resolve({ ok: true }), release };
  const prepare = vi.fn<NativeAudioCache['prepare']>(() => Promise.resolve(lease));
  const preload = new NativeAudioPreload({ cache: { prepare }, resolveAudio: () => path, error, measured });
  // A job is ready only once it is measured: after the cache's prepare it still reads the source file again,
  // and a take() in between finds it unfinished. So waiting for prepare() to be called is not enough.
  const prepared = (count: number) => vi.waitFor(() => expect(measured.mock.calls.filter(([phase]) => phase === '预先准备下一首音频')).toHaveLength(count));
  return { preload, path, snapshot, lease, prepare, release, error, measured, prepared };
}

/** A failure while the next song is let go: its cleanup failed, or the job failed on its own just then. */
const letGo = (cause: string) => `下一首提前准备的音频已放下，放下时出了错，这份音频不会再用。如果反复出现，请导出诊断包发给售后。原因：${cause}`;

it('预填充不发设备指令，精确复用下一首音源；音量变化不重新解码，接管后由播放租约清理', async () => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalledWith('预先准备下一首音频', expect.any(Number)));
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(await f.preload.take('p.tblink', { ...f.snapshot, volume: 0 })).toBe(f.lease);
  await f.preload.cancel(); expect(f.release).not.toHaveBeenCalled();
  await f.lease.release(); expect(f.release).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
});

it.each(['project', 'audio', 'position'] as const)('切换 %s 后不能套用旧预填充', async change => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalled());
  expect(await f.preload.take(change === 'project' ? 'other.tblink' : 'p.tblink', {
    ...f.snapshot, ...(change === 'audio' ? { audio: { ...f.snapshot.audio, sha256: 'b'.repeat(64) } } : {}), ...(change === 'position' ? { positionMs: 5000 } : {})
  })).toBeNull();
  expect(f.release).toHaveBeenCalledOnce();
});

// 0.5.9 S8a: known by what the audio is, not by the project version that asked for it.
it('拿着歌时只改了别的（比如在播那首的音量）：工程版本变了，下一首的音频没变，自动接下一首用上提前准备的', async () => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot);
  await f.prepared(1);
  expect(await f.preload.take('p.tblink', { ...f.snapshot, revision: 8 })).toBe(f.lease);
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled();
});

it('音频原文件在预热后发生变化，释放缓存并明确阻止使用旧内容', async () => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalled());
  await writeFile(f.path, 'changed audio');
  await expect(f.preload.take('p.tblink', f.snapshot)).rejects.toThrow('原文件变了');
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

it('下一首的租约释放失败一次：这次记下错误；之后换歌、换回这首、接着播都照常准备，预备也能重新开始', async () => {
  const f = await fixture(); f.release.mockRejectedValueOnce(new Error('EPERM: operation not permitted, rename'));
  f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalledWith('预先准备下一首音频', expect.any(Number)));
  // Another song is played: it is prepared as usual, and the failed cleanup is reported once, as a matter of the
  // next song: it is not the failure of the song played (take() does not throw).
  expect(await f.preload.take('p.tblink', { ...f.snapshot, itemId: 'other' })).toBeNull();
  expect(f.error).toHaveBeenCalledExactlyOnceWith(letGo('EPERM: operation not permitted, rename'));
  // Back to this song: nothing is left over, and the song after it is prepared ahead again.
  expect(await f.preload.take('p.tblink', f.snapshot)).toBeNull();
  f.preload.start('p.tblink', f.snapshot);
  await f.prepared(2);
  expect(await f.preload.take('p.tblink', f.snapshot)).toBe(f.lease);
  expect(f.error).toHaveBeenCalledOnce();
});

it('取消时清理失败：错误交给取消的一方，这份预备照样放下，之后可以重新预备', async () => {
  const f = await fixture(); f.release.mockRejectedValueOnce(new Error('EBUSY: resource busy or locked, rename'));
  f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalled());
  await expect(f.preload.cancel()).rejects.toThrow('EBUSY');
  await f.preload.cancel();
  f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
  expect(f.release).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
});

it('接手时读不到原文件：这首歌照常报错，这份预备也放下，文件回来后可以重新预备', async () => {
  const f = await fixture(); f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalled());
  await rename(f.path, `${f.path}.moved`);
  await expect(f.preload.take('p.tblink', f.snapshot)).rejects.toThrow('ENOENT');
  expect(f.release).toHaveBeenCalledOnce();
  await rename(`${f.path}.moved`, f.path);
  f.preload.start('p.tblink', f.snapshot);
  await f.prepared(2);
  expect(await f.preload.take('p.tblink', f.snapshot)).toBe(f.lease);
});

it('预备还在解码时换歌：取消本身不记；取消时解码进程没停下，单独记一条，不算换去这首歌的失败', async () => {
  const f = await fixture();
  // How the cache ends a cancelled preparation: with the cancellation itself (the signal's reason from a check, or
  // Node's own AbortError from a timer or a file read), or with the failure of letting its decoder go.
  f.prepare.mockImplementationOnce(async (_input, signal) => { await once(signal, 'abort'); signal.throwIfAborted(); return f.lease; })
    .mockImplementationOnce((_input, signal) => delay(60_000, f.lease, { signal }))
    .mockImplementationOnce(async (_input, signal) => {
      await once(signal, 'abort'); throw new Error('音频解码还没退出，进程保留，不会强制结束，也不会开始新的解码');
    });
  for (let started = 1; started <= 3; started++) {
    // Each time the job is let go, so the next one can start.
    f.preload.start('p.tblink', f.snapshot);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(started));
    expect(await f.preload.take('p.tblink', { ...f.snapshot, itemId: 'other' })).toBeNull();
  }
  expect(f.error).toHaveBeenCalledExactlyOnceWith(letGo('音频解码还没退出，进程保留，不会强制结束，也不会开始新的解码'));
  expect(f.release).not.toHaveBeenCalled();
});

it('接手时正好赶上下一首的后台解码失败：这首歌不会因此失败，放下这份预备，按正常流程准备', async () => {
  const f = await fixture();
  let fail!: (error: Error) => void;
  const completion = new Promise<DecodeResult>(resolve => { fail = error => resolve({ ok: false, error }); });
  f.prepare.mockResolvedValueOnce({ ...f.lease, completion });
  f.preload.start('p.tblink', f.snapshot);
  await vi.waitFor(() => expect(f.measured).toHaveBeenCalledWith('预先准备下一首音频', expect.any(Number)));
  // take() is reading the source file when the decode fails: the failure is seen before that read returns.
  const taking = f.preload.take('p.tblink', f.snapshot);
  fail(new Error('音频解码 30 秒没有进展，已停止解码'));
  await expect(taking).resolves.toBeNull();
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.error).toHaveBeenCalledExactlyOnceWith('下一首提前准备的音频解码失败，播到这首时照常准备。原因：音频解码 30 秒没有进展，已停止解码');
  // Nothing is left over: the next song is prepared ahead again and used.
  f.preload.start('p.tblink', f.snapshot);
  await f.prepared(2);
  expect(await f.preload.take('p.tblink', f.snapshot)).toBe(f.lease);
  expect(f.error).toHaveBeenCalledOnce();
});

it('下一首的音频文件没了，刚开始提前准备就换了歌：只记一条放下时出了错，带上真正的原因，不说成没清理干净', async () => {
  const f = await fixture(); await rename(f.path, `${f.path}.moved`);
  f.preload.start('p.tblink', f.snapshot);
  // Let go while it still reads the source file; that read then fails on its own, and there was nothing to clean up.
  expect(await f.preload.take('p.tblink', { ...f.snapshot, itemId: 'other' })).toBeNull();
  expect(f.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(letGo('ENOENT: ')));
  expect(f.prepare).not.toHaveBeenCalled();
});
