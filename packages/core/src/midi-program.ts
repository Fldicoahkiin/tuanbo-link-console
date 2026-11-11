import type { LinkAction, LinkProject } from '@tb/schema';
import { compileRundownTimelineCues } from './timeline-state';
import { playbackFramesPerSecond } from './mtc-timecode';
import { midiLateVerdict, midiMessageKind, MidiMessageSkipped } from './midi-late-rule';
import { OutputFailureRecord, type OutputMode } from './output-failure';

export type MidiAction = Extract<LinkAction, { kind: `midi.${string}` }>;
export function isMidiAction(action: LinkAction): action is MidiAction { return action.kind.startsWith('midi.'); }
export function encodeMidiAction(action: MidiAction): number[] {
  switch (action.kind) {
    case 'midi.noteOn': return [0x90 + action.channel - 1, action.note, action.velocity];
    case 'midi.noteOff': return [0x80 + action.channel - 1, action.note, action.velocity];
    case 'midi.controlChange': return [0xb0 + action.channel - 1, action.controller, action.value];
    case 'midi.programChange': return [0xc0 + action.channel - 1, action.program];
    case 'midi.showControl': return buildMidiShowControlMessage(action);
  }
}
export function buildMidiShowControlMessage(action: Extract<MidiAction, { kind: 'midi.showControl' }>): number[] {
  const command = { go: 0x01, stop: 0x02, resume: 0x03, load: 0x05 }[action.command];
  const fields = [action.cueNumber, action.cueList, action.cuePath];
  let lastField = -1;
  for (const [index, field] of fields.entries()) if (field !== undefined) lastField = index;
  const payload: number[] = [];
  for (let index = 0; index <= lastField; index++) {
    if (index > 0) payload.push(0);
    for (const character of fields[index] ?? '') {
      const code = character.codePointAt(0);
      if (code === undefined || code > 127) throw new Error('MIDI Show Control 字段只能使用 ASCII 字符');
      payload.push(code);
    }
  }
  return [0xf0, 0x7f, action.deviceId, 0x02, action.commandFormat, command, ...payload, 0xf7];
}

/** Stopping never waits for a license (2026-11-09, docs/LICENSE_IMPLEMENTATION.md): a Note Off and a MIDI Show Control
 * Stop end what a song started and go out without one. Every other message is new content and stays licensed, a Note On
 * with velocity 0 included. The one rule for both senders, on the bytes they send: the window's MIDI adapter
 * (link-midi-adapter) and the playback program (NativeMidiPorts). The stop-type messages are the `release` kind of
 * the late rule (midi-late-rule.ts), so "always goes out" means the same for the license and for lateness. */
export function midiMessageNeedsLicense(bytes: readonly number[]): boolean {
  return midiMessageKind(bytes) !== 'release';
}

type Event = { atMs: number; cueId: string; action: MidiAction; token: number; release: boolean };
export type MidiProgramDependencies = {
  prepare(portProfileIds: readonly string[], signal: AbortSignal): Promise<void>;
  /** Rejects with `MidiMessageSkipped` when only this message was refused; any other rejection means the port failed. */
  send(portProfileId: string, bytes: readonly number[], deadlineAtMs: number): Promise<void>;
  /** Cancel unsent commands immediately; resolve only after owned notes and
   * driver buffers are released. Never reset other senders' notes. */
  close(): Promise<void>;
  now(): number;
  sent(cueId: string, actionId: string, release: boolean): void;
  /** Actions that did not go out (too late, refused one by one, or held in a rehearsal); the channel keeps running. */
  missed(message: string): void;
  /** Program Change and Control Change that went out late; the channel keeps running. */
  late(message: string): void;
  failed(error: Error): void;
};

/** What the actions of one clock observation came to, reported once after they have all been handled. */
type Tick = { missed: string[]; late: { label: string; lateMs: number }[]; refused: { label: string; reason: string }[]; held: number };

/** Generic MIDI channel driven by observations of the actual audio device.
 * Note durations are timeline events, never uncancellable wall-clock timers.
 * Lateness follows `midiLateVerdict` (2026-11-10): a press 100 ms or more late is skipped and never sent later, a
 * Program Change or Control Change goes out late and is marked red, a release always goes out (only the release of
 * a note this session sent). One late or refused message never stops the channel; only a port failure does. In a
 * rehearsal the first message that did not go out holds the later ones (AGENTS §4.8), releases still go out. */
export class MidiProgramSession {
  private readonly events: readonly Event[];
  private readonly ports: readonly string[];
  private cursor = 0;
  private position = 0;
  private epoch = 0;
  private state: 'new' | 'preparing' | 'ready' | 'running' | 'closed' | 'failed' = 'new';
  private readonly cancellation = new AbortController();
  private readonly notes = new Map<string, Set<number>>();
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  /** Audio position of the first action not sent because the session failed. */
  private unsentFromMs: number | null = null;
  private readonly failures: OutputFailureRecord;

