import { midiPortListSchema, type MidiPortEvent, type MidiPortList } from '@tb/schema';
import type { NativeMidiMessage } from './native-midi-input';

type Port = { id: number; name: string };
type Output = { open(name: string): Promise<void>; send(bytes: readonly number[], deadline100ns: bigint): Promise<unknown>; close(): Promise<void> };
type Input = { open(name: string): Promise<void>; close(): Promise<void> };
type Direction = 'input' | 'output';
/** `reason`: why the channel ended while someone still held it. `claim`: the main process holds this input itself
 * (claimInput); then no window handle ever joins it. */
type Channel = { direction: Direction; name: string; handles: Set<number>; ready: Promise<void>; output: Output | null; input: Input | null; closed: boolean; reason: string | null;
  claim: MidiInputListener | null };

/** What in formal playback, or an explicit check, takes an output from the window. */
export type MidiClaimOwner = '时间码' | '动作 MIDI' | '接口检查';
/** An output held for formal use. `others`: who else in formal use holds the same output now. */
export type MidiClaim = { readonly owner: MidiClaimOwner; release(): void; others(): MidiClaimOwner[] };
/** What the main process takes an input for itself (design 03 §4.1.5): P1's MTC, which P1 follow reads in the main
 * process. Windows inputs are single-client, so the window cannot open it meanwhile. */
export type MidiInputClaimOwner = 'P1 时间码';
/** Everything of a claimed input: its messages and the helper's heartbeat on the interface's clock, and `closed`
 * when it ended without being released (unplugged, or the helper failed). It is not opened again by itself. */
export type MidiInputListener = { message(message: NativeMidiMessage): void; idle(at100ns: bigint): void; closed(reason: string): void };
export type MidiInputClaim = { readonly owner: MidiInputClaimOwner; release(): Promise<void> };

export type MidiPortBrokerDependencies = {
  /** License check before any port opens. */
  authorize(): Promise<void>;
  /** Windows MIDI inventory; `recheck` repeats a failed Windows MIDI check. */
  list(recheck: boolean): Promise<{ midiInputs: readonly Port[]; midiOutputs: readonly Port[] }>;
  createOutput(failed: (error: Error) => void): Output;
  /** `idle`: the helper's heartbeat (native-midi-input.ts); only a claimed input listens to it. */
  createInput(receive: (message: NativeMidiMessage) => void, failed: (error: Error) => void, invalid: (count: number) => void,
    idle: (at100ns: bigint) => void): Input;
  emit(event: MidiPortEvent): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
  now100ns?: () => bigint;
  pollMs?: number;
};

/** The software synthesizer has a known security issue and never reaches a console. */
const softwareSynth = /Microsoft GS Wavetable Synth/i;
/** A message from the window may wait behind a whole lighting state of SysEx; the helper accepts at most 2 s. */
const sendWindow100ns = 19_000_000n;

/** The single owner of every MIDI port the window uses. Each port is opened only while something
 * in the window uses it, by one helper process shared by all its users, and closed again when the
 * last one lets go. Formal playback always comes first: before it opens an output, the window's
 * use of that output is closed, and while it holds the output the window cannot open it. */
export class MidiPortBroker {
  private readonly channels = new Map<string, Channel>();
  private readonly handles = new Map<number, Channel>();
  /** Helpers still exiting, by channel key: the port is free only once they are gone. */
  private readonly exiting = new Map<string, Promise<void>>();
  /** Outputs formal playback holds: port name → claim → owner. */
  private readonly formal = new Map<string, Map<number, MidiClaimOwner>>();
  /** Inputs the main process holds itself: port name → owner. */
  private readonly inputClaims = new Map<string, MidiInputClaimOwner>();
  private nextHandle = 0;
  private nextClaim = 0;
  /** Counts the pages that went away (releaseWindow): an open still waiting when its page went belongs to nobody. */
  private page = 0;
  private listing: Promise<MidiPortList> | null = null;
  private emitted: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private disposed = false;
  private readonly now100ns: () => bigint;

