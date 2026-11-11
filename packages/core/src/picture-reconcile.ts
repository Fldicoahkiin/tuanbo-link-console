import { pictureElementKey, showKey, type DecoderState, type Known, type LedgerWrite, type PictureLedgerState, type ShowState } from './obs-picture-ledger';
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
  | { kind: 'composition.update'; sceneName: string; layers: CompositionLayer[]; reason: OpReason; write: LedgerWrite }
  | { kind: 'program.switch'; sceneName: string; reason: OpReason; write: LedgerWrite }
  /** Positioned first, then played or kept paused. */
  | { kind: 'decoder.start'; clip: PictureClip; mode: 'playing' | 'paused'; reason: OpReason; write: LedgerWrite }
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
};
export type ReconcilePlan = { ops: PictureOp[]; waiting: WaitingItem[]; suppressed: SuppressedItem[];
  /** The same material continued after a cut: the decoder keeps playing under the new clip id (`ledger.adopt`). */
  adopted: { sourceName: string; clipId: string }[] };

/** A paused decoder this close to its wanted position is not positioned again. */
export const PAUSED_POSITION_TOLERANCE_MS = 50;
/** Composition layers started together with the composition (one event boundary). */
export const COMPOSITION_GROUP_STARTS = 8;
/** Independent decoders started together otherwise. */
export const DECODER_GROUP_STARTS = 4;

type Verdict = { send: OpReason } | { wait: WaitingItem } | { suppress: SuppressedItem } | null;

