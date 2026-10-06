import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NativePlayerPrepare, NativePlayerStatus } from '@tb/schema';
import { NativePlaybackRequests } from './native-playback-requests';

function request(): NativePlayerPrepare {
  return { version: 1, sessionId: randomUUID(), generation: 1, projectPath: 'C:/test/show.tblink', audioDeviceId: 'default', midiPortName: null,
    snapshot: { version: 1, projectId: 'show', itemId: 'song', revision: 1, audio: { relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      startMs: 500, positionMs: 500, endMs: 9000, offsetMs: 480000, sampleRate: 48000, frameRate: 30, volume: 0.5 } };
}
function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release!() };
}
function service() {
  const prepare = vi.fn((r: NativePlayerPrepare): Promise<NativePlayerStatus> => Promise.resolve({ version: 1, sessionId: r.sessionId,
    generation: r.generation, itemId: r.snapshot.itemId, status: 'ready', positionMs: r.snapshot.positionMs, offsetMs: r.snapshot.offsetMs,
    sampleRate: 48000, enginePid: 123, engineTitle: 'test', mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null, underruns: 0, gain: 0.5, analysis: null }));
  return { prepare, control: vi.fn((): Promise<NativePlayerStatus> => Promise.reject(new Error('unexpected output'))) };
}

it('授权未返回时停止立即取消准备；迟到许可不会创建音频服务', async () => {
  const pending = deferred(), engine = service(), factory = vi.fn(() => engine);
  const authorize = vi.fn((channel: string) => channel === 'link:native-player-prepare' ? pending.promise : Promise.resolve());
  const gateway = new NativePlaybackRequests(factory, authorize), input = request();
  const starting = gateway.prepare(input), cancelled = expect(starting).rejects.toThrow('取消');
  const stopped = await gateway.control({ version: 1, sessionId: input.sessionId, generation: 2, kind: 'stop' });
  expect(stopped).toMatchObject({ status: 'stopped', enginePid: null, positionMs: 500, offsetMs: 480000 });
  expect(factory).not.toHaveBeenCalled(); await cancelled; pending.release();
  expect(engine.prepare).not.toHaveBeenCalled(); expect(authorize).toHaveBeenCalledTimes(2);
});

it('新节目先获许可时，旧准备和旧会话停止不能覆盖新节目', async () => {
  const pending = deferred(), engine = service(), old = request(), next = request();
  const gateway = new NativePlaybackRequests(() => engine, (_channel, value) => value === undefined ? Promise.reject(new Error('missing'))
    : (value as { sessionId: string }).sessionId === old.sessionId ? pending.promise : Promise.resolve());
  const starting = gateway.prepare(old), cancelled = expect(starting).rejects.toThrow('取消');
  expect((await gateway.prepare(next)).sessionId).toBe(next.sessionId);
  pending.release(); await cancelled;
  await expect(gateway.control({ version: 1, sessionId: old.sessionId, generation: 9, kind: 'stop' })).rejects.toThrow('失效会话');
  expect(engine.prepare).toHaveBeenCalledExactlyOnceWith(next); expect(engine.control).not.toHaveBeenCalled();
});

it('授权失败绝不进入服务，已准备后的迟到播放被暂停取消', async () => {
  const pending = deferred(), engine = service(), input = request();
  let deny = true;
  const gateway = new NativePlaybackRequests(() => engine, (channel, value) => {
    if (deny) return Promise.reject(new Error('许可无效'));
    if (channel === 'link:native-player-control' && (value as { kind: string }).kind === 'play') return pending.promise;
    return Promise.resolve();
  });
  await expect(gateway.prepare(input)).rejects.toThrow('许可无效'); expect(engine.prepare).not.toHaveBeenCalled();
  deny = false; const ready = await gateway.prepare({ ...input, generation: 2 }); engine.control.mockResolvedValue({ ...ready, generation: 4, status: 'paused' });
  const playing = gateway.control({ version: 1, sessionId: input.sessionId, generation: 3, kind: 'play' });
  const cancelled = expect(playing).rejects.toThrow('取消');
  const paused = await gateway.control({ version: 1, sessionId: input.sessionId, generation: 4, kind: 'pause' });
  expect(paused.status).toBe('paused'); pending.release(); await cancelled;
  expect(engine.control).toHaveBeenCalledTimes(1);
});
