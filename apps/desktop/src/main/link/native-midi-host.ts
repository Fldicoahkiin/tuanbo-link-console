import { MidiProgramSession, type ProgramClock } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiPorts } from './native-midi-ports';
import { MidiOutputFailure } from './native-midi-output';
import { MidiPortRecovery, type PortRecoveryReport } from './midi-port-recovery';
import type { MidiClaim } from './midi-port-broker';
import type { LinkLogInput } from './run-logger';

type Identity = Pick<NativePlayerStatus, 'sessionId' | 'generation' | 'itemId'>;
/** Where a song is now: the audio player's status (`audio()`), or what the source of a clock that is not the player's says. */
export type MidiSongNow = Pick<NativePlayerStatus, 'sessionId' | 'generation' | 'itemId' | 'status' | 'positionMs' | 'audioError'>;
type Source = () => MidiSongNow | null;
/** A song whose clock is not the audio player's (P1's timecode, 0.5.9 P3d). `now` stands for `audio()` for this song
 * wherever the host asks where it is (preparing, a clock of another session, port recovery); the same function each time
 * for one follow, as a pass is carried only within one source. `opening`: the session starts following a song that
 * already plays (MidiProgramSession.prepare `opening`) and this gets its run-log line; null otherwise. */
export type MidiClockSource = { now: Source; opening: ((message: string) => void) | null };
/** The action MIDI port came back: the outage, how many actions it skipped, and the red message it showed. */
export type ActionMidiRecovery = PortRecoveryReport & { skippedActions: number; fault: string };

/** The action MIDI line of the run log after its port came back: the one for 联动台播放 and for P1 follow alike. */
export function actionMidiRecoveredEntry(report: ActionMidiRecovery, projectId: string, itemId: string): LinkLogInput {
  return { level: 'warning', category: 'device', device: '动作 MIDI', projectId, itemId,
    message: `动作 MIDI 中断 ${(report.durationMs / 1000).toFixed(1)} 秒后已恢复（${report.portName}）：从下一个动作起照常发送，中断期间跳过了 ${report.skippedActions} 个动作，不补发`,
    details: { portName: report.portName, interruptedAt: report.interruptedAt, recoveredAt: report.recoveredAt, durationMs: report.durationMs, skippedActions: report.skippedActions } };
}
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
type Entry = { identity: Identity; session: MidiProgramSession; state: NativeMidiChannelState; resumed: boolean; skipped: number; sent: boolean;
  /** The player's pass this session was opened for (prepare `pass`); null when it gave none. */
  pass: number | null;
  /** Where the song is, when not the audio player's (prepare `source`). */
  source: Source | null };
/** The playing song whose port was lost: its failed session (where the outage began) and the red message shown.
 * `project`: the version its actions follow, also when a newer one arrives meanwhile (retarget). */
