import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./license-output', () => ({ requireOutputLicense: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./midi-access', () => ({ requestMidiAccess: vi.fn(), refreshMidiAccess: vi.fn() }));
import { LinkMidiAdapter, buildMidiShowControlMessage, hasConnectedProfilePort, type MidiPortProfile, type MidiPortSnapshot } from './link-midi-adapter';
import { refreshMidiAccess, requestMidiAccess, type MidiAccess, type MidiInput, type MidiMessage, type MidiOutput,
  type MidiPortConnectionState, type MidiPortDeviceState } from './midi-access';
import type { IntegrationProfile } from '@tb/schema';
import { toUserErrorMessage } from '@tb/core/link';

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(requestMidiAccess).mockReset(); vi.mocked(refreshMidiAccess).mockReset();
});

describe('LinkMidiAdapter', () => {
  it('手动刷新重新申请端口会话并更新订阅，不沿用已失效的缓存', async () => {
    const oldAccess = midiAccess([]), freshAccess = midiAccess([]);
    oldAccess.outputs.get('output')!.state = 'disconnected';
    installAccess(oldAccess); vi.mocked(refreshMidiAccess).mockResolvedValue(freshAccess);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    const listener = vi.fn(); adapter.subscribePorts(listener);
    expect((await adapter.initialize()).find(port => port.direction === 'output')?.state).toBe('disconnected');
    expect((await adapter.refreshPorts()).find(port => port.direction === 'output')?.state).toBe('connected');
    expect(requestMidiAccess).toHaveBeenCalledOnce(); expect(refreshMidiAccess).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ direction: 'output', state: 'connected' })]));
    listener.mockClear(); oldAccess.changed();
    expect(listener).not.toHaveBeenCalled();
    freshAccess.changed(); expect(listener).toHaveBeenCalledOnce();
    adapter.dispose();
  });
  it('系统端口申请挂起时明确超时，允许操作员重新检测', async () => {
    vi.useFakeTimers();
    const access = midiAccess([]);
    vi.mocked(requestMidiAccess).mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValue(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    const failed = expect(adapter.initialize()).rejects.toThrow('检测超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(requestMidiAccess).toHaveBeenCalledTimes(1);
    expect((await adapter.initialize()).length).toBeGreaterThan(0);
    expect(requestMidiAccess).toHaveBeenCalledTimes(2);
  });
  it('IBC Note 脉冲保持 100ms 后释放，防止控台漏触发', async () => {
    vi.useFakeTimers(); const sent: number[][] = []; installAccess(midiAccess(sent));
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn()); await adapter.initialize();
    const execution = adapter.execute({ id: 'pulse', label: '脉冲', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 127, durationMs: 100 });
    await vi.advanceTimersByTimeAsync(99); expect(sent).toEqual([[0x90, 60, 127]]);
    await vi.advanceTimersByTimeAsync(1); await execution; expect(sent).toEqual([[0x90, 60, 127], [0x80, 60, 0]]);
  });
  it('只把精确配置且唯一连接的 MIDI 端口视为就绪', () => {
    const profile = integrationProfile('P1 MTC');
    expect(hasConnectedProfilePort(profile, 'in', [portSnapshot('input-a', 'Other', 'connected')])).toBe(false);
    expect(hasConnectedProfilePort(profile, 'in', [portSnapshot('input-a', 'P1 MTC', 'disconnected')])).toBe(false);
    expect(hasConnectedProfilePort(profile, 'in', [
      portSnapshot('input-a', 'P1 MTC', 'connected'),
      portSnapshot('input-b', 'P1 MTC', 'connected')
    ])).toBe(false);
    expect(hasConnectedProfilePort(profile, 'in', [portSnapshot('input-a', 'P1 MTC', 'connected')])).toBe(true);
  });

  it('并发初始化只申请一次系统 MIDI 权限并共享最新端口', async () => {
    const access = midiAccess([]);
    installAccess(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());

    const [first, second] = await Promise.all([adapter.initialize(), adapter.initialize()]);

    expect(requestMidiAccess).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(new Set(first.map((port) => `${port.direction}:${port.name}`))).toEqual(new Set(['input:P1 MTC', 'output:P1 Control']));
  });

  it('等待精确配置的 P1 MTC 输入出现后再返回', async () => {
    vi.useFakeTimers();
    const access = midiAccess([]);
    access.inputs.clear();
    installAccess(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    const observed: MidiPortSnapshot[][] = [];
    const waiting = adapter.waitForConnectedInput('in', 1_000, (ports) => observed.push(ports));

    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)?.some((port) => port.direction === 'input')).toBe(false);
    access.inputs.set('input', new FakePort('input', 'P1 MTC', 'input', access));
    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toBeUndefined();
    expect(observed.at(-1)?.find((port) => port.direction === 'input')).toMatchObject({ name: 'P1 MTC', state: 'connected' });
  });

  it('通过明确端口档案发送 Note、CC、Program 和 MSC', async () => {
    const sent: number[][] = [];
    const access = midiAccess(sent);
    installAccess(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    await adapter.initialize();

    await adapter.execute({ id: 'on', label: 'Note On', kind: 'midi.noteOn', portProfileId: 'out', channel: 2, note: 60, velocity: 100 });
    await adapter.execute({ id: 'off', label: 'Note Off', kind: 'midi.noteOff', portProfileId: 'out', channel: 2, note: 60, velocity: 10 });
    await adapter.execute({ id: 'cc', label: 'CC', kind: 'midi.controlChange', portProfileId: 'out', channel: 1, controller: 7, value: 90 });
    await adapter.execute({ id: 'pc', label: 'PC', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 12 });
    await adapter.execute({
      id: 'msc',
      label: 'MSC GO',
      kind: 'midi.showControl',
      portProfileId: 'out',
      deviceId: 1,
      commandFormat: 0x10,
      command: 'go',
      cueNumber: '12',
      cueList: '3'
    });

    expect(sent).toEqual([
      [0x91, 60, 100],
      [0x81, 60, 10],
      [0xb0, 7, 90],
      [0xc0, 12],
      [0xf0, 0x7f, 1, 0x02, 0x10, 0x01, 49, 50, 0x00, 51, 0xf7]
    ]);
  });

  it('缺失端口和非 ASCII MSC 字段明确失败', async () => {
    const access = midiAccess([]);
    installAccess(access);
    const adapter = new LinkMidiAdapter((id) => id === 'missing'
      ? { id, direction: 'output', portName: 'Missing' }
      : resolveProfile(id), vi.fn());
    await adapter.initialize();
    await expect(adapter.execute({
      id: 'missing',
      label: 'missing',
      kind: 'midi.programChange',
      portProfileId: 'missing',
      channel: 1,
      program: 1
    })).rejects.toThrow('MIDI 输出端口「Missing」不存在');
    expect(() => buildMidiShowControlMessage({
      id: 'msc',
      label: 'MSC',
      kind: 'midi.showControl',
      portProfileId: 'out',
      deviceId: 1,
      commandFormat: 0x7f,
      command: 'go',
      cueNumber: '中文'
    })).toThrow('ASCII');
  });

  it.each([
    ['stop', 0x02],
    ['resume', 0x03],
    ['load', 0x05]
  ] as const)('编码 MSC %s 并保留显式 Command Format', (command, commandByte) => {
    expect(buildMidiShowControlMessage({
      id: 'msc',
      label: command,
      kind: 'midi.showControl',
      portProfileId: 'out',
      deviceId: 0x7f,
      commandFormat: 0x22,
      command,
      cueNumber: '1'
    })).toEqual([0xf0, 0x7f, 0x7f, 0x02, 0x22, commandByte, 49, 0xf7]);
  });

  it('端口消失时立即更新枚举，后续发送明确失败且不切换端口', async () => {
    const access = midiAccess([]);
    installAccess(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    await adapter.initialize();
    const snapshots: string[][] = [];
    adapter.subscribePorts((ports) => snapshots.push(ports.map((port) => `${port.direction}:${port.name}`)));

    access.outputs.delete('output');
    access.changed();

    expect(snapshots.at(-1)).toEqual(['input:P1 MTC']);
    await expect(adapter.execute({
      id: 'pc',
      label: 'Program',
      kind: 'midi.programChange',
      portProfileId: 'out',
      channel: 1,
      program: 1
    })).rejects.toThrow('MIDI 输出端口「P1 Control」不存在');
    adapter.dispose();
    expect(access.listeners.size).toBe(0);
  });

  it('接口名放在「」里：名字里有大写英文或 Timeout 时，提示照原样显示（2026-11-10）', async () => {
    vi.useFakeTimers();
    const access = new FakeAccess(); installAccess(access);
    const disconnected = new FakePort('a', 'USB MIDI INTERFACE', 'output', access); disconnected.state = 'disconnected';
    const stuck = new FakePort('b', 'Timeout Box', 'output', access); stuck.open.mockReturnValue(new Promise<void>(() => undefined));
    access.outputs.set('a', disconnected); access.outputs.set('b', stuck);
    access.inputs.set('c', new FakePort('c', 'MTC INPUT', 'input', access)); access.inputs.set('d', new FakePort('d', 'MTC INPUT', 'input', access));
    const profiles: Record<string, MidiPortProfile> = { gone: { id: 'gone', direction: 'output', portName: 'USB MIDI INTERFACE' },
      slow: { id: 'slow', direction: 'output', portName: 'Timeout Box' }, missing: { id: 'missing', direction: 'output', portName: 'HAPPY OUT' },
      twin: { id: 'twin', direction: 'input', portName: 'MTC INPUT' }, absent: { id: 'absent', direction: 'input', portName: 'NO SUCH INPUT' } };
    const adapter = new LinkMidiAdapter(id => profiles[id] ?? null, vi.fn());
    const opening = adapter.openOutputs(['gone', 'slow']);
    await vi.advanceTimersByTimeAsync(5000);
    const texts = [...await opening];
    const rejection = async (run: () => Promise<unknown>): Promise<string> => run().then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));
    texts.push(await rejection(() => adapter.execute({ id: 'pc', label: 'Program', kind: 'midi.programChange', portProfileId: 'missing', channel: 1, program: 1 })));
    texts.push(...await adapter.openInputs(['twin']), ...await adapter.openInputs(['absent']));
    texts.push(await rejection(() => adapter.waitForConnectedInput('twin', 1000, vi.fn())));
    access.inputs.delete('d'); access.inputs.get('c')!.state = 'disconnected';
    const waiting = rejection(() => adapter.waitForConnectedInput('twin', 1000, vi.fn()));
    await vi.advanceTimersByTimeAsync(1000);
    texts.push(await waiting);
    expect(texts).toEqual(['MIDI 接口「USB MIDI INTERFACE」已断开', 'MIDI 接口「Timeout Box」打开超时', 'MIDI 输出端口「HAPPY OUT」不存在',
      '有多个同名的 MIDI 输入端口「MTC INPUT」', 'MIDI 输入端口「NO SUCH INPUT」不存在', '有多个同名的 P1 MTC 输入端口「MTC INPUT」',
      'P1 MTC 输入端口「MTC INPUT」在 1000 ms 内没有准备好']);
    expect(texts.map(text => toUserErrorMessage(new Error(text)))).toEqual(texts);
    adapter.dispose();
  });

  it('输出端口重名、打开后断开时，提示也把接口名放在「」里且不被改写', async () => {
    const access = new FakeAccess(); installAccess(access);
    access.outputs.set('a', new FakePort('a', 'USB MIDI INTERFACE', 'output', access));
    access.outputs.set('b', new FakePort('b', 'USB MIDI INTERFACE', 'output', access));
    const dropping = new FakePort('c', 'Drop Box', 'output', access);
    dropping.open.mockImplementation(() => { dropping.state = 'disconnected'; return Promise.resolve(); });
    access.outputs.set('c', dropping);
    const profiles: Record<string, MidiPortProfile> = { twin: { id: 'twin', direction: 'output', portName: 'USB MIDI INTERFACE' },
      drop: { id: 'drop', direction: 'output', portName: 'Drop Box' } };
    const adapter = new LinkMidiAdapter(id => profiles[id] ?? null, vi.fn());
    await adapter.initialize();
    const duplicate = await adapter.execute({ id: 'pc', label: 'Program', kind: 'midi.programChange', portProfileId: 'twin', channel: 1, program: 1 })
      .then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));
    const texts = [duplicate, ...await adapter.openOutputs(['drop'])];
    expect(texts).toEqual(['有多个同名的 MIDI 输出端口「USB MIDI INTERFACE」', 'MIDI 接口「Drop Box」已断开']);
    expect(texts.map(text => toUserErrorMessage(new Error(text)))).toEqual(texts);
    adapter.dispose();
  });

  it('端口清单读取失败时明确上报一次，不当作端口仍在', async () => {
    const access = midiAccess([]); installAccess(access);
    const reportError = vi.fn();
    const adapter = new LinkMidiAdapter(resolveProfile, reportError);
    await adapter.initialize();
    access.failure = 'Windows MIDI 没有响应'; access.inputs.clear(); access.outputs.clear();
    access.changed(); access.changed();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({ message: 'Windows MIDI 没有响应' });
    expect(adapter.listPorts()).toEqual([]);
    adapter.dispose();
  });

  it('释放播放适配器只关闭自己打开的输出，不移除顶部端口监视器的热插拔监听', async () => {
    const access = midiAccess([]); installAccess(access);
    const monitor = new LinkMidiAdapter(resolveProfile, vi.fn());
    const runtime = new LinkMidiAdapter(resolveProfile, vi.fn());
    await monitor.initialize(); await runtime.initialize();
    const observed = vi.fn(); monitor.subscribePorts(observed);
    expect(await runtime.openOutputs(['out'])).toEqual([]);
    runtime.dispose();
    expect(access.outputs.get('output')!.close).toHaveBeenCalledOnce();
    access.outputs.clear();
    access.changed();
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ name: 'P1 MTC', direction: 'input' })]);
    monitor.dispose();
  });

  it('端口关闭失败会显式上报且释放状态监听', async () => {
    const access = midiAccess([]);
    const output = access.outputs.get('output');
    if (!output) throw new Error('测试 MIDI 输出不存在');
    output.close.mockRejectedValueOnce(new Error('设备正忙'));
    installAccess(access);
    const reportedErrors: Error[] = [];
    const reportError = (error: Error): void => { reportedErrors.push(error); };
    const adapter = new LinkMidiAdapter(resolveProfile, reportError);
    await adapter.initialize();
    expect(await adapter.openOutputs(['out'])).toEqual([]);

    adapter.dispose();
    await vi.waitFor(() => expect(reportedErrors).toHaveLength(1));

    expect(reportedErrors[0]?.message).toContain('MIDI 接口「P1 Control」关闭失败：设备正忙');
    expect(access.listeners.size).toBe(0);
  });
});

