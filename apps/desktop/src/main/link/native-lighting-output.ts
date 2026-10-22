import { compileLightingPackets, LightingNetworkOutput, LightingScheduler, type LightingOnAir, type LightingPacket,
  type LinkDesktopApi, type ProgramLightingOutput } from '@tb/core/link';
import type { IntegrationProfile, LightingDocument } from '@tb/schema';
import { NativeMidiPorts } from './native-midi-ports';

type Ports = Pick<NativeMidiPorts, 'prepare' | 'send' | 'close'>;
type Dependencies = {
  executable: string;
  network: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'cancelMa2Playback' | 'playMa2Cue'>;
  authorize(): Promise<void>;
  error(message: string): void;
  now?: () => number;
  ports?: (profile: IntegrationProfile | null, failed: (error: Error) => void) => Ports;
};

/** Direct lighting channel; native-timecode documents compile to no local
 * packets. A partial imported timeline can never become a substitute output. */
export class NativeLightingOutput implements ProgramLightingOutput {
  private readonly network: LightingNetworkOutput;
  private readonly now: () => number;
  private scheduler: LightingScheduler | null = null;
  private ports: Ports | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private failure: Error | null = null;
  private fault: string | null = null;
  private closing: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  private position = 0;
  private observedAt = 0;
  private ticked: number | null = null;
  private document: LightingDocument | null = null;
  /** What this song left on the console when it was paused or relocated. */
  private carried: { document: LightingDocument; onAir: LightingOnAir } | null = null;

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
    this.network = new LightingNetworkOutput(dependencies.network, error => dependencies.error(`灯光网络取消失败：${error.message}`));
  }

  async prepare(document: LightingDocument, profile: IntegrationProfile | null, positionMs: number): Promise<void> {
    this.stop();
    const generation = this.generation;
    await this.closing;
    if (generation !== this.generation) throw new Error('灯光准备已取消');
    this.failure = null;
    const packets = compileLightingPackets(document, profile?.lighting?.mscDeviceId ?? 127);
    const aborted = new AbortController(); this.abort = aborted;
    const failed = (error: Error) => { if (generation === this.generation) this.fail(error); else this.dependencies.error(`旧灯光会话：${error.message}`); };
    const ports = this.dependencies.ports?.(profile, failed) ?? new NativeMidiPorts(profile, {
      executable: this.dependencies.executable, authorize: () => this.dependencies.authorize(), failed
    });
    this.ports = ports;
    try {
      await ports.prepare([...new Set(packets.map(packet => packet.portProfileId))], aborted.signal);
      if (generation !== this.generation) throw new Error('灯光准备已取消');
      const restored = await this.network.prepare(document, positionMs, true);
      if (generation !== this.generation) throw new Error('灯光准备已取消');
      this.scheduler = new LightingScheduler(packets, packet => this.send(packet), this.carried?.document === document ? this.carried.onAir : undefined);
      this.document = document; this.carried = null;
      // Resume and seek rebuild the state at this position from the timeline;
      // only the differences go out now, before audio continues.
      this.position = positionMs; this.observedAt = this.now(); this.ticked = positionMs;
      const sent = restored + this.scheduler.restore(positionMs);
      if (sent) this.fault = `灯光按播放位置重建：发送 ${sent} 条，中间事件不补发`;
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
  }

  /** The program host must provide the QPC observation before consuming the
   * corresponding device position. UI wall-clock positions are not admitted. */
  observe(positionMs: number, observedAtMs: number): void {
    this.position = positionMs; this.observedAt = observedAtMs;
  }
  /** A stale observation sends nothing and is reported; the next fresh one
   * continues. Events inside the gap reach send(), which drops late starts. */
  tick(positionMs: number): void {
    this.requireClock(positionMs);
    const age = this.now() - this.observedAt;
    if (age > 100) { this.fault = `灯光音频时钟晚到 ${Math.round(age)}ms，本次位置未发送灯光，不补发`; return; }
    const gap = this.ticked === null ? 0 : positionMs - this.ticked; this.ticked = positionMs;
    if (gap > 100) {
      const sent = this.network.restore(positionMs) + (this.scheduler?.restore(positionMs) ?? 0);
      this.fault = `灯光位置更新中断 ${Math.round(gap)}ms：按当前位置重建，发送 ${sent} 条，中间事件不补发`; return;
    }
    this.network.tick(positionMs); this.scheduler?.tick(positionMs);
  }
  async finish(positionMs: number): Promise<void> {
    this.requireClock(positionMs); this.scheduler?.finish(positionMs);
    await Promise.all([this.network.finish(positionMs), ...this.pending]);
    if (this.failure) throw this.failure;
  }
  /** The latest live lighting fault since the previous call; the channel keeps running. */
  takeFault(): string | null {
    const fault = this.network.takeFault() ?? this.fault; this.fault = null; return fault;
  }

  /** The player stopped the song: nothing of it is assumed on air for the next play. */
  release(): Promise<void> { this.carried = null; this.document = null; this.network.forget(); return Promise.resolve(); }

  stop(): void {
    if (this.scheduler && this.document) this.carried = { document: this.document, onAir: this.scheduler.onAir() };
    this.generation++; this.abort?.abort(); this.abort = null; this.ticked = null;
    // The native port owns acknowledged notes. Closing it releases only those
    // notes, including an in-flight Note On whose acknowledgement arrived late.
    this.scheduler = null; this.network.stop();
    const ports = this.ports; this.ports = null;
    const previous = this.closing;
      const cleanup = [() => previous, () => this.network.close(), () => ports?.close(), ...[...this.pending].map(pending => () => pending)];
      this.closing = Promise.allSettled(cleanup.map(operation => Promise.resolve().then(operation))).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [toError(result.reason)] : []);
        if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('；'));
      });
      void this.closing.catch(error => this.dependencies.error(`灯光 MIDI 关闭失败：${toError(error).message}`));
  }
  async close(): Promise<void> { this.stop(); await this.closing; }

  private requireClock(positionMs: number): void {
    if (this.failure) throw this.failure;
    const age = this.now() - this.observedAt;
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs !== this.position || !Number.isFinite(age) || age < 0) {
      const error = new Error('灯光音频时钟无效或位置不一致，停止该通道，不补发'); this.fail(error); throw error;
    }
  }
  private send(packet: LightingPacket): void {
    const ports = this.ports;
    if (!ports || this.failure) throw this.failure ?? new Error('灯光 MIDI 尚未准备');
    if (this.pending.size >= 32) { this.fault = '灯光 MIDI 动作积压超过 32 条，本条未发送'; return; }
    const generation = this.generation, now = this.now();
    let deadline = this.observedAt + 100 - Math.max(0, this.position - packet.atMs);
    if (now > deadline) {
      // A late start is never sent. A late release still is, so nothing stays on.
      if (packet.phase !== 'off' && !packet.ma2Off) { this.fault = `灯光动作晚于 100ms 执行边界，未发送（${Math.round(now - deadline)}ms）`; return; }
      deadline = now + 100;
    }
    const sending = ports.send(packet.portProfileId, packet.bytes, deadline).catch(error => {
      if (generation === this.generation) this.fault = `灯光动作发送失败：${toError(error).message}`;
    }).finally(() => { this.pending.delete(sending); });
    this.pending.add(sending);
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error; this.dependencies.error(error.message); this.stop();
  }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