  constructor(private readonly dependencies: MidiPortBrokerDependencies) {
    this.now100ns = dependencies.now100ns ?? (() => process.hrtime.bigint() / 100n);
  }

  /** Reads the ports now. After a success the list is read again every few seconds and changes are
   * sent to the window; after a failure only an explicit recheck reads it again. */
  listPorts(recheck: boolean): Promise<MidiPortList> {
    if (this.disposed) return Promise.reject(new Error('MIDI 服务已关闭'));
    if (this.listing && !recheck) return this.listing;
    const listing = this.read(recheck).finally(() => { if (this.listing === listing) this.listing = null; });
    this.listing = listing;
    return listing;
  }

  async open(direction: Direction, name: string): Promise<number> {
    if (this.disposed) throw new Error('MIDI 服务已关闭');
    // The page that asks can reload or exit while this waits. Its releaseWindow has then let go of all it held, and
    // what this open would add is held by nobody: it opens nothing, and the port of a new page is never kept open by it.
    const page = this.page;
    await this.dependencies.authorize();
    if (this.page !== page) throw new Error(pageGoneMessage(name));
    if (direction === 'output') this.requireFree(name);
    else this.requireInputFree(name);
    const key = `${direction}:${name}`;
    let channel = this.channels.get(key);
    if (!channel || channel.closed) channel = this.start(direction, name);
    await channel.ready;
    // The channel was in use when the page went, so releaseWindow shut it too: nothing of the gone page stays open.
    if (this.page !== page) throw new Error(pageGoneMessage(name));
    if (channel.closed || this.disposed) throw new Error(channel.reason ?? `MIDI 接口「${name}」已关闭`);
    const handle = ++this.nextHandle;
    channel.handles.add(handle); this.handles.set(handle, channel);
    return handle;
  }

  async send(handle: number, bytes: readonly number[]): Promise<void> {
    const channel = this.handles.get(handle);
    if (!channel || channel.closed) throw new Error('MIDI 接口已关闭，消息没有发出');
    if (!channel.output) throw new Error('MIDI 输入不能发送消息');
    await channel.output.send(bytes, this.now100ns() + sendWindow100ns);
  }

  async close(handle: number): Promise<void> {
    const channel = this.handles.get(handle);
    this.handles.delete(handle);
    if (!channel) return;
    channel.handles.delete(handle);
    if (!channel.handles.size && !channel.closed) await this.shut(channel, null);
  }

  /** Formal playback is about to open this output. The window's use of it ends first and the port is
   * free once this resolves; until the claim is released, the window cannot open it again. */
  async claimFormal(name: string, owner: MidiClaimOwner): Promise<MidiClaim> {
    const id = ++this.nextClaim;
    const claims = this.formal.get(name) ?? new Map<number, MidiClaimOwner>();
    claims.set(id, owner); this.formal.set(name, claims);
    const channel = this.channels.get(`output:${name}`);
    if (channel && !channel.closed) await this.shut(channel, takenMessage(name, owner));
    await this.exiting.get(`output:${name}`);
    let released = false;
    return { owner, others: () => [...this.formal.get(name) ?? []].filter(([claim]) => claim !== id).map(([, other]) => other),
      release: () => {
        if (released) return;
        released = true;
        const current = this.formal.get(name);
        current?.delete(id);
        if (current && !current.size) this.formal.delete(name);
      } };
  }