  constructor(project: LinkProject, itemId: string, private readonly dependencies: MidiProgramDependencies, mode: OutputMode) {
    const item = project.rundown.find(entry => entry.id === itemId);
    if (project.playbackSource !== 'internal' || !item || !item.enabled) throw new Error('后台 MIDI 只支持已启用的“联动台播放”节目');
    this.failures = new OutputFailureRecord(mode);
    let token = 0;
    const events: Event[] = [];
    for (const { cue, scheduledFrame } of compileRundownTimelineCues(item, project.timebase.frameRate)) {
      const atMs = scheduledFrame * 1000 / playbackFramesPerSecond(project.timebase.frameRate);
      for (const action of cue.actions) {
        if (!isMidiAction(action)) continue;
        const identity = ++token;
        events.push({ atMs, cueId: cue.id, action, token: identity, release: false });
        if (action.kind === 'midi.noteOn' && action.velocity > 0 && action.durationMs !== undefined) {
          events.push({ atMs: atMs + action.durationMs, cueId: cue.id, token: identity, release: true,
            action: { id: action.id, label: action.label, kind: 'midi.noteOff', portProfileId: action.portProfileId,
              channel: action.channel, note: action.note, velocity: 0 } });
        }
      }
    }
    this.events = events.sort((left, right) => left.atMs - right.atMs || left.token - right.token || Number(left.release) - Number(right.release));
    this.ports = [...new Set(events.map(event => event.action.portProfileId))];
  }

  get error(): Error | null { return this.failure; }
  /** Where a failed session's outage began: its first unsent action, or its last position when none was due. */
  get outageStartMs(): number { return this.unsentFromMs ?? this.position; }
  get pendingCount(): number { return this.queued; }
  settled(): Promise<void> { return this.tail; }
  abort(reason: string): void { this.fail(new Error(reason)); }

  async prepare(positionMs: number): Promise<void> {
    if (this.state !== 'new' || !Number.isFinite(positionMs) || positionMs < 0) throw new Error('MIDI 会话准备状态或位置无效');
    this.state = 'preparing'; this.position = positionMs;
    // A seek does not replay past actions, including a note release whose
    // corresponding Note On was never sent by this session.
    this.cursor = lowerBound(this.events, positionMs, positionMs > 0);
    try {
      await this.dependencies.prepare(this.ports, this.cancellation.signal);
      if (this.cancellation.signal.aborted) throw new Error('MIDI 准备已取消');
      this.state = 'ready';
    } catch (error) { const failure = toError(error); if (!this.cancellation.signal.aborted) this.fail(failure); throw failure; }
  }

  /** A session opened after its port came back (authorised 2026-10-24): actions from the outage start up
   * to this audio position are left out, not reported as missed. Only before the first clock; returns
   * how many actions the outage skipped. */
  resumeFrom(positionMs: number, outageStartMs: number): number {
    if (this.state !== 'ready' || !Number.isFinite(positionMs) || positionMs < this.position) throw new Error('MIDI 会话恢复位置无效');
    this.position = positionMs; this.cursor = lowerBound(this.events, positionMs, true);
    return this.events.filter(event => !event.release && event.atMs >= outageStartMs && event.atMs <= positionMs).length;
  }

