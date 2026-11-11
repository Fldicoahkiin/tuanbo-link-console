import { pictureElementKey, showKey, type DecoderState, type Known, type LedgerWrite, type PictureLedgerState, type ShownSourceState } from './obs-picture-ledger';
import type { CompositionLayer, OnAirPicture, PictureClip } from './on-air-picture';
import { pictureProgramScene } from './on-air-picture';
import type { OutputMode } from './output-failure';
import { pictureRepairAllowed, type RecoveryBudgetView } from './output-recovery';

/**
 * Reconcile planning (0.5.9 design 01 §4.3): the requests that bring what OBS has
 * confirmed (the ledger) to the picture wanted now. It compares wanted with
 * confirmed, never one frame's wanted with the previous one's, so whatever happened
 * while requests were in flight, only the difference with "now" goes out.
 *
 * Per element:
 * - confirmed and equal: nothing; pending: wait for the answer;
 * - unknown: sent once as wanted (`restore`);
 * - failed against the same wanted state: live, once more within the recovery limits
 *   (`repair`), otherwise held and marked red; in a rehearsal never again (AGENTS §4.8);
 * - failed against an older wanted state (a cut point passed): sent fresh (`cut`).
 */
export type OpReason = 'cut' | 'repair' | 'restore' | 'retarget';
export type PictureOp =
  | { kind: 'decoder.stop'; sourceName: string; reason: OpReason; write: LedgerWrite }
  | { kind: 'decoder.pause'; sourceName: string; clipId: string; offsetMs: number; reason: OpReason; write: LedgerWrite }
  /** Plays a decoder paused on this same clip again: the media start only, no positioning. */
  | { kind: 'decoder.resume'; sourceName: string; clipId: string; offsetMs: number; reason: OpReason; write: LedgerWrite }
  | { kind: 'composition.update'; sceneName: string; layers: CompositionLayer[]; reason: OpReason; write: LedgerWrite }
  | { kind: 'program.switch'; sceneName: string; reason: OpReason; write: LedgerWrite }
  /** Positioned first, then played or kept paused. `program`: a single material on program
   * comes on with its start, its own scene switched in the same step (both sent or neither). */
  | { kind: 'decoder.start'; clip: PictureClip; mode: 'playing' | 'paused'; reason: OpReason; write: LedgerWrite; program: LedgerWrite | null }
  /** The later half of a split clip, on the decoder its predecessor plays on. It goes out as a
   * start, so the output takes that decoder over with no seek and no restart and still does the
   * on-air step at the cut (show, the half's own sound, its scene unless in an overlay). */
  | { kind: 'decoder.handover'; clip: PictureClip; reason: OpReason; write: LedgerWrite; program: LedgerWrite | null }
  | { kind: 'show.set'; sceneName: string | null; sourceName: string; enabled: boolean; reason: OpReason; write: LedgerWrite };
/** Not a failure: an answer is due, the clip is still preparing, or the program was switched by hand. */
export type WaitingItem = { element: string; kind: 'pending' | 'preparing' | 'taken-over'; detail: string };
/** Wanted but not sent: the element failed and may not be sent again for this wanted state. */
export type SuppressedItem = { element: string; target: string; kind: 'repair-limit' | 'rehearsal'; detail: string };

export type ReconcileContext = {
  mode: OutputMode;
  transport: 'running' | 'paused';
  now: number;
  ready: (clip: PictureClip) => 'ready' | 'preparing' | 'failed';
  budget: RecoveryBudgetView;
  /** Rehearsal: a failure already holds everything after it. */
  holding: boolean;
  /** Why this pass runs; a new timeline revision marks its fresh sends `retarget`. */
  trigger?: 'cut' | 'retarget' | undefined;
  /** Several cuts merged into one pass (OBS answered slowly): every show goes after the starts. */
  merged?: boolean | undefined;
};
export type ReconcilePlan = { ops: PictureOp[]; waiting: WaitingItem[]; suppressed: SuppressedItem[] };

/** A paused decoder this close to its wanted position is not positioned again. */
export const PAUSED_POSITION_TOLERANCE_MS = 50;
/** Composition layers started together with the composition (one event boundary). */
export const COMPOSITION_GROUP_STARTS = 8;
/** Independent decoders started together otherwise. */
export const DECODER_GROUP_STARTS = 4;

type Verdict = { send: OpReason } | { wait: WaitingItem } | { suppress: SuppressedItem } | null;
type StartOp = Extract<PictureOp, { kind: 'decoder.start' | 'decoder.handover' }>;
const isStart = (op: PictureOp | undefined): op is StartOp => op?.kind === 'decoder.start' || op?.kind === 'decoder.handover';