function installAccess(access: FakeAccess): void { vi.mocked(requestMidiAccess).mockResolvedValue(access); }

class FakeAccess implements MidiAccess {
  readonly inputs = new Map<string, FakePort>();
  readonly outputs = new Map<string, FakePort>();
  failure: string | null = null;
  readonly listeners = new Set<() => void>();
  onStateChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed(): void { for (const listener of [...this.listeners]) listener(); }
}

class FakePort implements MidiInput, MidiOutput {
  readonly manufacturer = 'P1';
  state: MidiPortDeviceState = 'connected';
  connection: MidiPortConnectionState = 'closed';
  closedReason: string | null = null;
  readonly listeners = new Set<(message: MidiMessage) => void>();
  readonly open = vi.fn(() => { this.connection = 'open'; return Promise.resolve(); });
  readonly close = vi.fn(() => { this.connection = 'closed'; return Promise.resolve(); });
  constructor(readonly id: string, readonly name: string, readonly type: 'input' | 'output', private readonly access: FakeAccess,
    private readonly sent: number[][] = []) {}
  send(data: readonly number[]): void { this.sent.push([...data]); }
  onMessage(listener: (message: MidiMessage) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStateChange(listener: () => void): () => void { return this.access.onStateChange(listener); }
  emit(bytes: number[], receivedAt: number): void { for (const listener of [...this.listeners]) listener({ data: Uint8Array.from(bytes), receivedAt }); }
}

function midiAccess(sent: number[][]): FakeAccess {
  const access = new FakeAccess();
  access.inputs.set('input', new FakePort('input', 'P1 MTC', 'input', access));
  const output = new FakePort('output', 'P1 Control', 'output', access, sent);
  output.connection = 'open';
  access.outputs.set('output', output);
  return access;
}

function resolveProfile(id: string): MidiPortProfile | null {
  if (id === 'in') return { id, direction: 'input', portName: 'P1 MTC' };
  if (id === 'out') return { id, direction: 'output', portName: 'P1 Control' };
  return null;
}

function portSnapshot(id: string, name: string, state: MidiPortDeviceState): import('./link-midi-adapter').MidiPortSnapshot {
  return { id, name, manufacturer: 'test', direction: 'input', state, connection: 'closed' };
}

function integrationProfile(inputPortName: string): IntegrationProfile {
  const executable = (executablePath: string) => ({
    executablePath,
    arguments: [],
    workingDirectory: executablePath.slice(0, executablePath.lastIndexOf('\\')),
    startupTimeoutMs: 20_000,
    shutdownTimeoutMs: 10_000
  });
  return {
    schemaVersion: 1,
    profileId: 'test',
    name: 'test',
    updatedAt: '2026-08-28T00:00:00.000Z',
    obs: { ...executable('C:\\OBS\\obs64.exe'), webSocketUrl: 'ws://127.0.0.1:4455', credentialId: 'obs-main' },
    p1: { ...executable('C:\\P1\\P1.exe'), mtcInputPortProfileId: 'in', controlOutputPortProfileId: 'out', expectedFrameRate: '30', obsAudioInputName: '' },
    midiPortProfiles: [{ id: 'in', direction: 'input', portName: inputPortName }],
    acceptedVersions: { obs: '1', p1: '1' }
  };
}
