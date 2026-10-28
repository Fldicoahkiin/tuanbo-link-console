import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { NativePlaybackEvent } from '@tb/schema';
import { NativePlaybackClient } from './native-playback-client';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
afterEach(() => { vi.useRealTimers(); processMock.spawn.mockReset(); });

type State = Extract<NativePlaybackEvent, { kind: 'clock' }>['state'];
function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processMock.spawn.mockReturnValue(child);
  const failed = vi.fn<(error: Error) => void>();
  const client = new NativePlaybackClient('test-engine.exe', () => undefined, failed);
  const emit = (event: NativePlaybackEvent) => child.stdout.write(`${JSON.stringify(event)}\n`);
  const clock = (generation: number, state: State, positionMs: number) => emit({ protocol: 4, kind: 'clock', generation, state,
    positionMs, qpc100ns: '1000000', clockFrequency: 48000, sampleRate: 48000, underruns: 0, midiSent: 0, midiError: 0, midiInterruptions: 0, midiInterruption: 0, midiReopens: 0, midiReopenResult: 0,
    audioError: 0, maxMidiLatenessMs: 0, bufferedFrames: 1000, gain: 1, analysis: { fftSize: 2048, peaks: [0, 0], spectrum: Array.from({ length: 1024 }, () => 0) } });
  const start = async () => {
    const pending = client.start(); emit({ protocol: 4, kind: 'ready', pid: 123, title: 'test', windowClass: 'Static' });
    await vi.advanceTimersByTimeAsync(10); await pending;
  };
  return { child, client, failed, clock, emit, start };
}

it('切歌准备：确认前收到的同编号旧状态（上一首停止位置）不算准备结果，等到真正就绪的时钟', async () => {
  const f = fixture(); await f.start();
  const prepared = f.client.command({ protocol: 4, requestId: 1, generation: 2, kind: 'prepare', pcmPath: 'C:\\cache\\song.pcm', sampleRate: 48000,
    frameRate: 30, midiDevice: 0, midiPortName: 'test-mtc', startMs: 1000, endMs: 60000, offsetMs: 480000, volume: 1 });
  // The previous song's stop left the device stopped at 9 s; this report arrived before the acknowledgement.
  f.clock(2, 'stopped', 9000);
  f.emit({ protocol: 4, kind: 'ack', requestId: 1, generation: 2, ok: true, code: 0 });
  await vi.advanceTimersByTimeAsync(1); await prepared;
  const read = f.client.readClock(2, ['ready', 'error']);
  await vi.advanceTimersByTimeAsync(20);
  f.clock(2, 'ready', 1000);
  await vi.advanceTimersByTimeAsync(20);
  await expect(read).resolves.toMatchObject({ generation: 2, state: 'ready', positionMs: 1000 });
  expect(f.failed).not.toHaveBeenCalled();
});

it('操作后 1 秒内没有出现结束状态：明确报告缺少设备确认并停止，不沿用旧状态', async () => {
  const f = fixture(); await f.start();
  f.clock(3, 'paused', 2000);
  const read = f.client.readClock(3, ['playing', 'ended', 'error']);
  const settled = expect(read).rejects.toThrow('没有收到声卡的确认');
  await vi.advanceTimersByTimeAsync(1100);
  await settled;
  expect(f.failed).toHaveBeenCalledOnce();
});