  /** The main process opens this input for itself (P1 follow, design 03 §4.1.5). The window's use of it ends first;
   * until the claim is released the window cannot open it. Opening waits for the license like any open. Resolves once
   * the input is open; a second claim of the same input is refused. Unplugged or failed, it ends with `closed` and
   * stays closed: only a new claim opens it again (the 2026-10-24 port recovery covers outputs, not this input). */
  async claimInput(name: string, owner: MidiInputClaimOwner, listener: MidiInputListener): Promise<MidiInputClaim> {
    if (this.disposed) throw new Error('MIDI 服务已关闭');
    const held = this.inputClaims.get(name);
    if (held) throw new Error(`MIDI 接口「${name}」已经在用作${held}`);
    // Reserved before anything is awaited: from here a window open of this input is refused.
    this.inputClaims.set(name, owner);
    let channel: Channel | null = null;
    try {
      await this.dependencies.authorize();
      if (this.disposed) throw new Error('MIDI 服务已关闭');
      const window = this.channels.get(`input:${name}`);
      if (window && !window.closed) await this.shut(window, inputTakenMessage(name, owner));
      const opened = channel = this.start('input', name, listener);
      await opened.ready;
      if (opened.closed || this.disposed) throw new Error(opened.reason ?? `MIDI 接口「${name}」已关闭`);
    } catch (error) {
      if (channel && !channel.closed) await this.shut(channel, null);
      this.inputClaims.delete(name);
      throw error instanceof Error ? error : new Error(String(error));
    }
    const claimed = channel;
    let released = false;
    return { owner, release: async () => {
      if (released) return;
      released = true;
      this.inputClaims.delete(name);
      await this.shut(claimed, null);
    } };
  }

  /** The window reloaded or exited: nothing it opened is in use any more. An input the main process claimed is not
   * the window's and stays (its owner lets it go). */
  async releaseWindow(): Promise<void> {
    this.page++;
    this.handles.clear();
    await Promise.all([...this.channels.values()].filter(channel => !channel.closed && !channel.claim).map(channel => this.shut(channel, null)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.releaseWindow();
    this.inputClaims.clear();
    await Promise.all([...this.channels.values()].filter(channel => !channel.closed).map(channel => this.shut(channel, null)));
  }

  private requireFree(name: string): void {
    const owners = [...this.formal.get(name)?.values() ?? []];
    if (owners.length) throw new Error(busyMessage(name, owners));
  }

  private requireInputFree(name: string): void {
    const owner = this.inputClaims.get(name);
    if (owner) throw new Error(inputBusyMessage(name, owner));
  }

  private start(direction: Direction, name: string, claim: MidiInputListener | null = null): Channel {
    const key = `${direction}:${name}`;
    const channel: Channel = { direction, name, handles: new Set(), ready: Promise.resolve(), output: null, input: null, closed: false, reason: null, claim };
    const failed = (error: Error) => { if (!channel.closed) void this.shut(channel, error.message); };
    let port: Output | Input;
    if (direction === 'output') port = channel.output = this.dependencies.createOutput(failed);
    else port = channel.input = this.dependencies.createInput(message => this.deliver(channel, message), failed,
      count => this.dependencies.log('warning', `MIDI 接口「${name}」送来 ${count} 条不完整的消息，已略过`),
      at100ns => { if (!channel.closed) channel.claim?.idle(at100ns); });
    this.channels.set(key, channel);
    // The helper of an earlier use of this port may still be exiting; until it has, the port is not free.
    channel.ready = (this.exiting.get(key) ?? Promise.resolve()).then(() => {
      if (channel.closed) throw new Error(channel.reason ?? `MIDI 接口「${name}」已关闭`);
      return port.open(name);
    }).then(() => {
      this.dependencies.log('info', `已打开 MIDI ${direction === 'output' ? '输出' : '输入'}「${name}」`);
    }, async (error: unknown) => {
      // An open that failed is not left half-owned: its helper exits before the error is reported.
      const reason = channel.reason;
      await this.shut(channel, null);
      throw reason ? new Error(reason) : error instanceof Error ? error : new Error(String(error));
    });
    return channel;
  }

  private deliver(channel: Channel, message: NativeMidiMessage): void {
    if (channel.closed) return;
    // The main process reads the interface's own timestamp; no age is worked out for it.
    if (channel.claim) { channel.claim.message(message); return; }
    const age = this.now100ns() - message.at100ns;
    const ageMs = age > 0n ? Math.min(600_000, Number(age) / 10_000) : 0;
    for (const handle of channel.handles) this.dependencies.emit({ version: 1, kind: 'message', handle, bytes: message.bytes, ageMs });
  }

  /** Ends a channel. `reason` is shown to every window user still holding it; null when nobody is left. */
  private async shut(channel: Channel, reason: string | null): Promise<void> {
    if (channel.closed) return;
    channel.closed = true; channel.reason = reason;
    const key = `${channel.direction}:${channel.name}`;
    if (this.channels.get(key) === channel) this.channels.delete(key);
    for (const handle of channel.handles) {
      this.handles.delete(handle);
      if (reason) this.dependencies.emit({ version: 1, kind: 'closed', handle, reason });
    }
    channel.handles.clear();
    if (reason) channel.claim?.closed(reason);
    if (reason) this.dependencies.log('warning', `MIDI ${channel.direction === 'output' ? '输出' : '输入'}「${channel.name}」已停止：${reason}`);
    const previous = this.exiting.get(key) ?? Promise.resolve();
    const exited = previous.then(() => (channel.output ?? channel.input)?.close()).catch((error: unknown) => {
      this.dependencies.log('error', `关闭 MIDI 接口「${channel.name}」未完成：${error instanceof Error ? error.message : String(error)}`);
    });
    this.exiting.set(key, exited);
    await exited;
    if (this.exiting.get(key) === exited) this.exiting.delete(key);
  }

  private async read(recheck: boolean): Promise<MidiPortList> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const devices = await this.dependencies.list(recheck);
      const list = midiPortListSchema.parse({ version: 1, inputs: devices.midiInputs.map(port => ({ id: port.id, name: port.name })),
        outputs: devices.midiOutputs.filter(port => !softwareSynth.test(port.name)).map(port => ({ id: port.id, name: port.name })) });
      if (this.disposed) return list;
      await this.closeMissing(list);
      const text = JSON.stringify(list);
      if (text !== this.emitted) { this.emitted = text; this.dependencies.emit({ version: 1, kind: 'ports', ports: list }); }
      this.polling = true; this.schedule();
      return list;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.polling) this.dependencies.log('error', `MIDI 接口列表读取失败，已停止自动刷新：${failure.message}`);
      this.polling = false; this.emitted = null;
      if (!this.disposed) this.dependencies.emit({ version: 1, kind: 'ports-failed', reason: failure.message });
      throw failure;
    }
  }

  /** An unplugged input sends nothing more and its helper does not notice; it is closed here. */
  private async closeMissing(list: MidiPortList): Promise<void> {
    const present = { input: new Set(list.inputs.map(port => port.name)), output: new Set(list.outputs.map(port => port.name)) };
    await Promise.all([...this.channels.values()].filter(channel => !channel.closed && !present[channel.direction].has(channel.name))
      .map(channel => this.shut(channel, `MIDI 接口「${channel.name}」已断开。重新插好后再打开。`)));
  }

  private schedule(): void {
    if (this.disposed || !this.polling || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.listPorts(false).catch(() => undefined);
    }, this.dependencies.pollMs ?? 3000);
  }
}

