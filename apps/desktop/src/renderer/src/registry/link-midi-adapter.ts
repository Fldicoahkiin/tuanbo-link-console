import type { IntegrationProfile, LinkAction, MtcFrameRate } from '@tb/schema';
import type { LinkActionExecutor } from '@tb/core/link';

export type MidiPortProfile = {
  id: string;
  direction: 'input' | 'output';
  portName: string;
};

export type MidiPortSnapshot = {
  id: string;
  name: string;
  manufacturer: string;
  direction: 'input' | 'output';
  state: MIDIPortDeviceState;
  connection: MIDIPortConnectionState;
};

export type MtcQuarterFrameMessage = {
  messageType: number;
  value: number;
  receivedAt: number;
};

export function hasConnectedProfilePort(
  profile: IntegrationProfile,
  profileId: string,
  ports: readonly MidiPortSnapshot[]
): boolean {
  const configured = profile.midiPortProfiles.find((port) => port.id === profileId);
  if (!configured || configured.portName === '') return false;
  return ports.filter((port) => (
    port.direction === configured.direction
    && port.name === configured.portName
    && port.state === 'connected'
  )).length === 1;
}

type PortChangeListener = (ports: MidiPortSnapshot[]) => void;

export class LinkMidiAdapter implements LinkActionExecutor {
  readonly id = 'windows-web-midi';
  private access: MIDIAccess | null = null;
  private initialization: Promise<MIDIAccess> | null = null;
  private generation = 0;
  private readonly portListeners = new Set<PortChangeListener>();
  private readonly onPortsChanged = (): void => this.emitPorts();
  private mtcInput: MIDIInput | null = null;

  constructor(
    private readonly resolvePortProfile: (profileId: string) => MidiPortProfile | null,
    private readonly reportError: (error: Error) => void
  ) {}

  supports(action: LinkAction): boolean {
    return action.kind.startsWith('midi.');
  }

  async initialize(): Promise<MidiPortSnapshot[]> {
    if (!navigator.requestMIDIAccess) throw new Error('当前 Electron 环境不支持 Web MIDI');
    if (!this.access) {
      const generation = this.generation;
      const initialization = this.initialization ?? navigator.requestMIDIAccess({ sysex: true });
      this.initialization = initialization;
      let access: MIDIAccess;
      try {
        access = await new Promise<MIDIAccess>((resolve, reject) => {
          const timer = globalThis.setTimeout(() => reject(new Error('Windows MIDI 端口检测超时，请在设备设置中重新检测')), 5_000);
          initialization.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
        });
      } finally {
        if (this.initialization === initialization) this.initialization = null;
      }
      if (generation !== this.generation) throw new Error('MIDI 适配器已释放');
      this.access = access;
    }
    this.access.addEventListener('statechange', this.onPortsChanged);
    return this.listPorts();
  }

  async waitForConnectedInput(
    profileId: string,
    timeoutMs: number,
    onPorts: (ports: MidiPortSnapshot[]) => void
  ): Promise<void> {
    const profile = this.resolvePortProfile(profileId);
    if (!profile || profile.direction !== 'input' || profile.portName === '') {
      throw new Error('尚未配置 P1 MTC 输入端口');
    }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const ports = await this.initialize();
      onPorts(ports);
      const matches = ports.filter((port) => port.direction === 'input' && port.name === profile.portName && port.state === 'connected');
      if (matches.length === 1) return;
      if (matches.length > 1) throw new Error(`P1 MTC 输入端口名称不唯一：${profile.portName}`);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error(`P1 MTC 输入端口在 ${timeoutMs}ms 内未就绪：${profile.portName}`);
  }

  dispose(): void {
    this.generation += 1;
    this.initialization = null;
    this.closeMtcInput();
    this.access?.removeEventListener('statechange', this.onPortsChanged);
    this.access = null;
    this.portListeners.clear();
  }

  subscribePorts(listener: PortChangeListener): () => void {
    this.portListeners.add(listener);
    listener(this.listPorts());
    return () => this.portListeners.delete(listener);
  }

