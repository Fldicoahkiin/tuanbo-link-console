import { MidiProgramSession, type ProgramClock } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiPorts } from './native-midi-ports';
import { MidiOutputFailure } from './native-midi-output';
import { MidiPortRecovery, type PortRecoveryReport } from './midi-port-recovery';
import type { MidiClaim } from './midi-port-broker';

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
  /** Takes an output from the editor before it opens for these actions. */
  claim?: (portName: string) => Promise<MidiClaim>;
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
/** The playing song whose port was lost: its failed session (where the outage began) and the red message shown.
 * `project`: the version its actions follow, also when a newer one arrives meanwhile (retarget). */
type Lost = { project: LinkProject; identity: Identity; session: MidiProgramSession; fault: string };
/** The song whose actions are being opened (prepare, resume) and the version they follow, also when a newer one arrives
 * before its session exists (retarget). */
type Opening = { itemId: string; project: LinkProject };

/** Program-owned generic MIDI. Receives only NativePlayerService observations,
 * never renderer positions or an independent playback timer. */
export class NativeMidiHost {
  private entry: Entry | null = null;
  private epoch = 0;
  private stopped: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  /** The playing song whose port was lost; its actions continue once the same port is back (authorised 2026-10-24). */
  private lost: Lost | null = null;
  private opening: Opening | null = null;
  /** The actions whose turn came in the last session stopped (MidiProgramSession.passed), for the song playing on after a
   * pause in the same pass (prepare `playsOn`, 0.5.9 S8b). */
  private passed: { itemId: string; keys: ReadonlySet<string> } | null = null;
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

  /** `playsOn`: the same song plays on from a pause (0.5.9 S8b): the actions whose turn came before the pause stay done,
   * also where a version taken meanwhile moved them after the playhead. Otherwise (a start, a seek, a loop) the pass
   * begins at this position. */
  async prepare(project: LinkProject, identity: Identity, playsOn = false): Promise<void> {
    this.admit(identity);
    const stopped = this.stop(), epoch = this.epoch, opening: Opening = { itemId: identity.itemId, project }; this.opening = opening;
    const passed = playsOn && this.passed?.itemId === identity.itemId ? this.passed.keys : null;
    // The old driver has exited or was reported as kept; its failure does not decide this song.
    try { await stopped; } catch (error) { this.dependencies.error(`关闭上一首的 MIDI 失败：${toError(error).message}`); }
    if (epoch !== this.epoch) throw new Error('MIDI 准备已被新的操作取消');
    const audio = this.admit(identity);
    await this.open(opening.project, identity, audio.positionMs, epoch, null, passed);
  }

  /** A newer version of the song's actions while they run (0.5.9 S8b): after the playhead they follow it
   * (MidiProgramSession.retarget). A session still being opened, or waiting for its lost port, opens with it. Another
   * song's version changes nothing here. Throws when its actions cannot be scheduled; the song keeps the ones it has. */
  retarget(project: LinkProject, itemId: string): void {
    const entry = this.entry;
    if ((entry?.identity.itemId ?? this.opening?.itemId ?? this.lost?.identity.itemId ?? this.passed?.itemId) !== itemId) return;
    // Also while no session runs (paused): a version that cannot be scheduled is said now, not at the resume.
    MidiProgramSession.check(project, itemId);
    if (entry && entry.identity.itemId === itemId && !['stopped', 'failed'].includes(entry.state.state)) entry.session.retarget(project);
    if (this.opening?.itemId === itemId) this.opening.project = project;
    if (this.lost?.identity.itemId === itemId) this.lost.project = project;
  }

