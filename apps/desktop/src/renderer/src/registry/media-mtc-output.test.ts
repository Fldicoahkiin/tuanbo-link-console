import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./license-output', () => ({ requireOutputLicense: vi.fn().mockResolvedValue(undefined) }));
import { MediaMtcOutput } from './media-mtc-output';
import { MtcQuarterFrameDecoder, playbackFramesPerSecond } from '@tb/core/link';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('Electron 原生 MIDI 时间码输出', () => {
  it.each(['permission', 'open'])('%s 挂起五秒后明确失败，迟到结果不得绑定或发送', async phase => {
    vi.useFakeTimers();
    const send = vi.fn();
    let release = (): void => undefined;
    const port = { name: 'MA2', state: 'connected', connection: 'open', send, open: () => new Promise<void>(resolve => { release = resolve; }) };
    const access = { outputs: new Map([['ma', port]]) };
    vi.stubGlobal('navigator', { requestMIDIAccess: () => phase === 'permission' ? new Promise<typeof access>(resolve => { release = () => resolve(access); }) : Promise.resolve(access) });
    const output = new MediaMtcOutput();
    const failed = expect(output.connect('MA2')).rejects.toThrow('超时（5 秒）');
    await vi.advanceTimersByTimeAsync(5000); await failed;
    release(); await vi.advanceTimersByTimeAsync(0);
    output.tick(0, '30', 0); expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('停止取消在途打开，旧结果迟到不会替换下一次连接', async () => {
    const oldSend = vi.fn(), nextSend = vi.fn();
    let release = (): void => undefined;
    const oldPort = { name: 'Old', state: 'connected', connection: 'open', send: oldSend, open: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) };
    const nextPort = { name: 'Next', state: 'connected', connection: 'open', send: nextSend, open: () => Promise.resolve() };
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['old', oldPort], ['next', nextPort]]) }) });
    const output = new MediaMtcOutput();
    const cancelled = expect(output.connect('Old')).rejects.toThrow('已取消');
    await vi.waitFor(() => expect(oldPort.open).toHaveBeenCalledOnce());
    output.stop(); await cancelled;
    await output.connect('Next'); release(); await Promise.resolve(); await Promise.resolve();
    output.tick(0, '30', 0);
    expect(oldSend).not.toHaveBeenCalled(); expect(nextSend).toHaveBeenCalled();
  });
  it('分别报告输出缺失和同名重复，绝不选择其他端口代替', async () => {
    const open = vi.fn(() => Promise.resolve());
    const ports = new Map([['other', { name: '其他端口', state: 'connected', open }]]);
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: ports }) });
    const output = new MediaMtcOutput();
    await expect(output.connect('MA2')).rejects.toThrow('未检测到 MIDI 时间码输出：MA2');
    ports.set('one', { name: 'MA2', state: 'connected', open });
    ports.set('two', { name: 'MA2', state: 'connected', open });
    await expect(output.connect('MA2')).rejects.toThrow('名称重复：MA2（2 个）');
    expect(open).not.toHaveBeenCalled();
  });
  it.each(['closed', 'pending'] as const)('端口仍 connected 但连接为 %s 时阻断发送，不允许 send 隐式重开', async (connection) => {
    const send = vi.fn();
    const port = { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send };
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', port]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(0, '30', 0);
    send.mockClear(); port.connection = connection;
    expect(() => output.tick(8, '30', 8)).toThrow('连接已失效');
    expect(send).not.toHaveBeenCalled();
  });
  it('媒体时钟回跳而未显式定位时立即失败，避免等待旧位置造成静默断流', async () => {
    const send = vi.fn();
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(10000, '30', 0);
    send.mockClear();
    expect(() => output.tick(9000, '30', 8)).toThrow('回跳');
    expect(send).not.toHaveBeenCalled();
    output.stop(); output.tick(9000, '30', 16);
    expect(send.mock.calls[0]?.[0]?.[0]).toBe(0xf0);
  });
  it('运行中无效媒体位置明确报错，不会静默停发', async () => {
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send: () => undefined }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(0, '30', 0);
    for (const position of [NaN, Infinity, -1, 86400000]) expect(() => output.tick(position, '30', 5)).toThrow('音频位置无效');
    expect(() => output.tick(5, '30', NaN)).toThrow('调度时钟无效');
  });
  it('音乐时钟暂未前进时不提前发送，帧率改变重新定位而不混合消息', async () => {
    const send = vi.fn();
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
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
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
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
    const port = { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send };
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', port]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2');
    for (let time = 0; time < 1000; time += 8) output.tick(60_000 + time, '30', time);
    expect(send.mock.calls.filter(([message]) => (message as number[])[0] === 0xf1)).toHaveLength(120);
    expect(send.mock.calls.every((args) => args.length === 1)).toBe(true);
    expect(() => output.stop()).not.toThrow();
    output.tick(63_000, '30', 3000);
    expect(send.mock.calls.at(-2)?.[0]).toEqual([240, 127, 127, 1, 1, 96, 1, 3, 0, 247]);
  });
  it.each(['24', '25', '29.97df', '30'] as const)('%s fps 短暂调度延迟按真实音频重定位，不补发过期半帧', async rate => {
    const send = vi.fn();
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(0, rate, 0); output.tick(16, rate, 16);
    send.mockClear();
    expect(output.tick(216, rate, 216)).toBe(true);
    expect(send.mock.calls).toHaveLength(1); expect(send.mock.calls[0]?.[0]?.[0]).toBe(0xf0);
    expect(output.takeSchedulingNotice()).toContain('200ms'); expect(output.takeSchedulingNotice()).toBeNull();
    for (let now = 224; now < 400; now += 8) output.tick(now, rate, now);
    const pieces = send.mock.calls.filter(([message]) => message[0] === 0xf1).map(([message]) => message[1] >> 4);
    expect(pieces.length).toBeGreaterThan(8);
    expect(pieces.every((piece, index) => piece === index % 8)).toBe(true);
  });
  it.each([[600, 600], [2000, 200], [0, 200]])('长时间中断或音频跳变仍阻断：位置 %s / 时钟 %s', async (position, now) => {
    const send = vi.fn();
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2'); output.tick(0, '30', 0);
    send.mockClear(); expect(() => output.tick(position, '30', now)).toThrow('已停止');
    expect(send).not.toHaveBeenCalled(); expect(output.takeSchedulingNotice()).toBeNull();
  });
  it.each(['24', '25', '29.97df', '30'] as const)('%s fps 一小时确定性调度保持顺序和有界误差（非实体或实时验收）', async (rate) => {
    const decoder = new MtcQuarterFrameDecoder();
    let positionMs = 0; let expectedPiece = 0; let quarters = 0; let cycles = 0; let maxErrorMs = 0;
    const fps = playbackFramesPerSecond(rate);
    const send = (message: number[]): void => {
      if (message[0] !== 0xf1) return;
      const data = message[1]!;
      if ((data >> 4) !== expectedPiece) throw new Error('quarter-frame 顺序错误');
      expectedPiece = (expectedPiece + 1) % 8; quarters += 1;
      const sample = decoder.push(data, positionMs);
      if (sample) { cycles += 1; maxErrorMs = Math.max(maxErrorMs, Math.abs(sample.totalFrames * 1000 / fps - positionMs)); }
    };
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
    const output = new MediaMtcOutput(); await output.connect('MA2');
    for (let now = 0; now < 3_600_000; now += 5) { positionMs = now; output.tick(positionMs, rate, now); }
    expect(Math.abs(quarters - 3600 * fps * 4)).toBeLessThanOrEqual(1);
    expect(cycles).toBe(Math.floor(quarters / 8));
    expect(maxErrorMs).toBeLessThanOrEqual(1000 / fps / 4 + 5);
  });
});

