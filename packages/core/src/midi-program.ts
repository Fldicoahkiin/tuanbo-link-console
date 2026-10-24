import type { LinkAction, LinkProject } from '@tb/schema';
import { compileRundownTimelineCues } from './timeline-state';
import { playbackFramesPerSecond } from './mtc-timecode';

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

type Event = { atMs: number; cueId: string; action: MidiAction; token: number; release: boolean };
export type MidiProgramDependencies = {
  prepare(portProfileIds: readonly string[], signal: AbortSignal): Promise<void>;
  send(portProfileId: string, bytes: readonly number[], deadlineAtMs: number): Promise<void>;
  /** Cancel unsent commands immediately; resolve only after owned notes and
   * driver buffers are released. Never reset other senders' notes. */
  close(): Promise<void>;
  now(): number;
  sent(cueId: string, actionId: string, release: boolean): void;
  /** Actions skipped because the audio position arrived or was sent too late;
   * the channel keeps running. */
  missed(message: string): void;
  failed(error: Error): void;
};

/** Generic MIDI channel driven by observations of the actual audio device.
 * Note durations are timeline events, never uncancellable wall-clock timers.
 * An action past its 100ms boundary is reported missed and never sent later;
 * the release of a note this session sent still goes out. */
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

  constructor(project: LinkProject, itemId: string, private readonly dependencies: MidiProgramDependencies) {
    const item = project.rundown.find(entry => entry.id === itemId);
    if (project.playbackSource !== 'internal' || !item || !item.enabled) throw new Error('后台 MIDI 需要已启用的内部主控节目');
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
      if (this.cancellation.signal.aborted) throw new Error('MIDI 会话准备已取消');
      this.state = 'ready';
    } catch (error) { const failure = toError(error); if (!this.cancellation.signal.aborted) this.fail(failure); throw failure; }
  }

  /** A session opened after its port came back (authorised 2026-10-24): actions up to this audio
   * position fell into the outage and are left out, not reported as missed. Only before the first clock. */
  resumeFrom(positionMs: number): void {
    if (this.state !== 'ready' || !Number.isFinite(positionMs) || positionMs < this.position) throw new Error('MIDI 会话恢复位置无效');
    this.position = positionMs; this.cursor = lowerBound(this.events, positionMs, true);
  }

  clock(positionMs: number, observedAtMs: number): void {
    if (this.state !== 'ready' && this.state !== 'running') return;
    try {
      const now = this.dependencies.now(), age = now - observedAtMs;
      if (!Number.isFinite(positionMs) || positionMs < this.position || !Number.isFinite(age) || age < 0) {
        throw new Error('MIDI 音频位置倒退或无效；停止该通道，不补发历史动作');
      }
      this.state = 'running'; this.position = positionMs;
      let missed = 0;
      while (this.cursor < this.events.length && this.events[this.cursor]!.atMs <= positionMs) {
        const event = this.events[this.cursor++]!;
        const deadline = observedAtMs + 100 - Math.max(0, positionMs - event.atMs), epoch = this.epoch;
        if (!event.release && deadline <= now) { missed++; continue; }
        if (this.queued >= 32) throw new Error('MIDI 节目动作积压，已停止该通道');
        this.queued++;
        this.tail = this.tail.then(async () => {
          if (epoch !== this.epoch || this.failure) return;
          const key = noteKey(event.action), owned = key ? this.notes.get(key) : undefined;
          if (event.release) {
            if (!owned?.delete(event.token)) return;
            if (owned.size) return;
            this.notes.delete(key!);
          }
          const sending = this.dependencies.now();
          if (!event.release && sending >= deadline) { this.dependencies.missed(`MIDI 动作发送晚于 100ms 执行边界，未补发：${event.action.label}`); return; }
          await this.dependencies.send(event.action.portProfileId, encodeMidiAction(event.action), event.release ? Math.max(deadline, sending + 100) : deadline);
          if (epoch !== this.epoch || this.failure) return;
          if (key && event.action.kind === 'midi.noteOn' && event.action.velocity > 0) {
            const notes = this.notes.get(key) ?? new Set<number>(); notes.add(event.token); this.notes.set(key, notes);
          } else if (key) this.notes.delete(key);
          this.dependencies.sent(event.cueId, event.action.id, event.release);
        }).catch(error => { if (epoch === this.epoch) this.fail(toError(error)); })
          .finally(() => { this.queued--; });
      }
      if (missed) this.dependencies.missed(`播放位置更新中断，错过 ${missed} 个 MIDI 动作，未补发`);
    } catch (error) { this.fail(toError(error)); }
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

  private fail(error: Error): void {
    if (this.failure || this.state === 'closed') return;
    this.failure = error; this.state = 'failed'; this.dependencies.failed(error);
    void this.close().catch(cleanup => this.dependencies.failed(new Error(`MIDI 会话关闭失败：${toError(cleanup).message}`)));
  }
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
