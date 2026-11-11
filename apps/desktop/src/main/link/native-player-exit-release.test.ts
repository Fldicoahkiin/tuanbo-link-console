import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NativePlaybackCommand, NativePlaybackEvent, NativePlaybackDevices, NativePlayerPrepare } from '@tb/schema';
import { NativePlayerService } from './native-player-service';
import type { MidiClaim } from './midi-port-broker';

/** The engine process as the service sees it: whether it is still there, and how its close ends. */
const engine = vi.hoisted(() => ({ running: true, close: (() => Promise.resolve()) as () => Promise<void> }));
vi.mock('./native-device-query', () => ({ NativeDeviceQuery: class {
  read(): Promise<NativePlaybackDevices> {
    return Promise.resolve({ protocol: 4, audio: [{ id: 'default', name: 'test', isDefault: true }], midiOutputs: [{ id: 1, name: 'test-mtc' }], midiInputs: [] });
  }
  reopenForPreparation() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
} }));
vi.mock('./native-playback-client', () => ({
  NativePlaybackClient: class {
    readonly identity = { pid: 123, title: 'test', windowClass: 'Static' as const };
    private clock: Extract<NativePlaybackEvent, { kind: 'clock' }> = {
      protocol: 4, kind: 'clock', generation: 0, state: 'empty', positionMs: 0, qpc100ns: '1',
      clockFrequency: 48000, sampleRate: 48000, underruns: 0, midiSent: 0, midiError: 0, midiInterruptions: 0, midiInterruption: 0, midiTransient: 0, midiTransientCode: 0, midiReopens: 0, midiReopenResult: 0, audioError: 0,
      maxMidiLatenessMs: 0, bufferedFrames: 1000, gain: 1,
      analysis: { fftSize: 2048, peaks: [0, 0], spectrum: Array.from({ length: 1024 }, () => 0) }
    };
    constructor(_executable: string, private readonly changed: (event: NativePlaybackEvent) => void) {}
    get running() { return engine.running; }
    get sounding() { return false; }
    start() { return Promise.resolve(); }
    close() { return engine.close(); }
    command(command: NativePlaybackCommand) {
      this.clock = { ...this.clock, generation: command.generation };
      if (command.kind === 'prepare') this.clock = { ...this.clock, state: 'ready', positionMs: command.startMs };
      else if (command.kind === 'play') this.clock.state = 'playing';
      else if (command.kind === 'pause') this.clock.state = 'paused';
      else if (command.kind === 'stop') this.clock.state = 'stopped';
      this.changed(this.clock);
      return Promise.resolve();
    }
    readClock() { return Promise.resolve(this.clock); }
  }
}));
afterEach(() => { engine.running = true; engine.close = () => Promise.resolve(); });

async function prepared() {
  const claim = { owner: '时间码' as const, release: vi.fn(), others: () => [] } satisfies MidiClaim;
  const lease = { path: 'test.pcm', sampleRate: 48000 as const, baseMs: 0, streaming: false, frames: 480000, durationMs: 10000, availableMs: 10000,
    completion: Promise.resolve({ ok: true as const }), release: vi.fn(() => Promise.resolve()) };
  const error = vi.fn(), closeFault = vi.fn();
  const service = new NativePlayerService({ executable: 'test', changed: vi.fn(), error, preloadError: error, closeFault,
    checkDeviceHealth: () => Promise.resolve(), resolveAudio: () => 'test.wav', cache: { prepare: () => Promise.resolve(lease) },
    claimMidiOutput: () => Promise.resolve(claim) });
  const request: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1,
    projectPath: 'C:/test.tblink', audioDeviceId: 'default', midiPortName: 'test-mtc',
    snapshot: { version: 1, projectId: 'test', itemId: 'song', revision: 1,
      audio: { relativePath: 'test.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      startMs: 500, endMs: 9500, positionMs: 500, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 1 } };
  await service.prepare(request);
  expect(claim.release).not.toHaveBeenCalled(); expect(lease.release).not.toHaveBeenCalled();
  return { service, claim, lease, error, closeFault };
}

// 0.5.9 S6 评审：关闭失败后旧服务被丢掉，它占着的时间码接口、音频文件和下一首的预备都没放，界面一直打不开那个输出口。
it('关闭失败时引擎进程已经不在了（带错误码退出）：当场放掉时间码接口和音频文件，失败照样抛出', async () => {
  const f = await prepared();
  engine.running = false; engine.close = () => Promise.reject(new Error('播放引擎已退出：3'));
  await expect(f.service.close()).rejects.toThrow('播放引擎已退出：3');
  expect(f.claim.release).toHaveBeenCalledOnce(); expect(f.lease.release).toHaveBeenCalledOnce();
  expect(f.closeFault).not.toHaveBeenCalled();
});

it('关闭失败时进程还在：什么都不放；进程后来退了，读到它不在才放，时间码接口在返回前就放掉', async () => {
  const f = await prepared();
  engine.close = () => Promise.reject(new Error('播放引擎没有正常退出，进程保留，没有强制结束'));
  await expect(f.service.close()).rejects.toThrow('没有正常退出');
  expect(f.claim.release).not.toHaveBeenCalled(); expect(f.lease.release).not.toHaveBeenCalled();
  expect(f.service.releaseExited()).toBeNull();
  expect(f.claim.release).not.toHaveBeenCalled();
  engine.running = false;
  const rest = f.service.releaseExited();
  expect(rest).not.toBeNull();
  // Before anything is awaited: a new engine opened right after this can claim the port.
  expect(f.claim.release).toHaveBeenCalledOnce();
  await rest;
  expect(f.lease.release).toHaveBeenCalledOnce();
});

it('进程退了以后音频文件放不开：记日志、标红，不抛出，不挡新引擎', async () => {
  const f = await prepared();
  engine.close = () => Promise.reject(new Error('播放引擎没有正常退出，进程保留，没有强制结束'));
  await expect(f.service.close()).rejects.toThrow('没有正常退出');
  f.lease.release.mockRejectedValueOnce(new Error('文件被占用'));
  engine.running = false;
  await expect(f.service.releaseExited()).resolves.toBeUndefined();
  const message = '音频引擎已经退出，但上一首的音频文件没能放开：文件被占用。之后的歌照常播放；如果之后读不到这首歌的音频，请重启联动台';
  expect(f.error).toHaveBeenCalledWith(message); expect(f.closeFault).toHaveBeenCalledExactlyOnceWith(message);
  expect(f.claim.release).toHaveBeenCalledOnce();
});