  listPorts(): MidiPortSnapshot[] {
    if (!this.access) return [];
    const ports: MidiPortSnapshot[] = [];
    for (const input of this.access.inputs.values()) ports.push(portSnapshot(input, 'input'));
    for (const output of this.access.outputs.values()) ports.push(portSnapshot(output, 'output'));
    return ports.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  async subscribeMtc(
    profileId: string,
    expectedFrameRate: MtcFrameRate,
    listener: (message: MtcQuarterFrameMessage, expectedFrameRate: MtcFrameRate) => void
  ): Promise<() => void> {
    const input = this.resolveInput(profileId);
    if (this.mtcInput && this.mtcInput !== input) this.closeMtcInput();
    await input.open();
    this.mtcInput = input;
    input.onmidimessage = (event) => {
      const message = event.data;
      if (!message) return;
      const status = message[0];
      const data = message[1];
      if (status !== 0xf1 || data === undefined) return;
      listener({
        messageType: (data >> 4) & 0x07,
        value: data & 0x0f,
        receivedAt: performance.now()
      }, expectedFrameRate);
    };
    return () => {
      if (this.mtcInput === input) this.closeMtcInput();
    };
  }

  hasActiveMtcSubscription(profileId: string): boolean {
    if (!this.mtcInput || this.mtcInput.state !== 'connected' || this.mtcInput.connection !== 'open' || this.mtcInput.onmidimessage === null) {
      return false;
    }
    const profile = this.resolvePortProfile(profileId);
    if (!profile || profile.direction !== 'input' || !this.access) return false;
    const matches = [...this.access.inputs.values()].filter((port) => port.name === profile.portName);
    return matches.length === 1 && matches[0] === this.mtcInput;
  }

  async execute(action: LinkAction): Promise<void> {
    try {
      this.executeSynchronous(action);
      if (action.kind === 'midi.noteOn' && action.durationMs !== undefined) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, action.durationMs));
        this.send(action.portProfileId, [0x80 + action.channel - 1, action.note, 0]);
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private executeSynchronous(action: LinkAction): void {
    if (!this.supports(action)) throw new Error(`MIDI 适配器不支持 ${action.kind}`);
    switch (action.kind) {
      case 'midi.noteOn':
        this.send(action.portProfileId, [0x90 + action.channel - 1, action.note, action.velocity]);
        return;
      case 'midi.noteOff':
        this.send(action.portProfileId, [0x80 + action.channel - 1, action.note, action.velocity]);
        return;
      case 'midi.controlChange':
        this.send(action.portProfileId, [0xb0 + action.channel - 1, action.controller, action.value]);
        return;
      case 'midi.programChange':
        this.send(action.portProfileId, [0xc0 + action.channel - 1, action.program]);
        return;
      case 'midi.showControl':
        this.send(action.portProfileId, buildMidiShowControlMessage(action));
        return;
      case 'obs.setProgramScene':
      case 'obs.setSceneItemEnabled':
      case 'obs.setSceneItemTransform':
      case 'obs.setSceneItemIndex':
      case 'obs.setSourceFilterEnabled':
      case 'obs.setInputMute':
      case 'obs.setInputVolume':
      case 'obs.mediaAction':
      case 'obs.setTransition':
      case 'obs.saveSourceScreenshot':
        throw new Error(`MIDI 适配器不支持 ${action.kind}`);
    }
  }

  private send(profileId: string, data: number[]): void {
    const output = this.resolveOutput(profileId);
    output.send(data);
  }

  private resolveInput(profileId: string): MIDIInput {
    const profile = this.requireProfile(profileId, 'input');
    const matches = this.access ? [...this.access.inputs.values()].filter((port) => port.name === profile.portName) : [];
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `MIDI 输入端口不存在：${profile.portName}`
        : `MIDI 输入端口名称不唯一：${profile.portName}`);
    }
    const input = matches[0];
    if (!input) throw new Error(`MIDI 输入端口不存在：${profile.portName}`);
    return input;
  }

  private closeMtcInput(): void {
    if (!this.mtcInput) return;
    const input = this.mtcInput;
    input.onmidimessage = null;
    this.mtcInput = null;
    void input.close().catch((error: unknown) => {
      this.reportError(new Error(`MIDI 输入端口关闭失败：${input.name ?? input.id}：${toMessage(error)}`, { cause: error }));
    });
  }

  private resolveOutput(profileId: string): MIDIOutput {
    const profile = this.requireProfile(profileId, 'output');
    const matches = this.access ? [...this.access.outputs.values()].filter((port) => port.name === profile.portName) : [];
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `MIDI 输出端口不存在：${profile.portName}`
        : `MIDI 输出端口名称不唯一：${profile.portName}`);
    }
    const output = matches[0];
    if (!output) throw new Error(`MIDI 输出端口不存在：${profile.portName}`);
    return output;
  }

  private requireProfile(profileId: string, direction: MidiPortProfile['direction']): MidiPortProfile {
    const profile = this.resolvePortProfile(profileId);
    if (!profile) throw new Error(`MIDI 端口档案不存在：${profileId}`);
    if (profile.direction !== direction) throw new Error(`MIDI 端口档案方向错误：${profileId}`);
    if (!this.access) throw new Error('MIDI 尚未初始化');
    return profile;
  }

  private emitPorts(): void {
    const ports = this.listPorts();
    for (const listener of this.portListeners) listener(ports);
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function portSnapshot(port: MIDIPort, direction: MidiPortProfile['direction']): MidiPortSnapshot {
  return {
    id: port.id,
    name: port.name ?? '(未命名端口)',
    manufacturer: port.manufacturer ?? '',
    direction,
    state: port.state,
    connection: port.connection
  };
}

export function buildMidiShowControlMessage(action: Extract<LinkAction, { kind: 'midi.showControl' }>): number[] {
  const command = {
    go: 0x01,
    stop: 0x02,
    resume: 0x03,
    load: 0x05
  }[action.command];
  const fields = [action.cueNumber, action.cueList, action.cuePath];
  let lastField = -1;
  for (const [index, field] of fields.entries()) {
    if (field !== undefined) lastField = index;
  }
  const payload: number[] = [];
  for (let index = 0; index <= lastField; index += 1) {
    if (index > 0) payload.push(0x00);
    payload.push(...toSevenBitAscii(fields[index] ?? ''));
  }
  return [0xf0, 0x7f, action.deviceId, 0x02, action.commandFormat, command, ...payload, 0xf7];
}

function toSevenBitAscii(value: string): number[] {
  return [...value].map((character) => {
    const code = character.codePointAt(0);
    if (code === undefined || code > 0x7f) throw new Error('MIDI Show Control 字段只能使用 ASCII 字符');
    return code;
  });
}
