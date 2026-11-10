import { refreshMidiAccess, requestMidiAccess, type MidiAccess, type MidiInput, type MidiOutput, type MidiPort,
  type MidiPortConnectionState, type MidiPortDeviceState } from './midi-access';
import { requireOutputLicense } from './license-output';
import type { IntegrationProfile, LinkAction, MtcFrameRate } from '@tb/schema';
import { buildMidiShowControlMessage, encodeMidiAction, isMidiAction, midiMessageNeedsLicense, type LinkActionExecutor } from '@tb/core/link';
export { buildMidiShowControlMessage } from '@tb/core/link';

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
  state: MidiPortDeviceState;
  connection: MidiPortConnectionState;
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
  readonly id = 'windows-native-midi';
  private access: MidiAccess | null = null;
  private initialization: Promise<MidiAccess> | null = null;
  private generation = 0;
  private readonly portListeners = new Set<PortChangeListener>();
  private unsubscribeAccess: (() => void) | null = null;
  private reportedFailure: string | null = null;
  private mtcInput: { port: MidiInput; unsubscribe: () => void } | null = null;
  /** Outputs this adapter opened; closed again when it is released. */
  private readonly openedOutputs = new Set<MidiOutput>();

  constructor(
    private readonly resolvePortProfile: (profileId: string) => MidiPortProfile | null,
    private readonly reportError: (error: Error) => void
  ) {}

  supports(action: LinkAction): boolean {
    return action.kind.startsWith('midi.');
  }

  async initialize(): Promise<MidiPortSnapshot[]> {
    if (!this.access) {
      const generation = this.generation;
      const initialization = this.initialization ?? requestMidiAccess();
      this.initialization = initialization;
      let access: MidiAccess;
      try {
        access = await new Promise<MidiAccess>((resolve, reject) => {
          const timer = globalThis.setTimeout(() => reject(new Error('Windows MIDI 端口检测超时，请在设备设置中重新检测')), 5_000);
          initialization.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
        });
      } finally {
        if (this.initialization === initialization) this.initialization = null;
      }
      if (generation !== this.generation) throw new Error('MIDI 适配器已释放');
      this.attach(access);
    }
    return this.listPorts();
  }

  async refreshPorts(): Promise<MidiPortSnapshot[]> {
    if (this.mtcInput) throw new Error('MTC 输入正在使用，请停止联动后重新检测端口');
    if (this.initialization) throw new Error('正在检测 MIDI 端口，请等这次检测完成');
    this.generation++;
    const generation = this.generation;
    const access = await refreshMidiAccess();
    if (generation !== this.generation) throw new Error('MIDI 适配器已释放');
    this.attach(access);
    this.emitPorts();
    return this.listPorts();
  }

  private attach(access: MidiAccess): void {
    this.unsubscribeAccess?.();
    this.access = access; this.reportedFailure = null;
    this.unsubscribeAccess = access.onStateChange(() => {
      // A port list that cannot be read is reported once, not on every later change.
      if (access.failure && access.failure !== this.reportedFailure) this.reportError(new Error(access.failure));
      this.reportedFailure = access.failure;
      this.emitPorts();
    });
  }

  async openOutputs(profileIds: readonly string[]): Promise<string[]> {
    return this.openPorts(profileIds, 'output');
  }

  async openInputs(profileIds: readonly string[]): Promise<string[]> {
    return this.openPorts(profileIds, 'input');
  }

  private async openPorts(profileIds: readonly string[], direction: 'input' | 'output'): Promise<string[]> {
    await this.initialize();
    const issues: string[] = [];
    const opened = new Set<string>();
    for (const id of profileIds) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = direction === 'output' ? this.resolveOutput(id) : this.resolveInput(id);
        if (output.state !== 'connected') throw new Error(`MIDI 接口「${output.name}」已断开`);
        if (opened.has(output.id)) continue;
        await Promise.race([output.open(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`MIDI 接口「${output.name}」打开超时`)), 5000); })]);
        if (output.state !== 'connected') throw new Error(`MIDI 接口「${output.name}」已断开`);
        opened.add(output.id);
        if (direction === 'output') this.openedOutputs.add(this.resolveOutput(id));
      } catch (error) { issues.push(toMessage(error)); }
      finally { clearTimeout(timer); }
    }
    this.emitPorts();
    return issues;
  }

  async waitForConnectedInput(
    profileId: string,
    timeoutMs: number,
    onPorts: (ports: MidiPortSnapshot[]) => void
  ): Promise<void> {
    const profile = this.resolvePortProfile(profileId);
    if (!profile || profile.direction !== 'input' || profile.portName === '') {
      throw new Error('还没设置 P1 的 MTC 输入端口');
    }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const ports = await this.initialize();
      onPorts(ports);
      const matches = ports.filter((port) => port.direction === 'input' && port.name === profile.portName && port.state === 'connected');
      if (matches.length === 1) return;
      if (matches.length > 1) throw new Error(`有多个同名的 P1 MTC 输入端口「${profile.portName}」`);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error(`P1 MTC 输入端口「${profile.portName}」在 ${timeoutMs} ms 内没有准备好`);
  }

  dispose(): void {
    this.generation += 1;
    this.initialization = null;
    this.closeMtcInput();
    for (const output of this.openedOutputs) this.closePort(output);
    this.openedOutputs.clear();
    this.unsubscribeAccess?.(); this.unsubscribeAccess = null;
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
    if (this.mtcInput && this.mtcInput.port !== input) this.closeMtcInput();
    await input.open();
    this.mtcInput?.unsubscribe();
    const subscription = { port: input, unsubscribe: input.onMessage((event) => {
      const status = event.data[0];
      const data = event.data[1];
      if (status !== 0xf1 || data === undefined) return;
      listener({
        messageType: (data >> 4) & 0x07,
        value: data & 0x0f,
        // When the interface delivered it, not when it reached this window.
        receivedAt: event.receivedAt
      }, expectedFrameRate);
    }) };
    this.mtcInput = subscription;
    return () => {
      if (this.mtcInput === subscription) this.closeMtcInput();
    };
  }

  hasActiveMtcSubscription(profileId: string): boolean {
    if (!this.mtcInput || this.mtcInput.port.state !== 'connected' || this.mtcInput.port.connection !== 'open') return false;
    const profile = this.resolvePortProfile(profileId);
    if (!profile || profile.direction !== 'input' || !this.access) return false;
    const matches = [...this.access.inputs.values()].filter((port) => port.name === profile.portName);
    return matches.length === 1 && matches[0] === this.mtcInput.port;
  }

  async execute(action: LinkAction): Promise<void> {
    try {
      // Note Off and MSC Stop go out without a license; the playback program decides on the same bytes by the same rule.
      if (!isMidiAction(action) || midiMessageNeedsLicense(encodeMidiAction(action))) await requireOutputLicense();
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

  private resolveInput(profileId: string): MidiInput {
    const profile = this.requireProfile(profileId, 'input');
    const matches = this.access ? [...this.access.inputs.values()].filter((port) => port.name === profile.portName) : [];
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `MIDI 输入端口「${profile.portName}」不存在`
        : `有多个同名的 MIDI 输入端口「${profile.portName}」`);
    }
    const input = matches[0];
    if (!input) throw new Error(`MIDI 输入端口「${profile.portName}」不存在`);
    return input;
  }

  private closeMtcInput(): void {
    if (!this.mtcInput) return;
    const { port, unsubscribe } = this.mtcInput;
    unsubscribe();
    this.mtcInput = null;
    this.closePort(port);
  }

  private closePort(port: MidiPort): void {
    void port.close().catch((error: unknown) => {
      this.reportError(new Error(`MIDI 接口「${port.name}」关闭失败：${toMessage(error)}`, { cause: error }));
    });
  }

  private resolveOutput(profileId: string): MidiOutput {
    const profile = this.requireProfile(profileId, 'output');
    const matches = this.access ? [...this.access.outputs.values()].filter((port) => port.name === profile.portName) : [];
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `MIDI 输出端口「${profile.portName}」不存在`
        : `有多个同名的 MIDI 输出端口「${profile.portName}」`);
    }
    const output = matches[0];
    if (!output) throw new Error(`MIDI 输出端口「${profile.portName}」不存在`);
    return output;
  }

  private requireProfile(profileId: string, direction: MidiPortProfile['direction']): MidiPortProfile {
    const profile = this.resolvePortProfile(profileId);
    if (!profile) throw new Error(`找不到 MIDI 端口设置：${profileId}`);
    if (profile.direction !== direction) throw new Error(`MIDI 端口设置的方向不对：${profileId}`);
    if (!this.access) throw new Error('MIDI 还没初始化');
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

function portSnapshot(port: MidiPort, direction: MidiPortProfile['direction']): MidiPortSnapshot {
  return {
    id: port.id,
    name: port.name,
    manufacturer: port.manufacturer,
    direction,
    state: port.state,
    connection: port.connection
  };
}

