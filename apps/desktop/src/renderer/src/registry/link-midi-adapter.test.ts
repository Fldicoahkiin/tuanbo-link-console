import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkMidiAdapter, buildMidiShowControlMessage, hasConnectedProfilePort, type MidiPortProfile, type MidiPortSnapshot } from './link-midi-adapter';
import type { IntegrationProfile } from '@tb/schema';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  vi.useRealTimers();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('LinkMidiAdapter', () => {
  it('手动刷新重新申请端口会话并更新订阅，不沿用已失效的缓存', async () => {
    const oldAccess = midiAccess([]), freshAccess = midiAccess([]);
    Object.defineProperty(oldAccess.outputs.get('output')!, 'state', { value: 'disconnected' });
    const request = vi.fn<() => Promise<MIDIAccess>>().mockResolvedValueOnce(oldAccess).mockResolvedValue(freshAccess);
    installNavigator(oldAccess, request);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    const listener = vi.fn(); adapter.subscribePorts(listener);
    expect((await adapter.initialize()).find(port => port.direction === 'output')?.state).toBe('disconnected');
    expect((await adapter.refreshPorts()).find(port => port.direction === 'output')?.state).toBe('connected');
    expect(request).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ direction: 'output', state: 'connected' })]));
    listener.mockClear(); oldAccess.dispatchEvent(new Event('statechange'));
    expect(listener).not.toHaveBeenCalled();
    freshAccess.dispatchEvent(new Event('statechange')); expect(listener).toHaveBeenCalledOnce();
    adapter.dispose();
  });
  it('系统端口申请挂起时明确超时，允许操作员重新检测', async () => {
    vi.useFakeTimers();
    const access = midiAccess([]);
    const request = vi.fn<() => Promise<MIDIAccess>>().mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValue(access);
    installNavigator(access, request);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    const failed = expect(adapter.initialize()).rejects.toThrow('检测超时');
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(request).toHaveBeenCalledTimes(1);
    expect((await adapter.initialize()).length).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('IBC Note 脉冲保持 100ms 后释放，防止控台漏触发', async () => {
    vi.useFakeTimers(); const sent: number[][] = []; installNavigator(midiAccess(sent));
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
    const requestMIDIAccess = vi.fn(() => Promise.resolve(access));
    installNavigator(access, requestMIDIAccess);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());

    const [first, second] = await Promise.all([adapter.initialize(), adapter.initialize()]);

    expect(requestMIDIAccess).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(new Set(first.map((port) => `${port.direction}:${port.name}`))).toEqual(new Set(['input:P1 MTC', 'output:P1 Control']));
  });

  it('等待精确配置的 P1 MTC 输入出现后再返回', async () => {
    vi.useFakeTimers();
    const access = midiAccess([]);
    (access.inputs as unknown as Map<string, MIDIInput>).clear();
    installNavigator(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    const observed: MidiPortSnapshot[][] = [];
    const waiting = adapter.waitForConnectedInput('in', 1_000, (ports) => observed.push(ports));

    await vi.advanceTimersByTimeAsync(0);
    expect(observed.at(-1)?.some((port) => port.direction === 'input')).toBe(false);
    (access.inputs as unknown as Map<string, MIDIInput>).set('input', midiInput('input', 'P1 MTC'));
    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toBeUndefined();
    expect(observed.at(-1)?.find((port) => port.direction === 'input')).toMatchObject({ name: 'P1 MTC', state: 'connected' });
  });

  it('通过明确端口档案发送 Note、CC、Program 和 MSC', async () => {
    const sent: number[][] = [];
    const access = midiAccess(sent);
    installNavigator(access);
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

  it('MTC quarter-frame 使用本机单调时钟时间戳上报', async () => {
    const access = midiAccess([]);
    installNavigator(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    await adapter.initialize();
    const messages: Array<{ messageType: number; value: number; receivedAt: number }> = [];
    const unsubscribe = await adapter.subscribeMtc('in', '30', (message) => messages.push(message));
    const input = access.inputs.get('input');
    if (!input?.onmidimessage) throw new Error('测试 MIDI 输入没有监听器');
    input.onmidimessage({ data: new Uint8Array([0xf1, 0x34]) } as MIDIMessageEvent);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ messageType: 3, value: 4 });
    expect(messages[0]?.receivedAt).toBeTypeOf('number');
    expect((input as unknown as { open: ReturnType<typeof vi.fn> }).open).toHaveBeenCalledOnce();
    expect(adapter.hasActiveMtcSubscription('in')).toBe(true);
    unsubscribe();
    expect(adapter.hasActiveMtcSubscription('in')).toBe(false);
    expect((input as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
  });

  it('实际输入端口改变或断开后不复用旧 MTC 订阅', async () => {
    let inputName = 'P1 MTC';
    const access = midiAccess([]);
    const firstInput = access.inputs.get('input');
    if (!firstInput) throw new Error('测试 MIDI 输入不存在');
    installNavigator(access);
    const adapter = new LinkMidiAdapter((id) => id === 'in'
      ? { id, direction: 'input', portName: inputName }
      : resolveProfile(id), vi.fn());
    await adapter.initialize();
    await adapter.subscribeMtc('in', '30', vi.fn());
    expect(adapter.hasActiveMtcSubscription('in')).toBe(true);

    const secondInput = midiInput('input-2', 'P1 MTC 2');
    (access.inputs as unknown as Map<string, MIDIInput>).set('input-2', secondInput);
    inputName = 'P1 MTC 2';
    expect(adapter.hasActiveMtcSubscription('in')).toBe(false);

    inputName = 'P1 MTC';
    (firstInput as unknown as { state: MIDIPortDeviceState }).state = 'disconnected';
    expect(adapter.hasActiveMtcSubscription('in')).toBe(false);
  });

  it('缺失端口和非 ASCII MSC 字段明确失败', async () => {
    const access = midiAccess([]);
    installNavigator(access);
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
    })).rejects.toThrow('端口不存在');
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
    installNavigator(access);
    const adapter = new LinkMidiAdapter(resolveProfile, vi.fn());
    await adapter.initialize();
    const snapshots: string[][] = [];
    adapter.subscribePorts((ports) => snapshots.push(ports.map((port) => `${port.direction}:${port.name}`)));

    (access.outputs as unknown as Map<string, MIDIOutput>).delete('output');
    access.dispatchEvent(new Event('statechange'));

    expect(snapshots.at(-1)).toEqual(['input:P1 MTC']);
    await expect(adapter.execute({
      id: 'pc',
      label: 'Program',
      kind: 'midi.programChange',
      portProfileId: 'out',
      channel: 1,
      program: 1
    })).rejects.toThrow('MIDI 输出端口不存在：P1 Control');
    adapter.dispose();
    expect(access.onstatechange).toBeNull();
  });

  it('释放播放适配器不会移除顶部端口监视器的热插拔监听', async () => {
    const access = midiAccess([]); installNavigator(access);
    const monitor = new LinkMidiAdapter(resolveProfile, vi.fn());
    const runtime = new LinkMidiAdapter(resolveProfile, vi.fn());
    await monitor.initialize(); await runtime.initialize();
    const observed = vi.fn(); monitor.subscribePorts(observed);
    runtime.dispose();
    (access.outputs as unknown as Map<string, MIDIOutput>).clear();
    access.dispatchEvent(new Event('statechange'));
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ name: 'P1 MTC', direction: 'input' })]);
    monitor.dispose();
  });

  it('输入端口关闭失败会显式上报且释放状态监听', async () => {
    const access = midiAccess([]);
    const input = access.inputs.get('input');
    if (!input) throw new Error('测试 MIDI 输入不存在');
    const mockInput = input as unknown as { close: ReturnType<typeof vi.fn>; onmidimessage: EventListener | null };
    mockInput.close.mockRejectedValueOnce(new Error('设备正忙'));
    installNavigator(access);
    const reportedErrors: Error[] = [];
    const reportError = (error: Error): void => { reportedErrors.push(error); };
    const adapter = new LinkMidiAdapter(resolveProfile, reportError);
    await adapter.initialize();
    await adapter.subscribeMtc('in', '30', vi.fn());

    adapter.dispose();
    await vi.waitFor(() => expect(reportedErrors).toHaveLength(1));

    expect(reportedErrors[0]?.message).toContain('MIDI 输入端口关闭失败：P1 MTC：设备正忙');
    expect(access.onstatechange).toBeNull();
    expect(mockInput.onmidimessage).toBeNull();
  });
});