it('自动识别唯一有效接口，忽略系统合成器，并确实发送完整帧及四分之一帧', async () => {
  const send = vi.fn();
  const port = { name: 'USB MIDI', state: 'connected', connection: 'open', open: vi.fn(() => Promise.resolve()), send };
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['usb', port], ['synth', { ...port, name: 'Microsoft GS Wavetable Synth' }]]) }) });
  const output = new MediaMtcOutput();
  expect(await output.connect(null, true)).toBe('USB MIDI');
  expect(output.tick(120000, '30', 0)).toBe(true);
  expect(send.mock.calls.some(call => call[0][0] === 0xf0)).toBe(true);
  expect(send.mock.calls.some(call => call[0][0] === 0xf1)).toBe(true);
  output.stop();
});
it.each([0, 2])('自动识别有 %s 个输出时明确阻断，不随意选择', async count => {
  const open = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map(Array.from({ length: count }, (_, i) => [String(i), { name: `USB ${i}`, state: 'connected', open }])) }) });
  const output = new MediaMtcOutput();
  await expect(output.connect(null, true)).rejects.toThrow(count ? '多个 MIDI 输出' : '未检测到灯光 MIDI 输出');
  expect(open).not.toHaveBeenCalled();
  expect(output.tick(0, '30', 0)).toBe(false);
});