  /** `outage`: the failed session this one resumes after its port came back. `passed`: the actions whose turn came in
   * this pass before (prepare `playsOn`); after an outage, those of the failed session. */
  private async open(project: LinkProject, identity: Identity, positionMs: number, epoch: number, outage: MidiProgramSession | null,
    passed: ReadonlySet<string> | null): Promise<void> {
    let entry: Entry | null = null;
    const failed = (error: Error) => {
      if (!entry || this.entry !== entry) { this.dependencies.error(`上一首的 MIDI：${error.message}`); return; }
      // The port is gone, or a port just opened again failed before its first action (Windows was
      // still creating it): wait for the same port again. Either way the rest of this attempt is off.
      if (error instanceof MidiOutputFailure && (error.portGone || entry.resumed && !entry.sent)) {
        const fault = entry.resumed && !entry.sent ? `动作 MIDI 端口重新打开后，第一个动作没有发出（${error.portName}，错误码 ${error.code}）。等这个接口可用后继续，没发出的动作不补发` : error.message;
        this.dependencies.fault(fault, identity.itemId);
        this.lost = { project, identity, session: entry.session, fault }; this.recovery.lost(error.portName);
      }
      entry.session.abort(error.message);
    };
    const ports = this.dependencies.ports?.(failed) ?? new NativeMidiPorts(this.dependencies.profile(), {
      executable: this.dependencies.executable, authorize: () => this.dependencies.authorize(), failed,
      ...this.dependencies.claim ? { claim: this.dependencies.claim } : {}
    });
    const session = new MidiProgramSession(project, identity.itemId, {
      prepare: (ids, signal) => ports.prepare(ids, signal), send: (id, bytes, deadline) => ports.send(id, bytes, deadline),
      close: () => ports.close(), now: this.now,
      sent: cueId => { if (this.entry?.session === session) { this.entry.sent = true; this.patch({ currentCueId: cueId }); } },
      // Missed and late-sent actions are logged and shown on their own lines (2026-11-10); neither stops the channel.
      missed: message => { if (this.entry?.session === session) this.dependencies.fault(message, identity.itemId); },
      late: message => { if (this.entry?.session === session) this.dependencies.fault(message, identity.itemId); },
      failed: error => {
        // While its port is waited for, the lost port was reported once above; the dead helper's close is not news.
        if (!this.lost) this.dependencies.error(error.message);
        if (this.entry?.session === session) this.patch({ state: 'failed', reason: error.message });
      }
    // The playing program is a live show: a message that did not go out is marked red and the rest goes on.
    }, 'live');
    const state: NativeMidiChannelState = { ...identity, state: 'preparing', reason: null, currentCueId: null };
    const opened: Entry = { identity, session, state, resumed: outage !== null, skipped: 0, sent: false }; entry = opened; this.entry = opened; this.dependencies.changed(state);
    try {
      await session.prepare(positionMs, outage?.passed ?? passed ?? undefined);
      if (epoch !== this.epoch || this.entry !== opened) throw new Error('MIDI 准备已取消');
      if (outage) {
        const audio = this.resumable();
        if (!audio) throw new Error('播放已暂停或停止，继续播放后再恢复');
        opened.skipped = session.resumeFrom(audio.positionMs, outage.outageStartMs);
      } else this.admit(identity);
      if (session.error) throw session.error;
      this.patch({ state: 'ready' });
    } catch (error) {
      if (this.entry === opened) this.patch({ state: 'failed', reason: toError(error).message });
      try { await session.close(); } catch (cleanup) { this.dependencies.error(`取消 MIDI 准备后关闭失败：${toError(cleanup).message}`); }
      throw error;
    }
  }

  observe(clock: ProgramClock): void {
    const entry = this.entry;
    if (!entry || entry.state.state === 'stopped' || entry.state.state === 'failed') return;
    if (clock.sessionId !== entry.identity.sessionId || clock.itemId !== entry.identity.itemId) {
      const current = this.dependencies.audio();
      if (current?.sessionId === entry.identity.sessionId && current.itemId === entry.identity.itemId) return;
      this.stopReported(); return;
    }
    if (clock.generation < entry.state.generation) return;
    if (clock.state === 'stopped') { this.stopReported(); return; }
    if (entry.state.state === 'preparing') {
      if (!entry.resumed && (clock.generation !== entry.identity.generation || !['ready', 'held'].includes(clock.state))) {
        entry.session.abort('MIDI 还没准备好音频就变了，这一首不发 MIDI，也不会中途补发');
      }
      return;
    }
    if (clock.generation > entry.state.generation) this.patch({ generation: clock.generation });
    if (clock.state === 'held') { if (entry.state.state === 'running') this.stopReported(); return; }
    if (clock.state !== 'running' && clock.state !== 'ended' || clock.observedAtMs === null) return;
    entry.session.clock(clock.positionMs, clock.observedAtMs);
    if (!entry.session.error && entry.state.state !== 'running') this.patch({ state: 'running' });
  }

  interrupt(request: NativePlayerControl): void {
    const entry = this.entry;
    if (!entry || request.sessionId !== entry.identity.sessionId || request.generation < entry.state.generation) return;
    if (request.kind === 'stop' || request.kind === 'pause' || request.kind === 'seek') this.stopReported();
  }

  stop(): Promise<void> {
    this.epoch++; this.recovery.cancel(); this.lost = null; this.opening = null;
    const entry = this.entry; this.entry = null;
    if (!entry) return this.stopped;
    this.passed = { itemId: entry.identity.itemId, keys: entry.session.passed };
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
    if (epoch !== this.epoch) throw new Error('MIDI 准备已被新的操作取消');
    // The version as it is now: retarget keeps `lost.project` up to date while the old session closed.
    await this.open(lost.project, { sessionId: audio.sessionId, generation: audio.generation, itemId: audio.itemId }, audio.positionMs, epoch, lost.session, null);
  }
  private admit(identity: Identity): NativePlayerStatus {
    const audio = this.dependencies.audio();
    if (!audio || audio.sessionId !== identity.sessionId || audio.generation !== identity.generation || audio.itemId !== identity.itemId
      || !['ready', 'paused'].includes(audio.status) || audio.audioError) throw new Error('MIDI 准备的不是当前要播放的这首歌，请重新播放');
    return audio;
  }
  private patch(patch: Partial<NativeMidiChannelState>): void {
    if (!this.entry) return;
    this.entry.state = { ...this.entry.state, ...patch }; this.dependencies.changed(this.entry.state);
  }
  private stopReported(): void { void this.stop().catch(error => this.dependencies.error(`关闭 MIDI 失败：${toError(error).message}`)); }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
