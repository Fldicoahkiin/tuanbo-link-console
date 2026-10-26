import type { LinkDesktopBridgeApi } from '@tb/core/link';
import type { MidiPortEvent, MidiPortList } from '@tb/schema';

/** MIDI for this window. Ports are opened in the main process, one at a time and only while in use,
 * and formal playback takes an output back when it needs it. Chromium's Web MIDI is not used: it
 * opens every MIDI port of the computer for as long as the window uses MIDI, which kept
 * single-client USB interfaces from the playback engine and P1 (0.5.2, error 7). */

export type MidiPortDeviceState = 'connected' | 'disconnected';
export type MidiPortConnectionState = 'open' | 'closed' | 'pending';
/** `receivedAt`: `performance.now()` time at which the interface delivered the message. */
export type MidiMessage = { readonly data: Uint8Array; readonly receivedAt: number };
type Direction = 'input' | 'output';

export type MidiPort = {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly type: Direction;
  readonly state: MidiPortDeviceState;
  readonly connection: MidiPortConnectionState;
  /** Why an open port closed without being asked to: unplugged, failed, or taken by formal playback. */
  readonly closedReason: string | null;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Called when any port appears, disappears, opens or closes; returns the unsubscribe. */
  onStateChange(listener: () => void): () => void;
};
export type MidiOutput = MidiPort & {
  /** Queued in order; a failure closes the port and is reported through `closedReason`. */
  send(data: readonly number[]): void;
};
export type MidiInput = MidiPort & {
  onMessage(listener: (message: MidiMessage) => void): () => void;
};
export type MidiAccess = {
  readonly inputs: ReadonlyMap<string, MidiInput>;
  readonly outputs: ReadonlyMap<string, MidiOutput>;
  /** Why the port list could not be read; null while it is current. */
  readonly failure: string | null;
  onStateChange(listener: () => void): () => void;
};

type Bridge = Pick<LinkDesktopBridgeApi, 'listMidiPorts' | 'openMidiPort' | 'sendMidi' | 'closeMidiPort' | 'onMidiEvent'>;
type Entry = { key: string; name: string; type: Direction };

/** The window's one connection to main's MIDI. Each access and port object is the caller's own, as in
 * Web MIDI: closing it closes only the caller's use; main keeps the port open while anyone uses it. */
class MidiService {
  private list: MidiPortList | null = null;
  failure: string | null = null;
  private reading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  readonly opened = new Map<number, NativePort>();

  constructor(readonly bridge: Bridge) { bridge.onMidiEvent(event => this.receive(event)); }

  async access(recheck: boolean): Promise<MidiAccess> {
    if (recheck || !this.list) await this.read(recheck);
    return new NativeAccess(this);
  }
  entries(type: Direction): Entry[] {
    const seen = new Map<string, number>();
    return (type === 'input' ? this.list?.inputs : this.list?.outputs)?.map(port => {
      // Two interfaces of the same model share a name: they stay two ports, and opening either is refused as ambiguous.
      const count = (seen.get(port.name) ?? 0) + 1; seen.set(port.name, count);
      return { key: `${type}:${count}:${port.name}`, name: port.name, type };
    }) ?? [];
  }
  present(type: Direction, key: string): boolean { return this.entries(type).some(entry => entry.key === key); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(): void { for (const listener of [...this.listeners]) listener(); }

  private read(recheck: boolean): Promise<void> {
    if (this.reading && !recheck) return this.reading;
    const reading = this.bridge.listMidiPorts({ version: 1, recheck }).then(list => { this.apply(list); }, (error: unknown) => {
      this.fail(error instanceof Error ? error.message : String(error));
      throw error instanceof Error ? error : new Error(String(error));
    }).finally(() => { if (this.reading === reading) this.reading = null; });
    this.reading = reading;
    return reading;
  }
  private apply(list: MidiPortList): void {
    const changed = JSON.stringify(list) !== JSON.stringify(this.list) || this.failure !== null;
    this.list = list; this.failure = null;
    if (changed) this.notify();
  }
  /** Ports that cannot be listed are not shown as still there. */
  private fail(reason: string): void { this.list = null; this.failure = reason; this.notify(); }
  private receive(event: MidiPortEvent): void {
    switch (event.kind) {
      case 'ports': this.apply(event.ports); return;
      case 'ports-failed': this.fail(event.reason); return;
      case 'closed': this.opened.get(event.handle)?.lost(event.handle, event.reason, false); return;
      case 'message': this.opened.get(event.handle)?.deliver(event.bytes, event.ageMs); return;
    }
  }
}

class NativeAccess implements MidiAccess {
  private readonly ports = { input: new Map<string, NativePort>(), output: new Map<string, NativePort>() };
  constructor(private readonly service: MidiService) {}
  get inputs(): ReadonlyMap<string, MidiInput> { return this.sync('input'); }
  get outputs(): ReadonlyMap<string, MidiOutput> { return this.sync('output'); }
  get failure(): string | null { return this.service.failure; }
  onStateChange(listener: () => void): () => void { return this.service.subscribe(listener); }
  /** Like Web MIDI, a port that disappears stays listed as disconnected and the same object returns with it. */
  private sync(type: Direction): Map<string, NativePort> {
    const ports = this.ports[type];
    for (const entry of this.service.entries(type)) if (!ports.has(entry.key)) ports.set(entry.key, new NativePort(this.service, entry));
    return ports;
  }
}

class NativePort implements MidiInput, MidiOutput {
  readonly id: string;
  readonly name: string;
  readonly type: Direction;
  readonly manufacturer = '';
  connection: MidiPortConnectionState = 'closed';
  closedReason: string | null = null;
  private handle: number | null = null;
  private opening: Promise<void> | null = null;
  private readonly listeners = new Set<(message: MidiMessage) => void>();