  clock(positionMs: number, observedAtMs: number): void {
    if (this.state !== 'ready' && this.state !== 'running') return;
    const now = this.dependencies.now(), age = now - observedAtMs;
    if (!Number.isFinite(positionMs) || positionMs < this.position || !Number.isFinite(age) || age < 0) {
      this.fail(new Error('MIDI 收到的音频位置倒退或无效，已停止 MIDI 输出，不补发之前的动作')); return;
    }
    this.state = 'running'; this.position = positionMs;
    const tick: Tick = { missed: [], late: [], refused: [], held: 0 }, epoch = this.epoch;
    let missed = 0, handled = 0;
    while (this.cursor < this.events.length && this.events[this.cursor]!.atMs <= positionMs) {
      const event = this.events[this.cursor++]!; handled++;
      // When the device clock says this action was due, on the same clock as `now`.
      const dueAtMs = observedAtMs - (positionMs - event.atMs);
      let bytes: number[];
      try { bytes = encodeMidiAction(event.action); } catch (error) {
        const reason = toError(error).message;
        tick.refused.push({ label: event.action.label, reason }); this.itemFailed(event, 'midi-message-invalid', reason); continue;
      }
      if (!midiLateVerdict(bytes, dueAtMs, now).send) { missed++; this.itemFailed(event, 'midi-message-late', '播放位置更新晚了'); continue; }
      this.queue(event, bytes, dueAtMs, epoch, tick);
    }
    if (missed) this.dependencies.missed(`播放位置更新中断，错过了 ${missed} 个 MIDI 动作，没有补发`);
    if (handled) this.tail = this.tail.then(() => { if (epoch === this.epoch) this.report(tick); });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closed'; this.epoch++; this.cancellation.abort(); this.notes.clear();
    const inFlight = this.tail;
    // Run cancellation before awaiting the in-flight request, otherwise a
    // hung driver would prevent stop from cancelling the remaining queue.
    this.closing = Promise.allSettled([Promise.resolve().then(() => this.dependencies.close()), inFlight]).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [toError(result.reason)] : []);
      if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('；'));
    });
    return this.closing;
  }

  private queue(event: Event, bytes: readonly number[], dueAtMs: number, epoch: number, tick: Tick): void {
    this.queued++;
    this.tail = this.tail.then(async () => {
      if (epoch !== this.epoch || this.failure) { if (this.failure && !event.release) this.unsentFromMs ??= event.atMs; return; }
      if (this.holding() && midiMessageKind(bytes) !== 'release') { tick.held++; return; }
      const key = noteKey(event.action), owned = key ? this.notes.get(key) : undefined;
      if (event.release) {
        if (!owned?.delete(event.token)) return;
        if (owned.size) return;
        this.notes.delete(key!);
      }
      const verdict = midiLateVerdict(bytes, dueAtMs, this.dependencies.now());
      if (!verdict.send) { tick.missed.push(event.action.label); this.itemFailed(event, 'midi-message-late', '排队等发送时晚了'); return; }
      let confirmed = true;
      try { await this.dependencies.send(event.action.portProfileId, bytes, verdict.deadlineAtMs); } catch (error) {
        if (!(error instanceof MidiMessageSkipped)) throw error;
        tick.refused.push({ label: event.action.label, reason: error.message });
        this.itemFailed(event, error.code === -1 ? 'midi-message-invalid' : 'midi-message-late', error.message);
        // Taken by the driver but confirmed late: its note is still this session's to release.
        if (!error.possiblySent) return;
        confirmed = false;
      }
      if (epoch !== this.epoch || this.failure) return;
      if (key && event.action.kind === 'midi.noteOn' && event.action.velocity > 0) {
        const notes = this.notes.get(key) ?? new Set<number>(); notes.add(event.token); this.notes.set(key, notes);
      } else if (key) this.notes.delete(key);
      if (!confirmed) return;
      if (verdict.markLate) tick.late.push({ label: event.action.label, lateMs: Math.round(verdict.lateMs) });
      this.dependencies.sent(event.cueId, event.action.id, event.release);
    }).catch(error => { if (!event.release) this.unsentFromMs ??= event.atMs; if (epoch === this.epoch) this.fail(toError(error)); })
      .finally(() => { this.queued--; });
  }

  /** One message did not go out: only this one, unless a rehearsal holds the rest (output-failure.ts). */
  private itemFailed(event: Event, kind: 'midi-message-late' | 'midi-message-invalid', detail: string): void {
    this.failures.report({ scope: 'item', channel: 'actionMidi', item: `${event.cueId}/${event.action.id}`, kind, detail });
  }
  private holding(): boolean { return this.failures.holding !== null; }

  private report(tick: Tick): void {
    if (tick.missed.length) this.dependencies.missed(`MIDI 动作晚了超过 100 ms，没有补发：${labels(tick.missed)}`);
    const reasons = new Map<string, string[]>();
    for (const { label, reason } of tick.refused) reasons.set(reason, [...reasons.get(reason) ?? [], label]);
    for (const [reason, refused] of reasons) this.dependencies.missed(`MIDI 动作没有发出：${labels(refused)}，后面的动作照常发送。原因：${reason}`);
    if (tick.late.length) {
      const most = Math.max(...tick.late.map(entry => entry.lateMs));
      this.dependencies.late(`MIDI 动作晚了 ${most} ms 才发出：${labels(tick.late.map(entry => entry.label))}。请看一下接收的设备有没有切过去；经常这样时，检查电脑是否太忙`);
    }
    if (tick.held) this.dependencies.missed(`排练时前面的 MIDI 动作没有发出，后面的 ${tick.held} 个动作不再发送。检查后重新播放这首歌`);
  }

  private fail(error: Error): void {
    if (this.failure || this.state === 'closed') return;
    this.failure = error; this.state = 'failed'; this.dependencies.failed(error);
    void this.close().catch(cleanup => this.dependencies.failed(new Error(`MIDI 关闭失败：${toError(cleanup).message}`)));
  }
}

/** Up to three names, then how many there were in all. */
function labels(names: readonly string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 个` : names.join('、');
}
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function noteKey(action: MidiAction): string | null {
  return action.kind === 'midi.noteOn' || action.kind === 'midi.noteOff' ? JSON.stringify([action.portProfileId, action.channel, action.note]) : null;
}
function lowerBound(events: readonly Event[], position: number, exclusive: boolean): number {
  let left = 0, right = events.length;
  while (left < right) { const middle = (left + right) >>> 1;
    if (events[middle]!.atMs < position || exclusive && events[middle]!.atMs === position) left = middle + 1; else right = middle; }
  return left;
}