function installNavigator(
  access: MIDIAccess,
  requestMIDIAccess: () => Promise<MIDIAccess> = () => Promise.resolve(access)
): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { requestMIDIAccess }
  });
}

function midiAccess(sent: number[][]): MIDIAccess {
  const input = midiInput('input', 'P1 MTC');
  const output = {
    id: 'output',
    name: 'P1 Control',
    manufacturer: 'P1',
    state: 'connected',
    connection: 'open',
    send: (data: number[]) => sent.push([...data])
  } as unknown as MIDIOutput;
  return Object.assign(new EventTarget(), {
    inputs: new Map([['input', input]]),
    outputs: new Map([['output', output]]),
    sysexEnabled: true,
    onstatechange: null
  }) as unknown as MIDIAccess;
}

function midiInput(id: string, name: string): MIDIInput {
  const input = {
    id,
    name,
    manufacturer: 'P1',
    state: 'connected' as MIDIPortDeviceState,
    connection: 'closed' as MIDIPortConnectionState,
    onmidimessage: null as ((this: MIDIInput, ev: MIDIMessageEvent) => unknown) | null,
    open: vi.fn(() => {
      input.connection = 'open';
      return Promise.resolve(input as unknown as MIDIInput);
    }),
    close: vi.fn(() => {
      input.connection = 'closed';
      return Promise.resolve(input as unknown as MIDIInput);
    })
  };
  return input as unknown as MIDIInput;
}

function resolveProfile(id: string): MidiPortProfile | null {
  if (id === 'in') return { id, direction: 'input', portName: 'P1 MTC' };
  if (id === 'out') return { id, direction: 'output', portName: 'P1 Control' };
  return null;
}

function portSnapshot(id: string, name: string, state: MIDIPortDeviceState): import('./link-midi-adapter').MidiPortSnapshot {
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
