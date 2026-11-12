import type { MidiPortEvent } from '@tb/schema';
import { afterEach, expect, it, vi } from 'vitest';
import { MidiPortBroker } from './midi-port-broker';
import type { NativeMidiMessage } from './native-midi-input';

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeOutput {
  readonly opened: string[] = [];
  readonly sent: { bytes: readonly number[]; deadline: bigint }[] = [];
  closes = 0;
  exit: Deferred | null = null;
  /** While set, the helper has not opened the port yet. */
  static opening: Deferred | null = null;
  constructor(readonly failed: (error: Error) => void) {}
  open(name: string): Promise<void> { this.opened.push(name); return FakeOutput.opening?.promise ?? Promise.resolve(); }
  send(bytes: readonly number[], deadline: bigint): Promise<void> { this.sent.push({ bytes, deadline }); return Promise.resolve(); }
  close(): Promise<void> { this.closes += 1; return this.exit?.promise ?? Promise.resolve(); }
}
class FakeInput {
  closes = 0;
  constructor(readonly receive: (message: NativeMidiMessage) => void, readonly failed: (error: Error) => void,
    readonly idle: (at100ns: bigint) => void) {}
  open(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { this.closes += 1; return Promise.resolve(); }
}

function closedReason(events: readonly MidiPortEvent[], handle: number): string | undefined {
  for (const event of events) if (event.kind === 'closed' && event.handle === handle) return event.reason;
  return undefined;
}

let broker: MidiPortBroker | null = null;
afterEach(async () => { FakeOutput.opening = null; await broker?.dispose(); broker = null; vi.useRealTimers(); });

function setup(ports = { midiInputs: [{ id: 0, name: 'P1 MTC' }], midiOutputs: [{ id: 0, name: 'USB MIDI Interface' }, { id: 1, name: 'Microsoft GS Wavetable Synth' }] },
  authorize: () => Promise<void> = () => Promise.resolve()) {
  const outputs: FakeOutput[] = [], inputs: FakeInput[] = [], events: MidiPortEvent[] = [];
  const list = vi.fn<(recheck: boolean) => Promise<typeof ports>>(() => Promise.resolve(ports));
  broker = new MidiPortBroker({
    authorize,
    list,
    createOutput: failed => { const output = new FakeOutput(failed); outputs.push(output); return output; },
    createInput: (receive, failed, _invalid, idle) => { const input = new FakeInput(receive, failed, idle); inputs.push(input); return input; },
    emit: event => { events.push(event); },
    log: () => undefined,
    now100ns: () => 1_000n,
    pollMs: 3000
  });
  return { broker, outputs, inputs, events, list };
}

it('同一接口只开一个驱动进程，最后一个使用者关闭后才关', async () => {
  const { broker, outputs } = setup();
  const first = await broker.open('output', 'USB MIDI Interface');
  const second = await broker.open('output', 'USB MIDI Interface');
  expect(outputs).toHaveLength(1);
  await broker.send(first, [0x90, 60, 100]);
  expect(outputs[0]!.sent).toEqual([{ bytes: [0x90, 60, 100], deadline: 1_000n + 19_000_000n }]);
  await broker.close(first);
  expect(outputs[0]!.closes).toBe(0);
  await broker.close(second);
  expect(outputs[0]!.closes).toBe(1);
  await expect(broker.send(second, [0x90, 60, 100])).rejects.toThrow('已关闭');
});

it('正式播放占用输出前先停掉界面里的使用，并在释放前拒绝界面再打开', async () => {
  const { broker, outputs, events } = setup();
  const handle = await broker.open('output', 'USB MIDI Interface');
  const claim = await broker.claimFormal('USB MIDI Interface', '时间码');
  expect(outputs[0]!.closes).toBe(1);
  expect(closedReason(events, handle)).toContain('发时间码');
  await expect(broker.open('output', 'USB MIDI Interface')).rejects.toThrow('正在播放的节目在用 MIDI 接口「USB MIDI Interface」发时间码');
  await expect(broker.open('input', 'USB MIDI Interface')).resolves.toBeGreaterThan(0);
  claim.release(); claim.release();
  await expect(broker.open('output', 'USB MIDI Interface')).resolves.toBeGreaterThan(0);
});

it('正式占用要等界面的驱动进程退出后才算接口空出来', async () => {
  const { broker, outputs } = setup();
  await broker.open('output', 'USB MIDI Interface');
  const exit = deferred(); outputs[0]!.exit = exit;
  let claimed = false;
  const claiming = broker.claimFormal('USB MIDI Interface', '动作 MIDI').then(claim => { claimed = true; return claim; });
  await Promise.resolve(); await Promise.resolve();
  expect(claimed).toBe(false);
  exit.resolve();
  const claim = await claiming;
  expect(claim.owner).toBe('动作 MIDI');
  claim.release();
});

it('同一输出被两个正式用途占用时能查到另一方', async () => {
  const { broker } = setup();
  const mtc = await broker.claimFormal('USB MIDI Interface', '时间码');
  const action = await broker.claimFormal('USB MIDI Interface', '动作 MIDI');
  expect(action.others()).toEqual(['时间码']);
  expect(mtc.others()).toEqual(['动作 MIDI']);
  mtc.release();
  expect(action.others()).toEqual([]);
  action.release();
});

it('接口检查占用时提示正在检查', async () => {
  const { broker } = setup();
  const check = await broker.claimFormal('USB MIDI Interface', '接口检查');
  await expect(broker.open('output', 'USB MIDI Interface')).rejects.toThrow('正在检查 MIDI 接口「USB MIDI Interface」');
  check.release();
});

it('驱动进程失败时通知所有持有者并关闭', async () => {
  const { broker, outputs, events } = setup();
  const handle = await broker.open('output', 'USB MIDI Interface');
  outputs[0]!.failed(new Error('MIDI 输出失败：接口已断开（错误码 5）'));
  await vi.waitFor(() => expect(outputs[0]!.closes).toBe(1));
  expect(events).toContainEqual({ version: 1, kind: 'closed', handle, reason: 'MIDI 输出失败：接口已断开（错误码 5）' });
  await expect(broker.send(handle, [0x90, 60, 100])).rejects.toThrow('已关闭');
  await broker.open('output', 'USB MIDI Interface');
  expect(outputs).toHaveLength(2);
});

it('输入消息转发给每个持有者并带上延迟', async () => {
  const { broker, inputs, events } = setup();
  const first = await broker.open('input', 'P1 MTC');
  const second = await broker.open('input', 'P1 MTC');
  inputs[0]!.receive({ bytes: [0xf1, 0x10], at100ns: 1_000n - 50_000n });
  expect(events.filter(event => event.kind === 'message')).toEqual([
    { version: 1, kind: 'message', handle: first, bytes: [0xf1, 0x10], ageMs: 5 },
    { version: 1, kind: 'message', handle: second, bytes: [0xf1, 0x10], ageMs: 5 }
  ]);
});

it('窗口刷新或退出时关掉它打开的所有接口', async () => {
  const { broker, outputs, inputs } = setup();
  const output = await broker.open('output', 'USB MIDI Interface');
  await broker.open('input', 'P1 MTC');
  await broker.releaseWindow();
  expect(outputs[0]!.closes).toBe(1);
  expect(inputs[0]!.closes).toBe(1);
  await expect(broker.send(output, [0x90, 60, 100])).rejects.toThrow('已关闭');
});

const ports = { midiInputs: [{ id: 0, name: 'P1 MTC' }], midiOutputs: [{ id: 0, name: 'USB MIDI Interface' }] };
const pageGone = '没有打开 MIDI 接口「P1 MTC」：要用它的界面已经重新加载或退出了';

it('界面打开接口还在等授权检查时重新加载：这次打开不再打开接口，也不留下没人用的占用（2026-11-10）', async () => {
  const authorization = deferred();
  const { broker, inputs } = setup(ports, () => authorization.promise);
  const opening = broker.open('input', 'P1 MTC');
  await broker.releaseWindow();
  authorization.resolve();
  await expect(opening).rejects.toThrow(pageGone);
  expect(inputs).toHaveLength(0);
});

it('旧界面的打开等授权时新界面打开了同一接口：新界面关掉后接口就关，不被旧界面占着（2026-11-10）', async () => {
  const authorization = deferred();
  let first = true;
  const { broker, inputs } = setup(ports, () => { if (!first) return Promise.resolve(); first = false; return authorization.promise; });
  const stale = broker.open('input', 'P1 MTC');
  await broker.releaseWindow();
  const fresh = await broker.open('input', 'P1 MTC');
  authorization.resolve();
  await expect(stale).rejects.toThrow(pageGone);
  expect(inputs).toHaveLength(1);
  await broker.close(fresh);
  expect(inputs[0]!.closes).toBe(1);
});

it('界面打开接口还在等接口打开时重新加载：接口关掉，这次打开说界面已经没了（2026-11-10）', async () => {
  FakeOutput.opening = deferred();
  const { broker, outputs } = setup(ports);
  const opening = broker.open('output', 'USB MIDI Interface');
  await vi.waitFor(() => expect(outputs[0]?.opened).toEqual(['USB MIDI Interface']));
  await broker.releaseWindow();
  FakeOutput.opening.resolve();
  await expect(opening).rejects.toThrow('没有打开 MIDI 接口「USB MIDI Interface」：要用它的界面已经重新加载或退出了');
  expect(outputs[0]!.closes).toBe(1);
  const fresh = await broker.open('output', 'USB MIDI Interface');
  await broker.close(fresh);
  expect(outputs.map(output => output.closes)).toEqual([1, 1]);
});

it('读取列表时去掉软件合成器，并定时刷新、关掉拔掉的接口', async () => {
  vi.useFakeTimers();
  const ports = { midiInputs: [{ id: 0, name: 'P1 MTC' }], midiOutputs: [{ id: 0, name: 'USB MIDI Interface' }, { id: 1, name: 'Microsoft GS Wavetable Synth' }] };
  const { broker, outputs, events, list } = setup(ports);
  const listed = await broker.listPorts(false);
  expect(listed.outputs).toEqual([{ id: 0, name: 'USB MIDI Interface' }]);
  expect(events.filter(event => event.kind === 'ports')).toHaveLength(1);
  const handle = await broker.open('output', 'USB MIDI Interface');
  ports.midiOutputs = [];
  await vi.advanceTimersByTimeAsync(3000);
  expect(list).toHaveBeenCalledTimes(2);
  expect(outputs[0]!.closes).toBe(1);
  expect(closedReason(events, handle)).toContain('已断开');
  expect(events.filter(event => event.kind === 'ports')).toHaveLength(2);
});

it('列表读取失败时通知窗口并停止自动刷新', async () => {
  vi.useFakeTimers();
  const { broker, events, list } = setup();
  await broker.listPorts(false);
  list.mockRejectedValueOnce(new Error('Windows MIDI 检查没有通过'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(events.at(-1)).toEqual({ version: 1, kind: 'ports-failed', reason: 'Windows MIDI 检查没有通过' });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list).toHaveBeenCalledTimes(2);
  await broker.listPorts(true);
  expect(list).toHaveBeenLastCalledWith(true);
});

function listener() {
  const heard: { message: NativeMidiMessage[]; idle: bigint[]; closed: string[] } = { message: [], idle: [], closed: [] };
  return { heard, listener: { message: (message: NativeMidiMessage) => { heard.message.push(message); }, idle: (at: bigint) => { heard.idle.push(at); },
    closed: (reason: string) => { heard.closed.push(reason); } } };
}

// 0.5.9 P3b, design 03 §4.1.5: the main process holds P1's MTC input itself; the window cannot open it meanwhile.
it('主进程占用 P1 时间码输入口：窗口原来的使用先停下，占用期间窗口打不开；消息和心跳带接口时间直接给主进程', async () => {
  const { broker, inputs, events } = setup();
  const windowHandle = await broker.open('input', 'P1 MTC');
  const { heard, listener: p1 } = listener();
  const claim = await broker.claimInput('P1 MTC', 'P1 时间码', p1);
  expect(closedReason(events, windowHandle)).toBe('正在跟随 P1，MIDI 接口「P1 MTC」要用来收P1 时间码，这里的 MIDI 已停止。停止跟随 P1 后再试。');
  expect(inputs).toHaveLength(2); expect(inputs[0]!.closes).toBe(1);
  await expect(broker.open('input', 'P1 MTC')).rejects.toThrow('MIDI 接口「P1 MTC」正在用作P1 时间码。停止跟随 P1 后再试。');
  inputs[1]!.receive({ bytes: [0xf1, 0x10], at100ns: 123n }); inputs[1]!.idle(1_123n);
  expect(heard.message).toEqual([{ bytes: [0xf1, 0x10], at100ns: 123n }]); expect(heard.idle).toEqual([1_123n]);
  // Nothing of it goes to the window.
  expect(events.filter(event => event.kind === 'message')).toEqual([]);
  // The window reloading does not take it.
  await broker.releaseWindow(); expect(inputs[1]!.closes).toBe(0);
  await expect(broker.claimInput('P1 MTC', 'P1 时间码', p1)).rejects.toThrow('已经在用作P1 时间码');
  await claim.release(); expect(inputs[1]!.closes).toBe(1); expect(heard.closed).toEqual([]);
  await broker.open('input', 'P1 MTC'); expect(inputs).toHaveLength(3);
});

it('占用的输入口：接口时间不晚于主进程此刻的照原样给；晚于此刻的（观察不会来自将来）按此刻给', async () => {
  const { broker, inputs } = setup();
  const { heard, listener: p1 } = listener();
  await broker.claimInput('P1 MTC', 'P1 时间码', p1);
  inputs[0]!.receive({ bytes: [0xf1, 0x10], at100ns: 999n });
  inputs[0]!.receive({ bytes: [0xf1, 0x20], at100ns: 1_000n });
  inputs[0]!.receive({ bytes: [0xf1, 0x30], at100ns: 1_003n });
  expect(heard.message).toEqual([{ bytes: [0xf1, 0x10], at100ns: 999n }, { bytes: [0xf1, 0x20], at100ns: 1_000n }, { bytes: [0xf1, 0x30], at100ns: 1_000n }]);
});

it('占用的输入口拔掉或驱动进程出错：告诉主进程，不自己重新打开；放手以前窗口照样打不开', async () => {
  vi.useFakeTimers();
  const ports = { midiInputs: [{ id: 0, name: 'P1 MTC' }], midiOutputs: [] };
  const { broker, inputs } = setup(ports);
  await broker.listPorts(false);
  const { heard, listener: p1 } = listener();
  const claim = await broker.claimInput('P1 MTC', 'P1 时间码', p1);
  ports.midiInputs = [];
  await vi.advanceTimersByTimeAsync(3000);
  expect(heard.closed).toEqual(['MIDI 接口「P1 MTC」已断开。重新插好后再打开。']);
  expect(inputs[0]!.closes).toBe(1);
  ports.midiInputs = [{ id: 0, name: 'P1 MTC' }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(inputs).toHaveLength(1);
  inputs[0]!.receive({ bytes: [0xf1, 0x10], at100ns: 1n }); expect(heard.message).toEqual([]);
  await expect(broker.open('input', 'P1 MTC')).rejects.toThrow('正在用作P1 时间码');
  await claim.release();
  const again = listener();
  await broker.claimInput('P1 MTC', 'P1 时间码', again.listener);
  inputs[1]!.failed(new Error('MIDI 输入服务异常退出：1'));
  await vi.advanceTimersByTimeAsync(0);
  expect(again.heard.closed).toEqual(['MIDI 输入服务异常退出：1']); expect(inputs).toHaveLength(2);
});

it('授权没通过时不占用输入口，窗口照常能打开', async () => {
  let allowed = false;
  const { broker, inputs } = setup(undefined, () => allowed ? Promise.resolve() : Promise.reject(new Error('授权已过期')));
  await expect(broker.claimInput('P1 MTC', 'P1 时间码', listener().listener)).rejects.toThrow('授权已过期');
  expect(inputs).toHaveLength(0);
  allowed = true;
  await broker.open('input', 'P1 MTC'); expect(inputs).toHaveLength(1);
});