/** Every ledger write one op stands for: a single material's start also puts its scene on program. */
export function pictureOpWrites(op: PictureOp): LedgerWrite[] {
  return isStart(op) && op.program ? [op.write, op.program] : [op.write];
}

/** While the song is paused only the decoders pause (docs/OBS_SCENE_WORKFLOW.md, 2026-11-09):
 * everything else waits for the resume, which sends the picture at that position. */
export function whilePaused(plan: ReconcilePlan): ReconcilePlan {
  return { ...plan, ops: plan.ops.filter(op => op.kind === 'decoder.pause') };
}

export function planPictureReconcile(desired: OnAirPicture, ledger: PictureLedgerState, context: ReconcileContext): ReconcilePlan {
  const resumes: PictureOp[] = [], stops: PictureOp[] = [], compositions: PictureOp[] = [], programs: PictureOp[] = [], starts: PictureOp[] = [];
  const freshShows: PictureOp[] = [], restoredShows: PictureOp[] = [];
  const waiting: WaitingItem[] = [], suppressed: SuppressedItem[] = [];
  const fresh: OpReason = context.trigger ?? 'cut';
  const decide = <T>(write: LedgerWrite, known: Known<T> | undefined, matches: (value: T) => boolean): Verdict => {
    const element = pictureElementKey(write);
    const verdict = judge(element, write.target, known, matches, context, fresh);
    if (verdict && 'send' in verdict && context.holding)
      return { suppress: { element, target: write.target, kind: 'rehearsal', detail: '排练中前面的动作失败了，后面的画面不再发送' } };
    return verdict;
  };
  const collect = (verdict: Verdict, into: (reason: OpReason) => PictureOp[], op: (reason: OpReason) => PictureOp): void => {
    if (!verdict) return;
    if ('send' in verdict) into(verdict.send).push(op(verdict.send));
    else if ('wait' in verdict) waiting.push(verdict.wait);
    else suppressed.push(verdict.suppress);
  };
  const to = (list: PictureOp[]) => (): PictureOp[] => list;

  const target = desired.target;
  const scene = pictureProgramScene(target);
  const programWrite: LedgerWrite | null = scene === null ? null : { element: 'program', value: scene, target: scene };
  const programDone = ledger.program.state === 'confirmed' && ledger.program.value === scene;
  const single = target.kind === 'clip' ? target.clipId : null;
  const singleClip = single === null ? undefined : desired.clips.find(clip => clip.clipId === single);
  const singleKnown = singleClip && ledger.decoders.get(singleClip.sourceName);
  const singleOwned = single === null || (singleKnown?.state === 'confirmed' && singleKnown.value.clipId === single);

  // Decoders: every visible and sound clip keeps one; any other one that may be running stops.
  // A covered clip keeps the decoder it already has and is not started under the camera
  // (that would switch the program to it): it enters the picture when the camera ends.
  const mode = context.transport === 'running' ? 'playing' : 'paused';
  const covered = new Set(desired.covered.map(clip => clip.clipId));
  const wantedClips = [...desired.clips, ...desired.covered, ...desired.sounds];
  const preparing = new Set(wantedClips.filter(clip => context.ready(clip) === 'preparing').map(clip => clip.clipId));
  /** Decoders a wanted clip keeps; every other one that may be running stops. */
  const wantedSources = new Set<string>();
  for (const clip of wantedClips) {
    const known = ledger.decoders.get(clip.sourceName);
    const value: DecoderState = { clipId: clip.clipId, mode, offsetMs: clip.offsetMs };
    const write: LedgerWrite = { element: 'decoder', key: clip.sourceName, value, target: decoderTarget(clip.clipId, mode) };
    const confirmed = known?.state === 'confirmed' ? known.value : null;
    const last = known ? knownValue(known) : null;
    const own = confirmed?.clipId === clip.clipId;
    const predecessor = (state: DecoderState | null): boolean => !!clip.continuesFrom && state?.clipId === clip.continuesFrom;
    // A covered clip not confirmed on its decoder keeps it only if that decoder may hold it
    // (after a reconnect, say): a clip that ended under the camera (the earlier half of a
    // cut) stops there, as the timeline always did.
    if (covered.has(clip.clipId) && !own) {
      if (last?.clipId === clip.clipId) wantedSources.add(clip.sourceName);
      continue;
    }
    wantedSources.add(clip.sourceName);
    if (preparing.has(clip.clipId) && !own && !predecessor(confirmed)) {
      waiting.push({ element: pictureElementKey(write), kind: 'preparing', detail: '这段素材还在准备' });
      continue;
    }
    // Pausing a decoder already on this clip keeps its frame; resuming it only plays it again.
    // A decoder OBS refused a start or a pause for still holds this clip as far as anyone knows,
    // so it pauses and plays with the music too; repositioning it would make it jump.
    const held = known?.state === 'confirmed' || known?.state === 'failed' ? known.value : null;
    if (held?.clipId === clip.clipId && held.mode !== mode && held.mode !== 'stopped') {
      const change: LedgerWrite = { ...write, target: decoderTarget(clip.clipId, mode) };
      const kind = mode === 'paused' ? 'decoder.pause' as const : 'decoder.resume' as const;
      collect(decide(change, known, () => false), to(mode === 'paused' ? stops : resumes),
        reason => ({ kind, sourceName: clip.sourceName, clipId: clip.clipId, offsetMs: clip.offsetMs, reason, write: change }));
      continue;
    }
    // After a reconnect a decoder that was playing this clip may still play: it pauses with the
    // music; the resume rebuilds it from nothing.
    if (mode === 'paused' && known?.state === 'unknown' && last?.clipId === clip.clipId && last.mode === 'playing') {
      const change: LedgerWrite = { ...write, value: { ...value, mode: 'paused' } };
      collect(decide(change, known, () => false), to(stops),
        reason => ({ kind: 'decoder.pause', sourceName: clip.sourceName, clipId: clip.clipId, offsetMs: clip.offsetMs, reason, write: change }));
      continue;
    }
    const program = clip.clipId === single && !programDone ? programWrite : null;
    // The later half of a split clip takes its predecessor's playing decoder over.
    if (mode === 'playing' && confirmed?.mode === 'playing' && predecessor(confirmed)) {
      collect(decide(write, known, () => false), to(starts), reason => ({ kind: 'decoder.handover', clip, reason, write, program }));
      continue;
    }
    if (mode === 'paused' && predecessor(last)) continue;
    collect(decide(write, known, state => state.clipId === clip.clipId && state.mode === mode
      && (mode === 'playing' || Math.abs(state.offsetMs - clip.offsetMs) <= PAUSED_POSITION_TOLERANCE_MS)),
    to(starts), reason => ({ kind: 'decoder.start', clip, mode, reason, write, program }));
  }
  for (const [sourceName, known] of ledger.decoders) {
    if (wantedSources.has(sourceName)) continue;
    const last = knownValue(known);
    if (known.state === 'confirmed' && known.value.mode === 'stopped') continue;
    const write: LedgerWrite = { element: 'decoder', key: sourceName, value: { clipId: last?.clipId ?? '', mode: 'stopped', offsetMs: 0 }, target: decoderTarget('', 'stopped') };
    collect(decide(write, known, state => state.mode === 'stopped'), to(stops), reason => ({ kind: 'decoder.stop', sourceName, reason, write }));
  }

  // Program and composition wait for the visible clips they show: the picture stays as it is meanwhile.
  const visiblePreparing = desired.clips.some(clip => preparing.has(clip.clipId));
  if (target.kind === 'composition') {
    const signature = compositionSignature(target.layers);
    const write: LedgerWrite = { element: 'composition', key: target.sceneName, value: signature, target: signature };
    if (visiblePreparing) waiting.push({ element: pictureElementKey(write), kind: 'preparing', detail: '叠加里的素材还在准备' });
    else collect(decide(write, ledger.compositions.get(target.sceneName), value => value === signature), to(compositions),
      reason => ({ kind: 'composition.update', sceneName: target.sceneName, layers: target.layers, reason, write }));
  }
  if (programWrite && scene !== null) {
    if (ledger.takenOver && ledger.takenOver.target === scene)
      waiting.push({ element: 'program', kind: 'taken-over', detail: `画面被手动接管（${ledger.takenOver.sceneName}），到下一段再照常切换` });
    else if (visiblePreparing) waiting.push({ element: 'program', kind: 'preparing', detail: '要切过去的素材还在准备' });
    // A single material whose decoder is not on it yet comes on program only with its own start.
    else if (singleOwned) collect(decide(programWrite, ledger.takenOver ? undefined : ledger.program, value => value === scene), to(programs),
      reason => ({ kind: 'program.switch', sceneName: scene, reason, write: programWrite }));
  }

  // Shown sources: open spans are shown; anything else that may be showing is hidden.
  // The order is today's, on purpose (2026-11-11: R3 must not change what an operator sees).
  // A show or hide newly due at a cut goes out before the camera switch, so it acts on the
  // scene that was live, as `boundaryWork` sent it; a restored one, and every one of a merged
  // backlog, goes after the switch and the starts, as `shownAt` sent it. Whether a same-frame
  // show should land on the new scene is a question recorded for R4, not decided here.
  const showInto = (reason: OpReason): PictureOp[] => reason === 'restore' || context.merged ? restoredShows : freshShows;
  const wantedShows = new Set<string>();
  for (const show of desired.shows) {
    const key = showKey(show);
    if (wantedShows.has(key)) continue;
    wantedShows.add(key);
    const value: ShownSourceState = { enabled: true, sceneName: show.sceneName, sourceName: show.sourceName, span: show.actionId };
    const write: LedgerWrite = { element: 'show', key, value, target: `on:${show.actionId}` };
    // Each span shows its source when it opens, also right after another span of the same source.
    collect(decide(write, ledger.shows.get(key), state => state.enabled && state.span === show.actionId), showInto,
      reason => ({ kind: 'show.set', sceneName: show.sceneName, sourceName: show.sourceName, enabled: true, reason, write }));
  }
  for (const [key, known] of ledger.shows) {
    if (wantedShows.has(key)) continue;
    const last = knownValue(known);
    if (!last || (known.state === 'confirmed' && !known.value.enabled)) continue;
    const value: ShownSourceState = { ...last, enabled: false };
    const write: LedgerWrite = { element: 'show', key, value, target: 'off' };
    collect(decide(write, known, state => !state.enabled), showInto,
      reason => ({ kind: 'show.set', sceneName: last.sceneName, sourceName: last.sourceName, enabled: false, reason, write }));
  }

  return { ops: [...resumes, ...stops, ...freshShows, ...compositions, ...programs, ...starts, ...restoredShows], waiting, suppressed };
}