export function planPictureReconcile(desired: OnAirPicture, ledger: PictureLedgerState, context: ReconcileContext): ReconcilePlan {
  const stops: PictureOp[] = [], compositions: PictureOp[] = [], programs: PictureOp[] = [], starts: PictureOp[] = [], shows: PictureOp[] = [];
  const waiting: WaitingItem[] = [], suppressed: SuppressedItem[] = [], adopted: ReconcilePlan['adopted'] = [];
  const fresh: OpReason = context.trigger ?? 'cut';
  const decide = <T>(write: LedgerWrite, known: Known<T> | undefined, matches: (value: T) => boolean): Verdict => {
    const element = pictureElementKey(write);
    const verdict = judge(element, write.target, known, matches, context, fresh);
    if (verdict && 'send' in verdict && context.holding)
      return { suppress: { element, target: write.target, kind: 'rehearsal', detail: '排练中前面的动作失败了，后面的画面不再发送' } };
    return verdict;
  };
  const collect = (verdict: Verdict, into: PictureOp[], op: (reason: OpReason) => PictureOp): void => {
    if (!verdict) return;
    if ('send' in verdict) into.push(op(verdict.send));
    else if ('wait' in verdict) waiting.push(verdict.wait);
    else suppressed.push(verdict.suppress);
  };

  // Decoders: every visible, covered and sound clip keeps one; any other one that may be running stops.
  const mode = context.transport === 'running' ? 'playing' : 'paused';
  const wantedClips = [...desired.clips, ...desired.covered, ...desired.sounds];
  const preparing = new Set(wantedClips.filter(clip => context.ready(clip) === 'preparing').map(clip => clip.clipId));
  for (const clip of wantedClips) {
    const known = ledger.decoders.get(clip.sourceName);
    const value: DecoderState = { clipId: clip.clipId, mode, offsetMs: clip.offsetMs };
    const write: LedgerWrite = { element: 'decoder', key: clip.sourceName, value, target: decoderTarget(clip.clipId, mode) };
    const ours = (state: DecoderState): boolean => state.clipId === clip.clipId || (!!clip.continuesFrom && state.clipId === clip.continuesFrom);
    if (clip.continuesFrom && known?.state === 'confirmed' && known.value.clipId === clip.continuesFrom && known.value.mode === mode)
      adopted.push({ sourceName: clip.sourceName, clipId: clip.clipId });
    if (preparing.has(clip.clipId) && !(known?.state === 'confirmed' && ours(known.value))) {
      waiting.push({ element: pictureElementKey(write), kind: 'preparing', detail: '这段素材还在准备' });
      continue;
    }
    // Pausing a decoder already on this clip keeps its frame; anything else is positioned and started.
    if (mode === 'paused' && known?.state === 'confirmed' && ours(known.value) && known.value.mode === 'playing') {
      const pause: LedgerWrite = { ...write, target: decoderTarget(clip.clipId, 'paused') };
      collect(decide(pause, known, () => false), stops, reason => ({ kind: 'decoder.pause', sourceName: clip.sourceName, clipId: clip.clipId, offsetMs: clip.offsetMs, reason, write: pause }));
      continue;
    }
    collect(decide(write, known, state => ours(state) && state.mode === mode
      && (mode === 'playing' || Math.abs(state.offsetMs - clip.offsetMs) <= PAUSED_POSITION_TOLERANCE_MS)),
    starts, reason => ({ kind: 'decoder.start', clip, mode, reason, write }));
  }
  const wantedSources = new Set(wantedClips.map(clip => clip.sourceName));
  for (const [sourceName, known] of ledger.decoders) {
    if (wantedSources.has(sourceName)) continue;
    const last = knownValue(known);
    if (known.state === 'confirmed' && known.value.mode === 'stopped') continue;
    const write: LedgerWrite = { element: 'decoder', key: sourceName, value: { clipId: last?.clipId ?? '', mode: 'stopped', offsetMs: 0 }, target: decoderTarget('', 'stopped') };
    collect(decide(write, known, state => state.mode === 'stopped'), stops, reason => ({ kind: 'decoder.stop', sourceName, reason, write }));
  }

  // Program and composition wait for the visible clips they show: the picture stays as it is meanwhile.
  const target = desired.target;
  const visiblePreparing = desired.clips.some(clip => preparing.has(clip.clipId));
  if (target.kind === 'composition') {
    const signature = compositionSignature(target.layers);
    const write: LedgerWrite = { element: 'composition', key: target.sceneName, value: signature, target: signature };
    if (visiblePreparing) waiting.push({ element: pictureElementKey(write), kind: 'preparing', detail: '叠加里的素材还在准备' });
    else collect(decide(write, ledger.compositions.get(target.sceneName), value => value === signature), compositions,
      reason => ({ kind: 'composition.update', sceneName: target.sceneName, layers: target.layers, reason, write }));
  }
  const scene = pictureProgramScene(target);
  if (scene !== null) {
    const write: LedgerWrite = { element: 'program', value: scene, target: scene };
    if (ledger.takenOver && ledger.takenOver.target === scene)
      waiting.push({ element: 'program', kind: 'taken-over', detail: `画面被手动接管（${ledger.takenOver.sceneName}），到下一段再照常切换` });
    else if (visiblePreparing) waiting.push({ element: 'program', kind: 'preparing', detail: '要切过去的素材还在准备' });
    else collect(decide(write, ledger.takenOver ? undefined : ledger.program, value => value === scene), programs,
      reason => ({ kind: 'program.switch', sceneName: scene, reason, write }));
  }

  // Shown sources: open spans are shown; anything else that may be showing is hidden.
  const wantedShows = new Set<string>();
  for (const show of desired.shows) {
    const key = showKey(show);
    if (wantedShows.has(key)) continue;
    wantedShows.add(key);
    const value: ShowState = { enabled: true, sceneName: show.sceneName, sourceName: show.sourceName };
    const write: LedgerWrite = { element: 'show', key, value, target: `on:${show.actionId}` };
    collect(decide(write, ledger.shows.get(key), state => state.enabled), shows,
      reason => ({ kind: 'show.set', sceneName: show.sceneName, sourceName: show.sourceName, enabled: true, reason, write }));
  }
  for (const [key, known] of ledger.shows) {
    if (wantedShows.has(key)) continue;
    const last = knownValue(known);
    if (!last || (known.state === 'confirmed' && !known.value.enabled)) continue;
    const value: ShowState = { ...last, enabled: false };
    const write: LedgerWrite = { element: 'show', key, value, target: 'off' };
    collect(decide(write, known, state => !state.enabled), shows,
      reason => ({ kind: 'show.set', sceneName: last.sceneName, sourceName: last.sourceName, enabled: false, reason, write }));
  }

  return { ops: [...stops, ...compositions, ...programs, ...starts, ...shows], waiting, suppressed, adopted };
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
    if (layers || op.kind === 'decoder.start') {
      const limit = layers ? COMPOSITION_GROUP_STARTS : DECODER_GROUP_STARTS;
      const sources = new Set(op.kind === 'decoder.start' ? [op.clip.sourceName] : []);
      let starts = sources.size;
      for (let next = ops[index + group.length]; next?.kind === 'decoder.start' && starts < limit
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
