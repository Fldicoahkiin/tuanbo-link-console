import { MidiProgramSession } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiPorts } from './native-midi-ports';
import { MidiOutputFailure } from './native-midi-output';
import { MidiPortRecovery, type PortRecoveryReport } from './midi-port-recovery';

type Identity = Pick<NativePlayerStatus, 'sessionId' | 'generation' | 'itemId'>;
/** The action MIDI port came back: the outage, how many actions it skipped, and the red message it showed. */
export type ActionMidiRecovery = PortRecoveryReport & { skippedActions: number; fault: string };
export type NativeMidiChannelState = Identity & { state: 'preparing' | 'ready' | 'running' | 'stopped' | 'failed'; reason: string | null;
  currentCueId: string | null };
type Ports = Pick<NativeMidiPorts, 'prepare' | 'send' | 'close'>;
type Dependencies = {
  audio(): NativePlayerStatus | null;
  profile(): IntegrationProfile | null;
  executable: string;
  authorize(): Promise<void>;
  changed(state: NativeMidiChannelState): void;
  error(message: string): void;
  /** Actions of this song that were skipped; the channel keeps running. */
  fault(message: string, itemId: string): void;
  /** Windows MIDI outputs as listed now; a failed listing is checked again on the next call. */
  outputs(): Promise<readonly { id: number; name: string }[]>;
  /** The lost port is back and this song's later actions go out again. */
  recovered(report: ActionMidiRecovery, itemId: string): void;
  now?: () => number;
  ports?: (failed: (error: Error) => void) => Ports;
};
/** `resumed`: opened after its port came back, skipping `skipped` actions; `sent`: an action of it went out. */
type Entry = { identity: Identity; session: MidiProgramSession; state: NativeMidiChannelState; resumed: boolean; skipped: number; sent: boolean };
/** The playing song whose port was lost: its failed session (where the outage began) and the red message shown. */
type Lost = { project: LinkProject; identity: Identity; session: MidiProgramSession; fault: string };

/** Program-owned generic MIDI. Receives only NativePlayerService observations,
 * never renderer positions or an independent playback timer. */
