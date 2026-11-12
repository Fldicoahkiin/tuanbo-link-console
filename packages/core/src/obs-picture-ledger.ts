/**
 * What OBS has confirmed of the picture (0.5.9 design 01 §4.2). One ledger per
 * playback session, kept in memory, never in the project. Requests, their answers,
 * OBS events and readback write it; the reconcile planner reads it.
 */

/**
 * - `confirmed`: OBS answered or reported this value;
 * - `pending`: sent, no answer yet;
 * - `unknown`: after a reconnect, an unanswered request or a send cut short; `last` is the
 *   last value written, kept so a source can still be hidden by name;
 * - `failed`: OBS refused `value`; `target` is the wanted state's signature at the failure,
 *   `attempts` how many times that same target failed.
 */
export type Known<T> =
  | { state: 'confirmed'; value: T; at: number }
  | { state: 'pending'; value: T; target: string; since: number }
  | { state: 'unknown'; reason: string; last: T | null;
    /** Set when a request for this wanted state went out and whether OBS carried it out is not known (not
     * answered, or the step stopped part way after sending): like a failure, it is repaired once against it. */
    target?: string }
  | { state: 'failed'; value: T; attempts: number; reason: string; target: string };

export type DecoderMode = 'playing' | 'paused' | 'stopped';
/** The scene on program and, for a camera (or the camera held after it), the Cue that put it
 * there: the next camera Cue is a new picture even on the same scene (its own switch goes out). */
export type ProgramState = { sceneName: string; cueId: string | null };
/** A decoder (an owned media input), keyed by source name. */
export type DecoderState = { clipId: string; mode: DecoderMode; offsetMs: number };
/** A shown source, one per span (see `showKey`); the identity stays with the value so it can
 * be hidden again. `span`: the show action whose span showed it. */
export type ShownSourceState = { enabled: boolean; sceneName: string | null; sourceName: string; span: string | null };
/** Someone switched program in OBS by hand (2026-11-10 decision 5); `target` is the
 * wanted program signature at that moment: no switch back until it changes. */
export type PictureTakeover = { sceneName: string; since: number; target: string };

export type PictureLedgerState = {
  program: Known<ProgramState>;
  takenOver: PictureTakeover | null;
  compositions: ReadonlyMap<string, Known<string>>;
  decoders: ReadonlyMap<string, Known<DecoderState>>;
  shows: ReadonlyMap<string, Known<ShownSourceState>>;
};

/** One element's wanted value, as a reconcile op writes it. `target` names the wanted
 * state the value belongs to; a failure is kept against it. */
export type LedgerWrite =
  | { element: 'program'; value: ProgramState; target: string }
  | { element: 'composition'; key: string; value: string; target: string }
  | { element: 'decoder'; key: string; value: DecoderState; target: string }
  | { element: 'show'; key: string; value: ShownSourceState; target: string };
export type LedgerObservation =
  | { element: 'program'; value: ProgramState }
  | { element: 'composition'; key: string; value: string }
  | { element: 'decoder'; key: string; value: DecoderState }
  | { element: 'show'; key: string; value: ShownSourceState };

/** Stable name of one element across ledger, planner, recovery budget and status items. */
export function pictureElementKey(write: { element: LedgerWrite['element']; key?: string }): string {
  return write.element === 'program' ? 'program' : `${write.element}:${write.key ?? ''}`;
}
/** Shown sources are keyed by span: scene, source and the show action. Each span shows what
 * it opens and hides what it showed, also when the next span of the same source follows at
 * once (the adapter clears its record of the shown item with that hide). */
export function showKey(show: { sceneName: string | null; sourceName: string; actionId: string }): string {
  return JSON.stringify([show.sceneName, show.sourceName, show.actionId]);
}

const NEVER: Known<ProgramState> = { state: 'unknown', reason: '还没有发过画面', last: null };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
type Make = <T>(value: T) => Known<T>;

export class ObsPictureLedger {
  private program: Known<ProgramState> = NEVER;
  private takenOver: PictureTakeover | null = null;
  private readonly compositions = new Map<string, Known<string>>();
  private readonly decoders = new Map<string, Known<DecoderState>>();
  private readonly shows = new Map<string, Known<ShownSourceState>>();
  /** Failures in a row of one element against one target. */
  private readonly failures = new Map<string, { target: string; attempts: number }>();
  /** What each pending element was before its request went out, for `withdraw`. */
  private readonly before = new Map<string, Known<unknown>>();

  state(): PictureLedgerState {
    return { program: this.program, takenOver: this.takenOver, compositions: new Map(this.compositions),
      decoders: new Map(this.decoders), shows: new Map(this.shows) };
  }

  /** The request for `write` went out. */
  sent(write: LedgerWrite, now: number): void {
    const known = this.current(write);
    if (known) this.before.set(pictureElementKey(write), known);
    else this.before.delete(pictureElementKey(write));
    this.put(write, value => ({ state: 'pending', value, target: write.target, since: now }));
  }

  /** The request for `write` was not sent after all (a pause or stop came before it went
   * out): the element is as it was before. */
  withdraw(write: LedgerWrite): void {
    if (!this.isPending(write)) return;
    const element = pictureElementKey(write), previous = this.before.get(element);
    this.before.delete(element);
    if (!previous) { this.remove(write); return; }
    this.put(write, () => previous as Known<never>);
  }

  /** What OBS holds of this element is no longer known (its decoder was prepared again
   * after a failed start, say): the next pass sends it as wanted. */
  forget(write: LedgerWrite, reason: string): void {
    const known = this.current(write);
    if (!known || known.state === 'pending') return;
    this.failures.delete(pictureElementKey(write));
    if (write.element === 'show') this.shows.set(write.key, forgetShow(known as Known<ShownSourceState>, reason));
    else this.put(write, () => forget(known, reason) as Known<never>);
  }