/**
 * Ops that share one event boundary and go out together, in order: a composition,
 * the switch to it and up to 8 starts of its layers on different decoders; otherwise
 * up to 4 starts on different decoders. Stops, pauses, other switches and shown
 * sources go one by one.
 */
export function groupPictureOps(ops: readonly PictureOp[]): PictureOp[][] {
  const groups: PictureOp[][] = [];
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!;
    const group = [op];
    const layers = op.kind === 'composition.update' ? new Set(op.layers.map(layer => layer.sceneName)) : null;
    if (layers && op.kind === 'composition.update') {
      const next = ops[index + 1];
      if (next?.kind === 'program.switch' && next.sceneName === op.sceneName) group.push(next);
    }
    if (layers || isStart(op)) {
      const limit = layers ? COMPOSITION_GROUP_STARTS : DECODER_GROUP_STARTS;
      const sources = new Set(isStart(op) ? [op.clip.sourceName] : []);
      let starts = sources.size;
      for (let next = ops[index + group.length]; isStart(next) && starts < limit
        && !sources.has(next.clip.sourceName) && (!layers || layers.has(next.clip.sceneName)); next = ops[index + group.length]) {
        group.push(next); sources.add(next.clip.sourceName); starts++;
      }
    }
    groups.push(group);
    index += group.length;
  }
  return groups;
}