export class NativeMidiHost {
  private entry: Entry | null = null;
  private epoch = 0;
  private stopped: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  /** The playing song whose port was lost; its actions continue once the same port is back (authorised 2026-10-24). */
  private lost: Lost | null = null;
  private readonly recovery: MidiPortRecovery;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
    this.recovery = new MidiPortRecovery({ subject: '动作 MIDI 端口', list: () => dependencies.outputs(), reopen: () => this.resume(),
      active: () => this.resumable() !== null,
      recovered: report => {
        const lost = this.lost; this.lost = null;
        if (lost) dependencies.recovered({ ...report, skippedActions: this.entry?.skipped ?? 0, fault: lost.fault }, lost.identity.itemId);
      }, log: message => dependencies.error(message) });
  }
  get status(): NativeMidiChannelState | null { return this.entry?.state ?? null; }

  async prepare(project: LinkProject, identity: Identity): Promise<void> {
    this.admit(identity);
    const stopped = this.stop(), epoch = this.epoch;
    // The old driver has exited or was reported as kept; its failure does not decide this song.
    try { await stopped; } catch (error) { this.dependencies.error(`上一首 MIDI 会话关闭失败：${toError(error).message}`); }
    if (epoch !== this.epoch) throw new Error('后台 MIDI 准备已被更新操作取消');
    const audio = this.admit(identity);
    await this.open(project, identity, audio.positionMs, epoch, null);
  }

  /** `outage`: the failed session this one resumes after its port came back. */
  private async open(project: LinkProject, identity: Identity, positionMs: number, epoch: number, outage: MidiProgramSession | null): Promise<void> {
    let entry: Entry | null = null;
    const failed = (error: Error) => {
      if (!entry || this.entry !== entry) { this.dependencies.error(`旧 MIDI 会话：${error.message}`); return; }
      // The port is gone, or a port just opened again failed before its first action (Windows was
      // still creating it): wait for the same port again. Either way the rest of this attempt is off.
      if (error instanceof MidiOutputFailure && (error.portGone || entry.resumed && !entry.sent)) {
        const fault = entry.resumed && !entry.sent ? `动作 MIDI 端口重新打开后首个动作未发出（${error.portName}，错误码 ${error.code}）；等待该接口可用后继续，未发出的动作不补发` : error.message;
        this.dependencies.fault(fault, identity.itemId);
        this.lost = { project, identity, session: entry.session, fault }; this.recovery.lost(error.portName);
      }
      entry.session.abort(error.message);
    };
    const ports = this.dependencies.ports?.(failed) ?? new NativeMidiPorts(this.dependencies.profile(), {
      executable: this.dependencies.executable, authorize: () => this.dependencies.authorize(), failed
    });
    const session = new MidiProgramSession(project, identity.itemId, {
      prepare: (ids, signal) => ports.prepare(ids, signal), send: (id, bytes, deadline) => ports.send(id, bytes, deadline),
      close: () => ports.close(), now: this.now,
      sent: cueId => { if (this.entry?.session === session) { this.entry.sent = true; this.patch({ currentCueId: cueId }); } },
      missed: message => { if (this.entry?.session === session) this.dependencies.fault(message, identity.itemId); },
      failed: error => {
        // While its port is waited for, the lost port was reported once above; the dead helper's close is not news.
        if (!this.lost) this.dependencies.error(error.message);
        if (this.entry?.session === session) this.patch({ state: 'failed', reason: error.message });
      }
    });
    const state: NativeMidiChannelState = { ...identity, state: 'preparing', reason: null, currentCueId: null };
    const opened: Entry = { identity, session, state, resumed: outage !== null, skipped: 0, sent: false }; entry = opened; this.entry = opened; this.dependencies.changed(state);
    try {
      await session.prepare(positionMs);
      if (epoch !== this.epoch || this.entry !== opened) throw new Error('后台 MIDI 准备已取消');
      if (outage) {
        const audio = this.resumable();
        if (!audio) throw new Error('播放已暂停或停止，继续播放后再恢复');
        opened.skipped = session.resumeFrom(audio.positionMs, outage.outageStartMs);
      } else this.admit(identity);
      if (session.error) throw session.error;
      this.patch({ state: 'ready' });
    } catch (error) {
      if (this.entry === opened) this.patch({ state: 'failed', reason: toError(error).message });
      try { await session.close(); } catch (cleanup) { this.dependencies.error(`MIDI 准备取消后的关闭失败：${toError(cleanup).message}`); }
      throw error;
    }
  }

  observe(audio: NativePlayerStatus, qpc100ns: string | null): void {
    const entry = this.entry;
    if (!entry || entry.state.state === 'stopped' || entry.state.state === 'failed') return;
    if (audio.sessionId !== entry.identity.sessionId || audio.itemId !== entry.identity.itemId) {
      const current = this.dependencies.audio();
      if (current?.sessionId === entry.identity.sessionId && current.itemId === entry.identity.itemId) return;
      this.stopReported(); return;
    }
    if (audio.generation < entry.state.generation) return;
    if (audio.status === 'error' || audio.audioError || audio.status === 'stopped' || audio.status === 'preparing') { this.stopReported(); return; }
    if (entry.state.state === 'preparing') {
      if (!entry.resumed && (audio.generation !== entry.identity.generation || !['ready', 'paused'].includes(audio.status))) {
        entry.session.abort('MIDI 准备完成前音频已改变；本轮未参与，不中途补发');
      }
      return;
    }
    if (audio.generation > entry.state.generation) this.patch({ generation: audio.generation });
    if (audio.status === 'paused') { if (entry.state.state === 'running') this.stopReported(); return; }
    if (audio.status !== 'playing' && audio.status !== 'ended' || !qpc100ns || qpc100ns === '0') return;
    entry.session.clock(audio.positionMs, Number(qpc100ns) / 10000);
    if (!entry.session.error && entry.state.state !== 'running') this.patch({ state: 'running' });
  }

  interrupt(request: NativePlayerControl): void {
    const entry = this.entry;
    if (!entry || request.sessionId !== entry.identity.sessionId || request.generation < entry.state.generation) return;
    if (request.kind === 'stop' || request.kind === 'pause' || request.kind === 'seek') this.stopReported();
  }

  stop(): Promise<void> {
    this.epoch++; this.recovery.cancel(); this.lost = null;
    const entry = this.entry; this.entry = null;
    if (!entry) return this.stopped;
    this.dependencies.changed({ ...entry.state, state: entry.state.state === 'failed' ? 'failed' : 'stopped' });
    const closing = entry.session.close();
    // Only the caller of this stop receives a close failure; later stops and preparations wait for the close without it.
    this.stopped = closing.then(() => undefined, () => undefined);
    return closing;
  }

  private resumable(): NativePlayerStatus | null {
    const audio = this.dependencies.audio(), lost = this.lost;
    return lost && audio && audio.sessionId === lost.identity.sessionId && audio.itemId === lost.identity.itemId
      && audio.status === 'playing' && !audio.audioError ? audio : null;
  }
  /** Opens the lost song's ports again from the current audio position. */
  private async resume(): Promise<void> {
    const lost = this.lost, audio = this.resumable();
    if (!lost || !audio) throw new Error('播放已暂停或停止，继续播放后再恢复');
    const previous = this.entry, epoch = this.epoch; this.entry = null;
    // A failed session closes itself and reports its own close failure.
    if (previous) await Promise.allSettled([previous.session.close()]);
    if (epoch !== this.epoch) throw new Error('后台 MIDI 准备已被更新操作取消');
    await this.open(lost.project, { sessionId: audio.sessionId, generation: audio.generation, itemId: audio.itemId }, audio.positionMs, epoch, lost.session);
  }
  private admit(identity: Identity): NativePlayerStatus {
    const audio = this.dependencies.audio();
    if (!audio || audio.sessionId !== identity.sessionId || audio.generation !== identity.generation || audio.itemId !== identity.itemId
      || !['ready', 'paused'].includes(audio.status) || audio.audioError) throw new Error('MIDI 准备不属于当前待播放的音频会话');
    return audio;
  }
  private patch(patch: Partial<NativeMidiChannelState>): void {
    if (!this.entry) return;
    this.entry.state = { ...this.entry.state, ...patch }; this.dependencies.changed(this.entry.state);
  }
  private stopReported(): void { void this.stop().catch(error => this.dependencies.error(`后台 MIDI 关闭失败：${toError(error).message}`)); }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
