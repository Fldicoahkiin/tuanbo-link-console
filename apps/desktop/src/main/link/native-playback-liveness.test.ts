import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { NativePlaybackEvent } from '@tb/schema';
import { NativePlaybackClient } from './native-playback-client';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
afterEach(() => { vi.useRealTimers(); processMock.spawn.mockReset(); });

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processMock.spawn.mockReturnValue(child);
  const failed = vi.fn<(error: Error) => void>(), changed = vi.fn<(event: NativePlaybackEvent) => void>();
  const client = new NativePlaybackClient('test-engine.exe', changed, failed);
  const emit = (event: NativePlaybackEvent) => child.stdout.write(`${JSON.stringify(event)}\n`);
  const clock = (state: 'playing' | 'paused' = 'playing', positionMs = 0) => emit({ protocol: 4, kind: 'clock', generation: 1, state,
    positionMs, qpc100ns: '1000000', clockFrequency: 48000, sampleRate: 48000, underruns: 0, midiSent: 0, midiError: 0, midiInterruptions: 0, midiInterruption: 0, midiReopens: 0, midiReopenResult: 0,
    audioError: 0, maxMidiLatenessMs: 0, bufferedFrames: 1000, gain: 1, analysis: { fftSize: 2048, peaks: [0, 0], spectrum: Array.from({ length: 1024 }, () => 0) } });
  const start = async () => {
    const pending = client.start(); emit({ protocol: 4, kind: 'ready', pid: 123, title: 'test', windowClass: 'Static' });
    await vi.advanceTimersByTimeAsync(10); await pending;
  };
  const close = async () => { child.emit('close', 0, null); await client.close(); };
  return { child, client, failed, changed, clock, start, close };
}

it('引擎仍存活但播放状态断流，撤销旧时钟并报告一次；迟到消息不复活输出', async () => {
  const f = fixture(); await f.start(); f.clock();
  await vi.advanceTimersByTimeAsync(1001);
  expect(f.failed).toHaveBeenCalledOnce(); expect(f.failed.mock.calls[0]![0].message).toContain('超过 1 秒');
  expect(f.client.clock).toBeNull(); expect(f.child.stdin.writableEnded).toBe(true);
  const count = f.changed.mock.calls.length; f.clock('playing', 5000);
  expect(f.changed).toHaveBeenCalledTimes(count); expect(f.client.clock).toBeNull();
  await expect(f.client.command({ protocol: 4, requestId: 1, generation: 2, kind: 'play' })).rejects.toThrow('不会沿用旧位置');
  await f.close(); expect(f.failed).toHaveBeenCalledOnce();
});

it('状态持续到达、暂停及正常关闭均不误报；检查前到达的在途状态取消过期判断', async () => {
  const f = fixture(); await f.start(); f.clock();
  for (let index = 1; index <= 30; index++) { await vi.advanceTimersByTimeAsync(50); f.clock('playing', index * 50); }
  expect(f.failed).not.toHaveBeenCalled();
  // The timer phase may run before the OS pipe poll after a host stall.
  vi.advanceTimersByTime(1000); f.clock('playing', 2500); await vi.advanceTimersByTimeAsync(1);
  expect(f.failed).not.toHaveBeenCalled();
  f.clock('paused', 2500); await vi.advanceTimersByTimeAsync(5000);
  expect(f.failed).not.toHaveBeenCalled();
  const closing = f.client.close(); f.child.emit('close', 0, null); await closing;
  await vi.advanceTimersByTimeAsync(5000); expect(f.failed).not.toHaveBeenCalled();
});