type Lost = { project: LinkProject; identity: Identity; session: MidiProgramSession; fault: string; pass: number | null; source: Source | null };
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
  /** The actions whose turn came in the last session stopped (MidiProgramSession.passed) and the pass it was opened for:
   * carried only into a session of the same song and the same pass (prepare `pass`, 0.5.9 S8b). */
  private passed: { itemId: string; pass: number | null; source: Source | null; keys: ReadonlySet<string> } | null = null;
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

  /** Whether this song's actions (session and generation) are the host's: the session it runs, or, while its lost port
   * is waited for and opened again (`resume`, when no session is held for a moment), the one whose port was lost. */
  holds(sessionId: string, generation: number): boolean {
    const held = this.entry?.state ?? this.lost?.identity ?? null;
    return held?.sessionId === sessionId && held.generation === generation;
  }

  /** `pass`: the player's placing of the song (0.5.9 S8b). In the same pass as the session stopped last (the song plays
   * on after a pause) the actions whose turn came stay done, also where a version taken meanwhile moved them after the
   * playhead. A new pass (a start, a seek, a loop, a scrub) begins at this position and carries nothing.
   * `source`: the song's clock is not the audio player's (MidiClockSource); passes are carried only within one source. */
  async prepare(project: LinkProject, identity: Identity, pass?: number, source?: MidiClockSource): Promise<void> {
    const now = source?.now ?? null;
    this.admit(identity, now);
    const stopped = this.stop(), epoch = this.epoch, opening: Opening = { itemId: identity.itemId, project }; this.opening = opening;
    const passed = pass !== undefined && this.passed?.itemId === identity.itemId && this.passed.pass === pass && this.passed.source === now ? this.passed.keys : null;
    // The old driver has exited or was reported as kept; its failure does not decide this song.
    try { await stopped; } catch (error) { this.dependencies.error(`关闭上一首的 MIDI 失败：${toError(error).message}`); }
    if (epoch !== this.epoch) throw new Error('MIDI 准备已被新的操作取消');
    const audio = this.admit(identity, now);
    await this.open(opening.project, identity, audio.positionMs, epoch, null, passed, pass ?? null, now, source?.opening ?? null);
  }

  /** A newer version of the song's actions while they run (0.5.9 S8b): after the playhead they follow it
   * (MidiProgramSession.retarget). A session still being opened, or waiting for its lost port, opens with it. Another
   * song's version changes nothing here. The player refuses a version whose actions cannot be scheduled before it comes
   * here (MidiProgramSession.check in NativeProgramPlayer.updateProject). */
  retarget(project: LinkProject, itemId: string): void {
    const entry = this.entry;
    if (entry && entry.identity.itemId === itemId && !['stopped', 'failed'].includes(entry.state.state)) entry.session.retarget(project);
    if (this.opening?.itemId === itemId) this.opening.project = project;
    if (this.lost?.identity.itemId === itemId) this.lost.project = project;
  }

  /** `outage`: the failed session this one resumes after its port came back. `passed`: the actions whose turn came in
   * this pass before (prepare `playsOn`); after an outage, those of the failed session. */
  private async open(project: LinkProject, identity: Identity, positionMs: number, epoch: number, outage: MidiProgramSession | null,
    passed: ReadonlySet<string> | null, pass: number | null, source: Source | null, opening: ((message: string) => void) | null): Promise<void> {
    let entry: Entry | null = null;
    const failed = (error: Error) => {
      if (!entry || this.entry !== entry) { this.dependencies.error(`上一首的 MIDI：${error.message}`); return; }
      // The port is gone, or a port just opened again failed before its first action (Windows was
      // still creating it): wait for the same port again. Either way the rest of this attempt is off.
      if (error instanceof MidiOutputFailure && (error.portGone || entry.resumed && !entry.sent)) {
        const fault = entry.resumed && !entry.sent ? `动作 MIDI 端口重新打开后，第一个动作没有发出（${error.portName}，错误码 ${error.code}）。等这个接口可用后继续，没发出的动作不补发` : error.message;
        this.dependencies.fault(fault, identity.itemId);
        this.lost = { project, identity, session: entry.session, fault, pass: entry.pass, source }; this.recovery.lost(error.portName);
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
    const opened: Entry = { identity, session, state, resumed: outage !== null, skipped: 0, sent: false, pass, source }; entry = opened; this.entry = opened; this.dependencies.changed(state);
    try {
      await session.prepare(positionMs, outage?.passed ?? passed ?? undefined, opening ?? undefined);
      if (epoch !== this.epoch || this.entry !== opened) throw new Error('MIDI 准备已取消');
      if (outage) {
        const audio = this.resumable();
        if (!audio) throw new Error('播放已暂停或停止，继续播放后再恢复');
        opened.skipped = session.resumeFrom(audio.positionMs, outage.outageStartMs);
      } else this.admit(identity, source);
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
      const current = this.current(entry.source);
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
    this.passed = { itemId: entry.identity.itemId, pass: entry.pass, source: entry.source, keys: entry.session.passed };
    this.dependencies.changed({ ...entry.state, state: entry.state.state === 'failed' ? 'failed' : 'stopped' });
    const closing = entry.session.close();
    // Only the caller of this stop receives a close failure; later stops and preparations wait for the close without it.
    this.stopped = closing.then(() => undefined, () => undefined);
    return closing;
  }

  private resumable(): MidiSongNow | null {
    const lost = this.lost, audio = lost ? this.current(lost.source) : null;
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
    await this.open(lost.project, { sessionId: audio.sessionId, generation: audio.generation, itemId: audio.itemId }, audio.positionMs, epoch, lost.session, null, lost.pass, lost.source, null);
  }
  private admit(identity: Identity, source: Source | null): MidiSongNow {
    const audio = this.current(source);
    if (!audio || audio.sessionId !== identity.sessionId || audio.generation !== identity.generation || audio.itemId !== identity.itemId
      || !['ready', 'paused'].includes(audio.status) || audio.audioError) throw new Error('MIDI 准备的不是当前要播放的这首歌，请重新播放');
    return audio;
  }
  /** Where the song is now: from its own source, else the audio player. */
  private current(source: Source | null): MidiSongNow | null { return source ? source() : this.dependencies.audio(); }
  private patch(patch: Partial<NativeMidiChannelState>): void {
    if (!this.entry) return;
    this.entry.state = { ...this.entry.state, ...patch }; this.dependencies.changed(this.entry.state);
  }
  private stopReported(): void { void this.stop().catch(error => this.dependencies.error(`关闭 MIDI 失败：${toError(error).message}`)); }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
