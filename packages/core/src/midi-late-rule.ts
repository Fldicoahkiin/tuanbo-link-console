/**
 * What happens to an action MIDI message that is late (2026-11-10 decision 6, design 01 §4.13). The only place in
 * the application that sorts a message and says what lateness does to it; the playback program
 * (`MidiProgramSession`) and the stop-type license rule (`midiMessageNeedsLicense`) both ask here.
 *
 * | message | kind | when late |
 * | --- | --- | --- |
 * | Program Change, Control Change | `state` | sent anyway, marked red with how late it was |
 * | Note On, MSC Go and every other MSC or SysEx | `press` | 100 ms or more late: only this one is skipped, recorded as missed, never sent later |
 * | Note Off (also the release at the end of a note's length), MSC Stop | `release` | always sent |
 *
 * One late or refused message never stops the rest of the song's action MIDI; only a broken port does.
 */

export type MidiMessageKind = 'state' | 'press' | 'release';

/** A `press` this late (or later) is skipped; a `state` this late is marked red. */
export const MIDI_LATE_LIMIT_MS = 100;
/** The native helper's deadline for a `state` message: this long after it is handed over. */
export const MIDI_STATE_DEADLINE_MS = 1000;
/** The native helper's deadline for a `release`: at least this long after it is handed over. */
export const MIDI_RELEASE_DEADLINE_MS = 100;

/** Sorts a message by its bytes, as they are sent. */
export function midiMessageKind(bytes: readonly number[]): MidiMessageKind {
  const [status] = bytes;
  if (status === undefined) return 'press';
  const type = status & 0xf0;
  if (type === 0x80) return 'release';
  if (type === 0xb0 || type === 0xc0) return 'state';
  // MSC: F0 7F <device> 02 <command format> <command>, where command 02 is Stop.
  if (status === 0xf0 && bytes[1] === 0x7f && bytes[3] === 0x02 && bytes[5] === 0x02) return 'release';
  return 'press';
}

export type MidiLateVerdict =
  /** Hand it over with this deadline; `markLate`: show in red how late it went out. */
  | { send: true; kind: MidiMessageKind; lateMs: number; deadlineAtMs: number; markLate: boolean }
  /** Too late: skip this one, record it as missed, do not send it later. */
  | { send: false; kind: 'press'; lateMs: number };

/** `dueAtMs`: when the message should have gone out; `nowMs`: when it is about to be handed over (same clock). */
export function midiLateVerdict(bytes: readonly number[], dueAtMs: number, nowMs: number): MidiLateVerdict {
  const kind = midiMessageKind(bytes), lateMs = Math.max(0, nowMs - dueAtMs);
  switch (kind) {
    case 'press': return lateMs >= MIDI_LATE_LIMIT_MS ? { send: false, kind, lateMs }
      : { send: true, kind, lateMs, deadlineAtMs: dueAtMs + MIDI_LATE_LIMIT_MS, markLate: false };
    case 'state': return { send: true, kind, lateMs, deadlineAtMs: nowMs + MIDI_STATE_DEADLINE_MS, markLate: lateMs >= MIDI_LATE_LIMIT_MS };
    case 'release': return { send: true, kind, lateMs,
      deadlineAtMs: Math.max(dueAtMs + MIDI_LATE_LIMIT_MS, nowMs + MIDI_RELEASE_DEADLINE_MS), markLate: false };
  }
}

/**
 * The output refused only this one message (expired, the previous SysEx still sending, invalid, queue full, or
 * confirmed after its deadline): the rest goes on. Any other error from a MIDI output means the port itself failed.
 * `possiblySent`: the driver took it, but confirmed too late to be sure when.
 */
export class MidiMessageSkipped extends Error {
  constructor(message: string, readonly code: number | null, readonly possiblySent = false) { super(message); }
}