function takenMessage(name: string, owner: MidiClaimOwner): string {
  return owner === '接口检查' ? `正在检查 MIDI 接口「${name}」，这里的 MIDI 已停止。检查完成后再试。`
    : `正在播放的节目要用 MIDI 接口「${name}」发${owner}，这里的 MIDI 已停止。停止播放后再试。`;
}
function inputTakenMessage(name: string, owner: MidiInputClaimOwner): string {
  return `正在跟随 P1，MIDI 接口「${name}」要用来收${owner}，这里的 MIDI 已停止。停止跟随 P1 后再试。`;
}
function inputBusyMessage(name: string, owner: MidiInputClaimOwner): string {
  return `MIDI 接口「${name}」正在用作${owner}。停止跟随 P1 后再试。`;
}
function pageGoneMessage(name: string): string {
  return `没有打开 MIDI 接口「${name}」：要用它的界面已经重新加载或退出了。新界面要用时会自己再打开。`;
}
function busyMessage(name: string, owners: readonly MidiClaimOwner[]): string {
  const playback = owners.filter(owner => owner !== '接口检查');
  return playback.length ? `正在播放的节目在用 MIDI 接口「${name}」发${playback.join('、')}。停止播放后再试。`
    : `正在检查 MIDI 接口「${name}」。检查完成后再试。`;
}
