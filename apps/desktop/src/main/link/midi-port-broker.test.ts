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
  constructor(readonly failed: (error: Error) => void) {}
  open(name: string): Promise<void> { this.opened.push(name); return Promise.resolve(); }
  send(bytes: readonly number[], deadline: bigint): Promise<void> { this.sent.push({ bytes, deadline }); return Promise.resolve(); }
  close(): Promise<void> { this.closes += 1; return this.exit?.promise ?? Promise.resolve(); }
}
class FakeInput {
  closes = 0;
  constructor(readonly receive: (message: NativeMidiMessage) => void, readonly failed: (error: Error) => void) {}
  open(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { this.closes += 1; return Promise.resolve(); }
}

function closedReason(events: readonly MidiPortEvent[], handle: number): string | undefined {
  for (const event of events) if (event.kind === 'closed' && event.handle === handle) return event.reason;
  return undefined;
}

let broker: MidiPortBroker | null = null;
afterEach(async () => { await broker?.dispose(); broker = null; vi.useRealTimers(); });

function setup(ports = { midiInputs: [{ id: 0, name: 'P1 MTC' }], midiOutputs: [{ id: 0, name: 'USB MIDI Interface' }, { id: 1, name: 'Microsoft GS Wavetable Synth' }] }) {
  const outputs: FakeOutput[] = [], inputs: FakeInput[] = [], events: MidiPortEvent[] = [];
  const list = vi.fn<(recheck: boolean) => Promise<typeof ports>>(() => Promise.resolve(ports));
  broker = new MidiPortBroker({
    authorize: () => Promise.resolve(),
    list,
    createOutput: failed => { const output = new FakeOutput(failed); outputs.push(output); return output; },
    createInput: (receive, failed) => { const input = new FakeInput(receive, failed); inputs.push(input); return input; },
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
