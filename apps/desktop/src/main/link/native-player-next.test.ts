import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativePlaybackCommand, NativePlaybackEvent, NativePlaybackDevices, NativePlayerPrepare, PlaybackSnapshot } from '@tb/schema';
import type { NativeAudioCache, NativeAudioLease } from './native-audio-cache';
import { NativePlayerService } from './native-player-service';

/** What the engine process was sent. */
const engine = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('./native-device-query', () => ({ NativeDeviceQuery: class {
  read(): Promise<NativePlaybackDevices> {
    return Promise.resolve({ protocol: 4, audio: [{ id: 'default', name: 'test', isDefault: true }], midiOutputs: [], midiInputs: [] });
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
    get running() { return true; }
    get sounding() { return false; }
    start() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    command(command: NativePlaybackCommand) {
      engine.commands.push(command.kind);
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

async function fixture() {
  engine.commands = [];
  const directory = await mkdtemp(join(tmpdir(), 'tblink-player-next-')), source = join(directory, 'song.wav');
  await writeFile(source, 'audio');
  const lease = (sha: string): NativeAudioLease => ({ path: `${sha}.pcm`, sampleRate: 48000, baseMs: 0, streaming: false, frames: 480000, durationMs: 10000,
    availableMs: 10000, completion: Promise.resolve({ ok: true }), release: vi.fn(() => Promise.resolve()) });
  const prepare = vi.fn<NativeAudioCache['prepare']>(input => Promise.resolve(lease(input.sourceSha256.slice(0, 1))));
  const error = vi.fn(), measured = vi.fn(), ahead = vi.fn<(itemId: string) => void>();
  const service = new NativePlayerService({ executable: 'test', changed: vi.fn(), error, preloadError: error, measured,
    measuredAhead: itemId => ({ add: () => undefined, done: () => ahead(itemId) }),
    checkDeviceHealth: () => Promise.resolve(), resolveAudio: () => source, cache: { prepare } });
  const snapshot = (itemId: string, sha: string): PlaybackSnapshot => ({ version: 1, projectId: 'test', itemId, revision: 1,
    audio: { relativePath: `${itemId}.wav`, sha256: sha.repeat(64), durationMs: 10000 },
    startMs: 0, endMs: 9000, positionMs: 0, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 1 });
  const request: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1, projectPath: 'C:/test.tblink', audioDeviceId: 'default',
    midiPortName: null, snapshot: snapshot('甲', 'a'), nextSnapshot: snapshot('乙', 'b') };
  const decoded = () => prepare.mock.calls.map(([input]) => input.sourceSha256.slice(0, 1));
  const warm = () => measured.mock.calls.filter(([phase]) => phase === '使用预先准备的下一首音频').length;
  const ready = (count: number) => vi.waitFor(() => expect(ahead).toHaveBeenCalledTimes(count));
  return { service, request, snapshot, prepare, error, decoded, warm, ready };
}

// 0.5.9 S8b: the next song's audio follows the newest version while this one plays, beside it.
it('播放中下一首换了：不给引擎发任何命令，放下旧的准备新的；接下一首时用的是新的（热启动）', async () => {
  const f = await fixture();
  await f.service.prepare(f.request);
  await f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'play' });
  await f.ready(1);
  expect(f.decoded()).toEqual(['a', 'b']);
  const sent = [...engine.commands];
  await f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 2, nextSnapshot: { ...f.snapshot('乙', 'c'), revision: 2 } });
  await f.ready(2);
  expect(engine.commands).toEqual(sent);
  expect(f.decoded()).toEqual(['a', 'b', 'c']);
  expect(f.service.status).toMatchObject({ status: 'playing', itemId: '甲', generation: 2 });
  const { nextSnapshot: _played, ...song } = f.request; void _played;
  await f.service.prepare({ ...song, generation: 3, snapshot: { ...f.snapshot('乙', 'c'), revision: 3 } });
  expect(f.decoded()).toEqual(['a', 'b', 'c']); expect(f.warm()).toBe(1);
  expect(f.error).not.toHaveBeenCalled();
});

it('不是播放控制：排队中的播放控制不会被它取消', async () => {
  const f = await fixture();
  await f.service.prepare(f.request);
  const playing = f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'play' });
  const asked = f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 2, nextSnapshot: f.snapshot('丙', 'd') });
  await expect(playing).resolves.toMatchObject({ status: 'playing' });
  await asked; await f.ready(1);
  // The play that was queued prepared the newest ask ahead.
  expect(f.decoded()).toEqual(['a', 'd']);
});

it('还没开始播：只记下来，开始播时才准备；不要了（null）就不准备；停了以后再问就拒绝', async () => {
  const f = await fixture();
  await f.service.prepare(f.request);
  await f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 1, nextSnapshot: f.snapshot('丙', 'd') });
  expect(f.decoded()).toEqual(['a']);
  await f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 1, nextSnapshot: null });
  await f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'play' });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.decoded()).toEqual(['a']);
  await f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 3, kind: 'stop' });
  await expect(f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 3, nextSnapshot: f.snapshot('丙', 'd') })).rejects.toThrow('已经停了');
  await expect(f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 2, nextSnapshot: f.snapshot('丙', 'd') })).rejects.toThrow('已过期');
  await expect(f.service.prepareNext({ version: 1, sessionId: f.request.sessionId, generation: 3, nextSnapshot: { ...f.snapshot('丙', 'd'), sampleRate: 44100 } })).rejects.toThrow();
});