  /** OBS answered the request for `write`. An answer for a value no longer pending is stale and ignored. */
  ack(write: LedgerWrite, now: number): void {
    if (!this.isPending(write)) return;
    this.failures.delete(pictureElementKey(write));
    this.put(write, value => ({ state: 'confirmed', value, at: now }));
    if (write.element === 'program') this.takenOver = null;
  }

  /** OBS refused the request for `write`. Repeated failures of the same target are counted. */
  fail(write: LedgerWrite, reason: string): void {
    if (!this.isPending(write)) return;
    const element = pictureElementKey(write), previous = this.failures.get(element);
    const attempts = (previous?.target === write.target ? previous.attempts : 0) + 1;
    this.failures.set(element, { target: write.target, attempts });
    this.put(write, value => ({ state: 'failed', value, attempts, reason, target: write.target }));
  }

  /** No answer, or a step that stopped part way after its requests went out: whether OBS applied it is not
   * known. The wanted state it was sent for is kept (`target`), so it is repaired as a failure would be. */
  unanswered(write: LedgerWrite, reason: string): void {
    if (!this.isPending(write)) return;
    if (write.element === 'show') { this.shows.set(write.key, forgetShow(this.shows.get(write.key)!, reason, write.target)); return; }
    this.put(write, value => ({ state: 'unknown', reason, last: value, target: write.target }));
  }

  /** OBS reported the value itself (event or readback). */
  observe(observation: LedgerObservation, now: number): void {
    this.failures.delete(pictureElementKey(observation));
    this.put(observation, value => ({ state: 'confirmed', value, at: now }));
  }

  takeOver(sceneName: string, target: string, now: number): void {
    this.takenOver = { sceneName, since: now, target };
    this.program = { state: 'confirmed', value: { sceneName, cueId: null }, at: now };
  }

  /** Everything OBS holds is unknown again (reconnect); a hand switch from before no longer counts.
   * A decoder OBS confirmed stopped stays stopped: OBS kept it stopped, or restarted with nothing
   * playing (R7). One whose stop was refused or not answered may still play, and is unknown. */
  invalidate(reason: string): void {
    this.program = forget(this.program, reason);
    this.takenOver = null;
    forgetAll(this.compositions, reason);
    for (const [key, known] of this.decoders) if (known.state !== 'confirmed' || known.value.mode !== 'stopped') this.decoders.set(key, forget(known, reason));
    for (const [key, known] of this.shows) this.shows.set(key, forgetShow(known, reason));
    this.failures.clear(); this.before.clear();
  }

  private current(write: LedgerWrite): Known<unknown> | undefined {
    switch (write.element) {
      case 'program': return this.program;
      case 'composition': return this.compositions.get(write.key);
      case 'decoder': return this.decoders.get(write.key);
      case 'show': return this.shows.get(write.key);
    }
  }
  private isPending(write: LedgerWrite): boolean {
    const known = this.current(write);
    return known?.state === 'pending' && known.target === write.target && same(known.value, write.value);
  }
  private remove(write: LedgerWrite): void {
    switch (write.element) {
      case 'program': this.program = NEVER; return;
      case 'composition': this.compositions.delete(write.key); return;
      case 'decoder': this.decoders.delete(write.key); return;
      case 'show': this.shows.delete(write.key); return;
    }
  }
  private put(write: LedgerWrite | LedgerObservation, make: Make): void {
    switch (write.element) {
      case 'program': this.program = make(write.value); return;
      case 'composition': this.compositions.set(write.key, make(write.value)); return;
      case 'decoder': {
        // A decoder taking another clip goes last: the decoders are in the order their clips were last given to them,
        // which is the order the song's stop and the drift check go through them (R7, in place of the session's own list).
        const previous = this.decoders.get(write.key), held = previous && (previous.state === 'unknown' ? previous.last : previous.value);
        if (previous && held?.clipId !== write.value.clipId) this.decoders.delete(write.key);
        this.decoders.set(write.key, make(write.value)); return;
      }
      case 'show': this.shows.set(write.key, make(write.value)); return;
    }
  }
}

function forget<T>(known: Known<T>, reason: string): Known<T> {
  return { state: 'unknown', reason, last: known.state === 'unknown' ? known.last : known.value };
}
/** A shown source no longer known keeps `last.enabled` as whether it may still be on air:
 * shown, a hide refused or not answered, or a show not answered may be; a confirmed hide
 * or a refused show is not. So a source confirmed hidden gets no second hide (with no
 * record of its item that hide would go to the scene now on program), and one whose hide
 * did not come back is still hidden after a reconnect and when the song stops. */
export function showMayBeOn(known: Known<ShownSourceState>): boolean {
  switch (known.state) {
    case 'confirmed': return known.value.enabled;
    case 'pending': return true;
    case 'unknown': return known.last?.enabled ?? false;
    case 'failed': return !known.value.enabled;
  }
}
function forgetShow(known: Known<ShownSourceState>, reason: string, target?: string): Known<ShownSourceState> {
  const last = known.state === 'unknown' ? known.last : known.value;
  return { state: 'unknown', reason, last: last && { ...last, enabled: showMayBeOn(known) }, ...(target === undefined ? {} : { target }) };
}
function forgetAll<T>(map: Map<string, Known<T>>, reason: string): void {
  for (const [key, known] of map) map.set(key, forget(known, reason));
}