export function decoderTarget(clipId: string, mode: DecoderState['mode']): string { return `${clipId}:${mode}`; }
export function compositionSignature(layers: readonly CompositionLayer[]): string { return JSON.stringify(layers.map(layer => layer.sceneName)); }

function judge<T>(element: string, target: string, known: Known<T> | undefined, matches: (value: T) => boolean, context: ReconcileContext, fresh: OpReason): Verdict {
  if (!known) return { send: fresh };
  switch (known.state) {
    case 'confirmed': return matches(known.value) ? null : { send: fresh };
    case 'pending': return { wait: { element, kind: 'pending', detail: '等 OBS 回应' } };
    // Never sent nor seen is a first send, not a restore.
    case 'unknown': return { send: known.last === null ? fresh : 'restore' };
    case 'failed':
      if (known.target !== target) return { send: fresh };
      if (context.mode === 'rehearsal') return { suppress: { element, target, kind: 'rehearsal', detail: '排练中失败的画面不再自动补发' } };
      return pictureRepairAllowed(context.budget, element, target, context.now) ? { send: 'repair' }
        : { suppress: { element, target, kind: 'repair-limit', detail: '自动补画面已到上限，到下一段会按时间线照常切换' } };
  }
}

function knownValue<T>(known: Known<T>): T | null {
  return known.state === 'unknown' ? known.last : known.value;
}