  constructor(private readonly service: MidiService, private readonly entry: Entry) {
    this.id = entry.key; this.name = entry.name; this.type = entry.type;
  }
  get state(): MidiPortDeviceState { return this.service.present(this.type, this.entry.key) ? 'connected' : 'disconnected'; }

  open(): Promise<void> {
    if (this.connection === 'open') return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.state !== 'connected') return Promise.reject(new Error(`MIDI 接口「${this.name}」没有连接。请检查 USB 线和驱动。`));
    this.connection = 'pending'; this.closedReason = null;
    const opening: Promise<void> = this.service.bridge.openMidiPort({ version: 1, direction: this.type, portName: this.name }).then(result => {
      if (this.opening !== opening) {
        // Closed while it was opening: give the port back.
        this.release(result.handle);
        throw new Error(`MIDI 接口「${this.name}」在打开时被关闭`);
      }
      this.opening = null; this.handle = result.handle; this.connection = 'open';
      this.service.opened.set(result.handle, this); this.service.notify();
    }, (error: unknown) => {
      if (this.opening === opening) { this.opening = null; this.connection = 'closed'; this.service.notify(); }
      throw error instanceof Error ? error : new Error(String(error));
    });
    this.opening = opening;
    this.service.notify();
    return opening;
  }

  async close(): Promise<void> {
    const handle = this.handle, active = this.connection !== 'closed';
    this.opening = null; this.handle = null; this.connection = 'closed';
    if (handle !== null) this.service.opened.delete(handle);
    if (active) this.service.notify();
    if (handle !== null) await this.service.bridge.closeMidiPort({ version: 1, handle });
  }

  send(data: readonly number[]): void {
    if (this.type !== 'output') throw new Error('MIDI 输入不能发送消息');
    const handle = this.handle;
    if (handle === null || this.connection !== 'open') throw new Error(this.closedReason ?? `MIDI 接口「${this.name}」还没打开`);
    void this.service.bridge.sendMidi({ version: 1, handle, bytes: [...data] })
      .catch((error: unknown) => this.lost(handle, error instanceof Error ? error.message : String(error), true));
  }

  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onStateChange(listener: () => void): () => void { return this.service.subscribe(listener); }

  deliver(bytes: readonly number[], ageMs: number): void {
    const message: MidiMessage = { data: Uint8Array.from(bytes), receivedAt: performance.now() - ageMs };
    for (const listener of [...this.listeners]) listener(message);
  }
  /** The port stopped working for this caller. `release`: main may still count it as in use. */
  lost(handle: number, reason: string, release: boolean): void {
    if (this.handle !== handle) return;
    this.handle = null; this.connection = 'closed'; this.closedReason = reason;
    this.service.opened.delete(handle);
    if (release) this.release(handle);
    this.service.notify();
  }
  private release(handle: number): void {
    void this.service.bridge.closeMidiPort({ version: 1, handle })
      .catch((error: unknown) => console.error(`MIDI 接口「${this.name}」关闭失败`, error));
  }
}

let service: MidiService | null = null;
function midi(): MidiService { return service ??= new MidiService(window.tbLink); }

/** The ports as last read; reads them first when they never were, or when the last reading failed. */
export function requestMidiAccess(): Promise<MidiAccess> { return midi().access(false); }
/** Reads the ports again now, repeating a failed Windows MIDI check. */
export function refreshMidiAccess(): Promise<MidiAccess> { return midi().access(true); }
