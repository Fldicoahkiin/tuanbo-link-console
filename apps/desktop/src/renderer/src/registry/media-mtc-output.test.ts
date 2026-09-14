import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaMtcOutput } from './media-mtc-output';
import { MtcQuarterFrameDecoder, playbackFramesPerSecond } from '@tb/core/link';

afterEach(() => vi.unstubAllGlobals());
describe('Electron 原生 MIDI 时间码输出', () => {
  it('运行中无效媒体位置明确报错，不会静默停发', async () => {
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', open: () => Promise.resolve(), send: () => undefined }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(0, '30', 0);
    for (const position of [NaN, Infinity, -1, 86400000]) expect(() => output.tick(position, '30', 5)).toThrow('音频位置无效');
    expect(() => output.tick(5, '30', NaN)).toThrow('调度时钟无效');
  });
  it('音乐时钟暂未前进时不提前发送，帧率改变重新定位而不混合消息', async () => {
    const send = vi.fn();
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', open: () => Promise.resolve(), send }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2');
    for (let now = 0; now <= 80; now += 5) output.tick(13, '30', now);
    expect(send).toHaveBeenCalledTimes(1);
    output.tick(34, '30', 85); expect(send.mock.calls.at(-1)?.[0]).toEqual([0xf1, 1]);
    output.tick(34, '25', 90); expect(send.mock.calls.at(-1)?.[0]?.[0]).toBe(0xf0);
    output.tick(40, '25', 95); expect(send.mock.calls.at(-1)?.[0]).toEqual([0xf1, 1]);
  });
  it.each(['24', '25', '29.97df', '30'] as const)('%s fps 从帧中途启动和定位后按音乐帧边界发送', async (rate) => {
    let mediaMs = 13;
    const decoder = new MtcQuarterFrameDecoder();
    const errors: number[] = [];
    const send = vi.fn((message: number[]) => {
      if (message[0] !== 0xf1) return;
      const sample = decoder.push(message[1]!, mediaMs);
      if (sample) errors.push(sample.totalFrames * 1000 / playbackFramesPerSecond(rate) - mediaMs);
    });
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', open: () => Promise.resolve(), send }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2');
    output.tick(mediaMs, rate, 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0][0]).toBe(0xf0);
    for (let tick = 1; tick <= 1000; tick += 1) { mediaMs = 13 + tick; output.tick(mediaMs, rate, tick); }
    expect(errors.length).toBeGreaterThan(10);
    expect(Math.max(...errors.map(Math.abs))).toBeLessThan(1000 / playbackFramesPerSecond(rate) / 4 + 1);
    output.stop(); decoder.reset(); send.mockClear(); errors.length = 0;
    mediaMs = 60013; output.tick(mediaMs, rate, 2000);
    expect(send).toHaveBeenCalledTimes(1);
    for (let tick = 1; tick <= 1000; tick += 1) { mediaMs = 60013 + tick; output.tick(mediaMs, rate, 2000 + tick); }
    expect(errors.length).toBeGreaterThan(10);
    expect(Math.max(...errors.map(Math.abs))).toBeLessThan(1000 / playbackFramesPerSecond(rate) / 4 + 1);
  });
  it('无 clear() 的实际 Web MIDI 端口能立即停止，无未来排队消息', async () => {
    const send = vi.fn();
    const port = { name: 'MA2', state: 'connected', open: () => Promise.resolve(), send };
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', port]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2');
    for (let time = 0; time < 1000; time += 8) output.tick(60_000 + time, '30', time);
    expect(send.mock.calls.filter(([message]) => (message as number[])[0] === 0xf1)).toHaveLength(120);
    expect(send.mock.calls.every((args) => args.length === 1)).toBe(true);
    expect(() => output.stop()).not.toThrow();
    output.tick(63_000, '30', 3000);
    expect(send.mock.calls.at(-2)?.[0]).toEqual([240, 127, 127, 1, 1, 96, 1, 3, 0, 247]);
  });
  it('无法追上超过 100ms 的调度中断时明确失败', async () => {
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', open: () => Promise.resolve(), send: () => undefined }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(0, '30', 0);
    expect(() => output.tick(200, '30', 200)).toThrow('100ms');
  });
});
