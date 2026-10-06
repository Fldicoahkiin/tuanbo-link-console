import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NativePlaybackCommand, NativePlaybackEvent, NativePlaybackDevices, NativePlayerPrepare } from '@tb/schema';
import { NativePlayerService } from './native-player-service';

const native = vi.hoisted(() => ({ devices: vi.fn<() => Promise<NativePlaybackDevices>>(), commands: vi.fn<(command: NativePlaybackCommand) => void>() }));
vi.mock('./native-device-query', () => ({ NativeDeviceQuery: class {
  read = native.devices;
  reopenForPreparation() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
} }));
vi.mock('./native-playback-client', () => ({
  NativePlaybackClient: class {
    readonly identity = { pid: 123, title: 'test', windowClass: 'Static' as const };
    private clock: Extract<NativePlaybackEvent, { kind: 'clock' }> = {
      protocol: 4, kind: 'clock', generation: 0, state: 'empty', positionMs: 0, qpc100ns: '1',
      clockFrequency: 48000, sampleRate: 48000, underruns: 0, midiSent: 0, midiError: 0, audioError: 0,
      maxMidiLatenessMs: 0, bufferedFrames: 1000, gain: 1,
      analysis: { fftSize: 2048, peaks: [0, 0], spectrum: Array.from({ length: 1024 }, () => 0) }
    };
    constructor(_executable: string, private readonly changed: (event: NativePlaybackEvent) => void) {}
    start() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    command(command: NativePlaybackCommand) {
      native.commands(command);
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
afterEach(() => { native.devices.mockReset(); native.commands.mockReset(); });

function fixture() {
  const devices: NativePlaybackDevices = { protocol: 4, audio: [{ id: 'default', name: 'test', isDefault: true }],
    midiOutputs: [{ id: 1, name: 'test-mtc' }] };
  native.devices.mockImplementation(() => Promise.resolve(devices));
  const error = vi.fn();
  const service = new NativePlayerService({ executable: 'test', changed: vi.fn(), error,
    resolveAudio: () => 'test.wav', cache: { prepare: () => Promise.resolve({ path: 'test.pcm', sampleRate: 48000 as const,
      baseMs: 0, streaming: false, frames: 480000, durationMs: 10000,
      completion: Promise.resolve({ ok: true as const }), release: () => Promise.resolve() }) } });
  const request: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1,
    projectPath: 'C:/test.tblink', audioDeviceId: 'default', midiPortName: 'test-mtc',
    snapshot: { version: 1, projectId: 'test', itemId: 'song', revision: 1,
      audio: { relativePath: 'test.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      startMs: 500, endMs: 9500, positionMs: 500, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 1 } };
  return { service, request, error, devices };
}

it('定位时 MIDI 端口消失只退出时间码通道，音频仍可定位和继续；端口回来不自动恢复', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId };
  try {
    await f.service.prepare(f.request);
    await f.service.control({ ...envelope, generation: 2, kind: 'play' });
    f.devices.midiOutputs = [];
    await f.service.control({ ...envelope, generation: 3, kind: 'seek', positionMs: 2000 });
    expect(f.service.status).toMatchObject({ status: 'paused', positionMs: 2000, offsetMs: 480000,
      audioError: null, mtcPortName: null });
    expect(f.service.status?.mtcError).toContain('目标已改变');
    expect(f.error).toHaveBeenCalledOnce();
    const prepared = native.commands.mock.calls.flatMap(([command]) => command.kind === 'prepare' ? [command] : []);
    expect(prepared.at(-1)?.midiDevice).toBeNull();
    f.devices.midiOutputs = [{ id: 2, name: 'test-mtc' }];
    await f.service.control({ ...envelope, generation: 4, kind: 'play' });
    await f.service.control({ ...envelope, generation: 5, kind: 'seek', positionMs: 3000 });
    expect(f.service.status).toMatchObject({ status: 'paused', mtcPortName: null, audioError: null });
    expect(f.error).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('定位设备查询未返回时切歌，旧设备缺失结果不能清除新歌曲的 MIDI', async () => {
  const f = fixture();
  let release: ((devices: NativePlaybackDevices) => void) | undefined;
  try {
    await f.service.prepare(f.request);
    native.devices.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const seeking = f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'seek', positionMs: 2000 });
    const rejected = expect(seeking).rejects.toThrow('取消');
    await vi.waitFor(() => expect(release).toBeDefined());
    const next = f.service.prepare({ ...f.request, sessionId: randomUUID(), snapshot: { ...f.request.snapshot, itemId: 'next' } });
    release!({ ...f.devices, midiOutputs: [] });
    await rejected; await next;
    expect(f.service.status).toMatchObject({ itemId: 'next', status: 'ready', mtcPortName: 'test-mtc', mtcError: null, audioError: null });
    expect(f.error).not.toHaveBeenCalled();
  } finally { release?.(f.devices); await f.service.close(); }
});
