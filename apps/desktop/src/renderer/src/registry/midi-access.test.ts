import type { MidiPortEvent, MidiPortList } from '@tb/schema';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Module = typeof import('./midi-access');

const list = (outputs: string[], inputs: string[] = []): MidiPortList => ({ version: 1,
  inputs: inputs.map((name, id) => ({ id, name })), outputs: outputs.map((name, id) => ({ id, name })) });

function install(initial: MidiPortList) {
  let emit: (event: MidiPortEvent) => void = () => undefined;
  let nextHandle = 0;
  const bridge = {
    listMidiPorts: vi.fn(() => Promise.resolve(initial)),
    openMidiPort: vi.fn(() => Promise.resolve({ version: 1 as const, handle: ++nextHandle })),
    sendMidi: vi.fn(() => Promise.resolve()),
    closeMidiPort: vi.fn(() => Promise.resolve()),
    onMidiEvent: vi.fn((listener: (event: MidiPortEvent) => void) => { emit = listener; return () => undefined; })
  };
  vi.stubGlobal('window', { tbLink: bridge });
  return { bridge, emit: (event: MidiPortEvent) => emit(event) };
}

let midi: Module;
beforeEach(async () => { vi.resetModules(); midi = await import('./midi-access'); });
afterEach(() => vi.unstubAllGlobals());

it('读取接口列表不打开任何接口', async () => {
  const { bridge } = install(list(['USB MIDI Interface'], ['USB MIDI Interface']));
  const access = await midi.requestMidiAccess();
  expect([...access.outputs.values()].map(port => [port.name, port.state, port.connection])).toEqual([['USB MIDI Interface', 'connected', 'closed']]);
  expect([...access.inputs.values()].map(port => port.name)).toEqual(['USB MIDI Interface']);
  expect(bridge.listMidiPorts).toHaveBeenCalledWith({ version: 1, recheck: false });
  expect(bridge.openMidiPort).not.toHaveBeenCalled();
  await midi.requestMidiAccess();
  expect(bridge.listMidiPorts).toHaveBeenCalledTimes(1);
  await midi.refreshMidiAccess();
  expect(bridge.listMidiPorts).toHaveBeenLastCalledWith({ version: 1, recheck: true });
});

it('打开、发送、关闭只针对当前接口', async () => {
  const { bridge } = install(list(['USB MIDI Interface']));
  const port = [...(await midi.requestMidiAccess()).outputs.values()][0]!;
  await port.open();
  expect(bridge.openMidiPort).toHaveBeenCalledWith({ version: 1, direction: 'output', portName: 'USB MIDI Interface' });
  expect(port.connection).toBe('open');
  port.send([0x90, 60, 100]);
  expect(bridge.sendMidi).toHaveBeenCalledWith({ version: 1, handle: 1, bytes: [0x90, 60, 100] });
  await port.close();
  expect(bridge.closeMidiPort).toHaveBeenCalledWith({ version: 1, handle: 1 });
  expect(port.connection).toBe('closed');
  expect(() => port.send([0x90, 60, 100])).toThrow('还没打开');
});

it('打开过程中被关闭时归还接口', async () => {
  const { bridge } = install(list(['USB MIDI Interface']));
  const port = [...(await midi.requestMidiAccess()).outputs.values()][0]!;
  const opening = port.open();
  expect(port.connection).toBe('pending');
  await port.close();
  await expect(opening).rejects.toThrow('在打开时被关闭');
  expect(bridge.closeMidiPort).toHaveBeenCalledWith({ version: 1, handle: 1 });
  expect(port.connection).toBe('closed');
});

it('正式播放收回接口时显示原因', async () => {
  const { emit } = install(list(['USB MIDI Interface']));
  const access = await midi.requestMidiAccess();
  const changed = vi.fn(); access.onStateChange(changed);
  const port = [...access.outputs.values()][0]!;
  await port.open(); changed.mockClear();
  emit({ version: 1, kind: 'closed', handle: 1, reason: '正在播放的节目要用 MIDI 接口「USB MIDI Interface」发时间码' });
  expect(port.connection).toBe('closed');
  expect(port.closedReason).toContain('正在播放的节目');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(() => port.send([0x90, 60, 100])).toThrow('正在播放的节目');
});

it('发送失败时关闭该接口并归还', async () => {
  const { bridge } = install(list(['USB MIDI Interface']));
  bridge.sendMidi.mockRejectedValueOnce(new Error('MIDI 接口已关闭，消息没有发出'));
  const port = [...(await midi.requestMidiAccess()).outputs.values()][0]!;
  await port.open();
  port.send([0x90, 60, 100]);
  await vi.waitFor(() => expect(port.connection).toBe('closed'));
  expect(port.closedReason).toBe('MIDI 接口已关闭，消息没有发出');
  expect(bridge.closeMidiPort).toHaveBeenCalledWith({ version: 1, handle: 1 });
});

it('收到的消息带上接口收到的时间', async () => {
  const { emit } = install(list([], ['P1 MTC']));
  const input = [...(await midi.requestMidiAccess()).inputs.values()][0]!;
  await input.open();
  const received = vi.fn(); input.onMessage(received);
  const before = performance.now();
  emit({ version: 1, kind: 'message', handle: 1, bytes: [0xf1, 0x10], ageMs: 5 });
  const message = received.mock.calls[0]![0] as { data: Uint8Array; receivedAt: number };
  expect([...message.data]).toEqual([0xf1, 0x10]);
  expect(message.receivedAt).toBeLessThanOrEqual(performance.now() - 5);
  expect(message.receivedAt).toBeGreaterThanOrEqual(before - 5);
});

it('拔掉的接口显示为断开，插回后还是同一个对象', async () => {
  const { emit } = install(list(['USB MIDI Interface']));
  const access = await midi.requestMidiAccess();
  const port = [...access.outputs.values()][0]!;
  emit({ version: 1, kind: 'ports', ports: list([]) });
  expect(port.state).toBe('disconnected');
  await expect(port.open()).rejects.toThrow('没有连接');
  emit({ version: 1, kind: 'ports', ports: list(['USB MIDI Interface']) });
  expect(port.state).toBe('connected');
  expect([...access.outputs.values()]).toEqual([port]);
});

it('同名的两个接口分开列出', async () => {
  install(list(['USB MIDI Interface', 'USB MIDI Interface']));
  const ports = [...(await midi.requestMidiAccess()).outputs.values()];
  expect(ports.map(port => port.name)).toEqual(['USB MIDI Interface', 'USB MIDI Interface']);
  expect(new Set(ports.map(port => port.id)).size).toBe(2);
});

it('列表读取失败时不再显示旧接口，并给出原因', async () => {
  const { emit } = install(list(['USB MIDI Interface']));
  const access = await midi.requestMidiAccess();
  const port = [...access.outputs.values()][0]!;
  emit({ version: 1, kind: 'ports-failed', reason: 'Windows MIDI 检查没有通过' });
  expect(access.failure).toBe('Windows MIDI 检查没有通过');
  expect(port.state).toBe('disconnected');
});
