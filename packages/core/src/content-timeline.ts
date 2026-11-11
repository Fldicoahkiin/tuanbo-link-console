import { linkCueSchema, referenceMediaClipSchema, validateItemRelations, type LinkCue, type LinkProject, type MtcFrameRate, type ReferenceMediaClip, type RundownItem, type VisualLayer } from '@tb/schema';
import { frameNumberToTimecode, millisecondsToFrameNumber, playbackFramesPerSecond, timecodeToFrameNumber } from './mtc-timecode';
import { commitItemContent, createItemContentCommand, draftItemContent, type LinkCommand } from './link-command';

/*
 * The content timeline's rules, in one place:
 * - Clips and camera cues have a length and sit on one track; on a track they
 *   never overlap. Other cues are instants and never collide.
 * - Putting something where its track is taken puts it on a new track
 *   directly above that track (as in 剪映).
 * - Trimming stops at the neighbours on the track and at the source's ends.
 * - Tracks with nothing on them are removed.
 * - visualLayers[0] is the top track; upper tracks cover lower ones.
 * Older projects are brought under these rules when opened, keeping what they
 * played: see normalizeContentTimeline.
 */

export type ContentRef = { kind: 'clip' | 'cue'; id: string };
/** `track`: that track, or a new track directly above it where it is taken.
 * `top`: the same for the top track. `newTrack`: a new track at that end. */
export type ContentTrackTarget = { track: string } | 'top' | { newTrack: 'top' | 'bottom' };

const DEFAULT_LENGTH_MS = 5_000;

/** A cue takes time when it puts a picture on air: a camera scene, or (in
 * older projects) a shown OBS source. Every other cue is an instant. */
export function cueTakesTime(cue: LinkCue): boolean {
  return cue.actions.some(action => action.kind === 'obs.setProgramScene' || action.kind === 'obs.setSceneItemEnabled' && action.enabled);
}

export function isCameraCue(cue: LinkCue): boolean {
  return cue.actions.some(action => action.kind === 'obs.setProgramScene');
}

type Span = { ref: ContentRef; layerId: string | undefined; start: number; end: number; key: string };

const durationFrames = (durationMs: number, frameRate: MtcFrameRate): number => Math.max(1, millisecondsToFrameNumber(durationMs, frameRate));
const framesToMs = (frames: number, frameRate: MtcFrameRate): number => Math.max(1, Math.round(frames / playbackFramesPerSecond(frameRate) * 1_000));

function clipSpan(clip: ReferenceMediaClip, frameRate: MtcFrameRate): Span {
  const start = timecodeToFrameNumber(clip.startTimecode, frameRate);
  return { ref: { kind: 'clip', id: clip.id }, layerId: clip.layerId, start, end: start + durationFrames(clip.durationMs, frameRate), key: `media:${clip.id}` };
}

function cueSpan(cue: LinkCue, frameRate: MtcFrameRate, end?: number): Span | null {
  if (!cueTakesTime(cue)) return null;
  const start = timecodeToFrameNumber(cue.timecode, frameRate);
  const resolved = cue.durationMs === undefined ? end : start + durationFrames(cue.durationMs, frameRate);
  return resolved === undefined ? null : { ref: { kind: 'cue', id: cue.id }, layerId: cue.layerId, start, end: resolved, key: `cue:${cue.id}` };
}

function spansOf(item: RundownItem, frameRate: MtcFrameRate): Span[] {
  return [...item.referenceMediaClips.map(clip => clipSpan(clip, frameRate)), ...item.cues.flatMap(cue => cueSpan(cue, frameRate) ?? [])];
}

/** Where camera cues saved without a length stopped playing: at the next camera
 * or picture start on any shown track, else at the end of the song. These are
 * the frames their old point switch was on air for. */
export function impliedSceneEnds(project: Pick<LinkProject, 'mediaAssets' | 'timebase'>, item: RundownItem): Map<string, number> {
  const frameRate = project.timebase.frameRate;
  const open = item.cues.filter(cue => cue.durationMs === undefined && cueTakesTime(cue));
  if (!open.length) return new Map();
  const shown = new Set(item.visualLayers.filter(layer => layer.visible).map(layer => layer.id));
  const onShownTrack = (layerId: string | undefined): boolean => !layerId || !item.visualLayers.length || shown.has(layerId);
  const kinds = new Map(project.mediaAssets.map(asset => [asset.id, asset.kind]));
  const pictures = item.referenceMediaClips.filter(clip => kinds.get(clip.assetId) !== 'audio' && onShownTrack(clip.layerId))
    .map(clip => clipSpan(clip, frameRate));
  const starts = [
    ...pictures.map(span => span.start),
    ...item.cues.filter(cue => cue.enabled && isCameraCue(cue) && onShownTrack(cue.layerId)).map(cue => timecodeToFrameNumber(cue.timecode, frameRate))
  ].sort((a, b) => a - b);
  // With nothing after it, a switch held to the end of the programme.
  const programmeEnd = Math.max(item.referenceAudio ? millisecondsToFrameNumber(item.referenceAudio.durationMs, frameRate) : 0,
    ...spansOf(item, frameRate).map(span => span.end));
  return new Map(open.map((cue) => {
    const start = timecodeToFrameNumber(cue.timecode, frameRate);
    const end = starts.find(frame => frame > start) ?? programmeEnd;
    return [cue.id, end > start ? end : start + durationFrames(DEFAULT_LENGTH_MS, frameRate)];
  }));
}

function overlaps(a: Pick<Span, 'start' | 'end'>, b: Pick<Span, 'start' | 'end'>): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Fresh track ids derived from what goes on them, so redoing a command
 * rebuilds the same tracks. */
function trackIdFor(item: RundownItem, ref: ContentRef): string {
  const taken = new Set(item.visualLayers.map(layer => layer.id));
  const base = `track-${ref.id}`;
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

function insertTrack(item: RundownItem, ref: ContentRef, index: number, from?: VisualLayer): string {
  const id = trackIdFor(item, ref);
  item.visualLayers.splice(index, 0, { id, name: `轨道 ${item.visualLayers.length + 1}`, visible: from?.visible ?? true, locked: from?.locked ?? false });
  return id;
}

function requireTrack(item: RundownItem, layerId: string): VisualLayer {
  const layer = item.visualLayers.find(candidate => candidate.id === layerId);
  if (!layer) throw new Error('这条轨道已经不在了，请重新拖放');
  return layer;
}

function assertEditable(item: RundownItem, layerId: string | undefined): void {
  if (!layerId) return;
  const layer = requireTrack(item, layerId);
  if (layer.locked) throw new Error(`轨道“${layer.name}”已锁定，先解锁再改`);
}

/** The track `span` goes on, creating it when needed (see ContentTrackTarget). */
function claimTrack(item: RundownItem, frameRate: MtcFrameRate, span: Omit<Span, 'layerId' | 'key'>, target: ContentTrackTarget, instant: boolean): string {
  if (target !== 'top' && 'newTrack' in target) return insertTrack(item, span.ref, target.newTrack === 'top' ? 0 : item.visualLayers.length);
  const layer = target === 'top' ? item.visualLayers[0] : requireTrack(item, target.track);
  if (!layer) return insertTrack(item, span.ref, 0);
  if (layer.locked) throw new Error(`轨道“${layer.name}”已锁定，先解锁再放`);
  return !instant && takenOn(item, frameRate, layer.id, span) ? insertTrack(item, span.ref, item.visualLayers.indexOf(layer), layer) : layer.id;
}

/** Whether another part on `layerId` overlaps `span`. */
function takenOn(item: RundownItem, frameRate: MtcFrameRate, layerId: string, span: Pick<Span, 'ref' | 'start' | 'end'>): boolean {
  const key = `${span.ref.kind === 'clip' ? 'media' : 'cue'}:${span.ref.id}`;
  return spansOf(item, frameRate).some(other => other.layerId === layerId && other.key !== key && overlaps(other, span));
}

function pruneEmptyTracks(item: RundownItem): void {
  const used = new Set([...item.referenceMediaClips.map(clip => clip.layerId), ...item.cues.map(cue => cue.layerId)]);
  item.visualLayers = item.visualLayers.filter(layer => used.has(layer.id));
}

function requireClip(item: RundownItem, id: string): ReferenceMediaClip {
  const clip = item.referenceMediaClips.find(candidate => candidate.id === id);
  if (!clip) throw new Error('这个素材片段已经不在时间线上了');
  return clip;
}

function requireCue(item: RundownItem, id: string): LinkCue {
  const cue = item.cues.find(candidate => candidate.id === id);
  if (!cue) throw new Error('这个 Cue 已经不在时间线上了');
  return cue;
}

/** Add a new clip or cue at its own time, on `target` (see ContentTrackTarget). */
export function placeContentCommand(itemId: string, entry: { clip: ReferenceMediaClip } | { cue: LinkCue }, target: ContentTrackTarget, label = '添加到时间线', now?: () => string): LinkCommand {
  const clip = 'clip' in entry ? referenceMediaClipSchema.parse(entry.clip) : null;
  const cue = 'cue' in entry ? linkCueSchema.parse(entry.cue) : null;
  return createItemContentCommand(label, itemId, (item, project) => {
    const frameRate = project.timebase.frameRate;
    if (clip) {
      if (!project.mediaAssets.some(asset => asset.id === clip.assetId)) throw new Error('素材已经不在资源库里了');
      if (item.referenceMediaClips.some(candidate => candidate.id === clip.id)) throw new Error('这个素材片段已经在时间线上了');
      item.referenceMediaClips.push({ ...structuredClone(clip), layerId: claimTrack(item, frameRate, clipSpan(clip, frameRate), target, false) });
    }
    if (cue) {
      if (item.cues.some(candidate => candidate.id === cue.id)) throw new Error('这个 Cue 已经在时间线上了');
      const placed = structuredClone(cue);
      if (cueTakesTime(placed) && placed.durationMs === undefined) placed.durationMs = DEFAULT_LENGTH_MS;
      const start = timecodeToFrameNumber(placed.timecode, frameRate);
      const span = cueSpan(placed, frameRate);
      placed.layerId = claimTrack(item, frameRate, span ?? { ref: { kind: 'cue', id: placed.id }, start, end: start + 1 }, target, !span);
      item.cues.push(placed);
    }
    pruneEmptyTracks(item);
  }, now);
}

/** Move a clip or cue to start at `startMs`, keeping its length, onto `target`. */
export function moveContentCommand(itemId: string, ref: ContentRef, startMs: number, target: ContentTrackTarget, now?: () => string): LinkCommand {
  return createItemContentCommand(ref.kind === 'clip' ? '移动素材片段' : '移动 Cue', itemId, (item, project) => {
    const frameRate = project.timebase.frameRate;
    const timecode = frameNumberToTimecode(millisecondsToFrameNumber(Math.max(0, startMs), frameRate), frameRate);
    if (ref.kind === 'clip') {
      const clip = requireClip(item, ref.id);
      assertEditable(item, clip.layerId);
      clip.startTimecode = timecode;
      clip.layerId = claimTrack(item, frameRate, clipSpan(clip, frameRate), target, false);
    } else {
      const cue = requireCue(item, ref.id);
      assertEditable(item, cue.layerId);
      cue.timecode = timecode;
      const span = cueSpan(cue, frameRate);
      const start = timecodeToFrameNumber(timecode, frameRate);
      cue.layerId = claimTrack(item, frameRate, span ?? { ref, start, end: start + 1 }, target, !span);
    }
    pruneEmptyTracks(item);
  }, now);
}

/** Whether moving `ref` to start at `startMs` on track `layerId` lands on another
 * part there, so the move puts it on a new track directly above (claimTrack).
 * An instant cue never does. The editor shows this while a part is dragged. */
export function contentPlaceTaken(project: LinkProject, itemId: string, ref: ContentRef, startMs: number, layerId: string): boolean {
  const item = project.rundown.find(candidate => candidate.id === itemId);
  if (!item) throw new Error('节目已经不在了');
  const frameRate = project.timebase.frameRate;
  const timecode = frameNumberToTimecode(millisecondsToFrameNumber(Math.max(0, startMs), frameRate), frameRate);
  const span = ref.kind === 'clip' ? clipSpan({ ...requireClip(item, ref.id), startTimecode: timecode }, frameRate) : cueSpan({ ...requireCue(item, ref.id), timecode }, frameRate);
  return span !== null && takenOn(item, frameRate, layerId, span);
}

/** The range a clip or camera cue can be trimmed to: up to its neighbours on
 * the track, and for video and sound up to the ends of the source file. */
export function contentTrimBounds(project: LinkProject, itemId: string, ref: ContentRef): { minStartMs: number; maxEndMs: number } {
  const item = project.rundown.find(candidate => candidate.id === itemId);
  if (!item) throw new Error('节目已经不在了');
  const frameRate = project.timebase.frameRate;
  const own = ref.kind === 'clip' ? clipSpan(requireClip(item, ref.id), frameRate) : cueSpan(requireCue(item, ref.id), frameRate);
  if (!own) throw new Error('这个 Cue 是一个时间点，没有长度可以修剪');
  const neighbours = spansOf(item, frameRate).filter(span => span.layerId === own.layerId && span.key !== own.key);
  let min = Math.max(0, ...neighbours.filter(span => span.end <= own.start).map(span => span.end));
  let max = Math.min(Number.MAX_SAFE_INTEGER, ...neighbours.filter(span => span.start >= own.end).map(span => span.start));
  if (ref.kind === 'clip') {
    const clip = requireClip(item, ref.id);
    const sourceMs = project.mediaAssets.find(asset => asset.id === clip.assetId)?.durationMs;
    if (sourceMs !== undefined) {
      const startMs = own.start / playbackFramesPerSecond(frameRate) * 1_000;
      min = Math.max(min, Math.ceil(Math.max(0, startMs - (clip.sourceOffsetMs ?? 0)) / 1_000 * playbackFramesPerSecond(frameRate) - 1e-9));
      max = Math.min(max, Math.floor((startMs - (clip.sourceOffsetMs ?? 0) + sourceMs) / 1_000 * playbackFramesPerSecond(frameRate) + 1e-9));
    }
  }
  const toMs = (frame: number): number => frame / playbackFramesPerSecond(frameRate) * 1_000;
  return { minStartMs: toMs(min), maxEndMs: max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : toMs(max) };
}

/** Set a clip's or camera cue's range, held to contentTrimBounds and at least a frame. */
export function trimContentCommand(itemId: string, ref: ContentRef, startMs: number, endMs: number, now?: () => string): LinkCommand {
  return createItemContentCommand(ref.kind === 'clip' ? '修剪素材片段' : '修剪 Cue', itemId, (item, project) => {
    const frameRate = project.timebase.frameRate;
    const bounds = contentTrimBounds(project, itemId, ref);
    const minStart = millisecondsToFrameNumber(bounds.minStartMs, frameRate);
    const maxEnd = Number.isFinite(bounds.maxEndMs) ? millisecondsToFrameNumber(bounds.maxEndMs, frameRate) : Number.MAX_SAFE_INTEGER;
    let start = Math.max(minStart, millisecondsToFrameNumber(Math.max(0, startMs), frameRate));
    let end = Math.min(maxEnd, millisecondsToFrameNumber(Math.max(0, endMs), frameRate));
    if (end - start < 1) {
      if (start >= maxEnd) start = maxEnd - 1; else end = start + 1;
    }
    const timecode = frameNumberToTimecode(start, frameRate);
    const durationMs = framesToMs(end - start, frameRate);
    if (ref.kind === 'clip') {
      const clip = requireClip(item, ref.id);
      assertEditable(item, clip.layerId);
      const before = timecodeToFrameNumber(clip.startTimecode, frameRate);
      const offset = Math.max(0, Math.round((clip.sourceOffsetMs ?? 0) + (start - before) / playbackFramesPerSecond(frameRate) * 1_000));
      const sourceMs = project.mediaAssets.find(asset => asset.id === clip.assetId)?.durationMs;
      Object.assign(clip, { startTimecode: timecode, sourceOffsetMs: offset, durationMs: sourceMs === undefined ? durationMs : Math.min(durationMs, sourceMs - offset) });
    } else {
      const cue = requireCue(item, ref.id);
      assertEditable(item, cue.layerId);
      Object.assign(cue, { timecode, durationMs });
    }
  }, now);
}

/** Cut a clip or camera cue in two at `atMs`; the right part gets `rightId`. */
export function splitContentCommand(itemId: string, ref: ContentRef, atMs: number, rightId: string, createId: () => string = () => crypto.randomUUID(), now?: () => string): LinkCommand {
  const actionIds: string[] = [];
  return createItemContentCommand(ref.kind === 'clip' ? '切割素材片段' : '切割 Cue', itemId, (item, project) => {
    const frameRate = project.timebase.frameRate;
    const at = millisecondsToFrameNumber(Math.max(0, atMs), frameRate);
    const own = ref.kind === 'clip' ? clipSpan(requireClip(item, ref.id), frameRate) : cueSpan(requireCue(item, ref.id), frameRate);
    if (!own) throw new Error('这个 Cue 是一个时间点，不能切割');
    if (at <= own.start || at >= own.end) throw new Error('把播放头放到片段中间再切割');
    assertEditable(item, own.layerId);
    const leftMs = framesToMs(at - own.start, frameRate);
    const timecode = frameNumberToTimecode(at, frameRate);
    if (ref.kind === 'clip') {
      const clip = requireClip(item, ref.id);
      // The two parts use exactly the source the clip used.
      const rightMs = clip.durationMs - leftMs;
      const right: ReferenceMediaClip = { ...structuredClone(clip), id: rightId, startTimecode: timecode, durationMs: rightMs, sourceOffsetMs: (clip.sourceOffsetMs ?? 0) + leftMs };
      clip.durationMs = leftMs;
      item.referenceMediaClips.splice(item.referenceMediaClips.indexOf(clip) + 1, 0, right);
    } else {
      const cue = requireCue(item, ref.id);
      const right: LinkCue = { ...structuredClone(cue), id: rightId, timecode, durationMs: (cue.durationMs ?? 0) - leftMs,
        actions: cue.actions.map((action, index) => ({ ...structuredClone(action), id: actionIds[index] ??= createId() })) };
      cue.durationMs = leftMs;
      item.cues.splice(item.cues.indexOf(cue) + 1, 0, right);
    }
  }, now);
}

export function removeContentCommand(itemId: string, refs: readonly ContentRef[], now?: () => string): LinkCommand {
  return createItemContentCommand(refs.length > 1 ? `删除 ${refs.length} 个片段` : refs[0]?.kind === 'cue' ? '删除 Cue' : '删除素材片段', itemId, (item) => {
    for (const ref of refs) {
      const entry = ref.kind === 'clip' ? requireClip(item, ref.id) : requireCue(item, ref.id);
      assertEditable(item, entry.layerId);
    }
    const clips = new Set(refs.filter(ref => ref.kind === 'clip').map(ref => ref.id));
    const cues = new Set(refs.filter(ref => ref.kind === 'cue').map(ref => ref.id));
    item.referenceMediaClips = item.referenceMediaClips.filter(clip => !clips.has(clip.id));
    item.cues = item.cues.filter(cue => !cues.has(cue.id));
    pruneEmptyTracks(item);
  }, now);
}

/** Whether each song object is under the rules, per frame rate. Songs are never changed in place (every change is a
 * LinkCommand), so this is worked out once per song object: after an edit only the changed song is looked at again. */
const tidiness = new WeakMap<RundownItem, Map<MtcFrameRate, boolean>>();
function needsNormalizing(project: LinkProject, item: RundownItem): boolean {
  const frameRate = project.timebase.frameRate;
  const known = tidiness.get(item) ?? new Map<MtcFrameRate, boolean>();
  let untidy = known.get(frameRate);
  if (untidy === undefined) {
    untidy = breaksTimelineRules(item, frameRate);
    known.set(frameRate, untidy);
    tidiness.set(item, known);
  }
  return untidy;
}

function breaksTimelineRules(item: RundownItem, frameRate: MtcFrameRate): boolean {
  if (item.referenceMediaClips.some(clip => !clip.layerId) || item.cues.some(cue => !cue.layerId)) return true;
  if (item.cues.some(cue => cue.durationMs === undefined && cueTakesTime(cue))) return true;
  const used = new Set([...item.referenceMediaClips.map(clip => clip.layerId), ...item.cues.map(cue => cue.layerId)]);
  if (item.visualLayers.some(layer => !used.has(layer.id))) return true;
  const byTrack = new Map<string, Span[]>();
  for (const span of spansOf(item, frameRate)) byTrack.set(span.layerId!, [...byTrack.get(span.layerId!) ?? [], span]);
  for (const spans of byTrack.values()) {
    spans.sort((a, b) => a.start - b.start);
    for (let index = 1; index < spans.length; index++) if (spans[index]!.start < spans[index - 1]!.end) return true;
  }
  return false;
}

/** Bring one programme under the timeline rules, keeping what it played:
 * 1. camera cues without a length get the frames they were on air for;
 * 2. clips and cues without a track go onto the top track, or a new top track
 *    where it is taken (clips first, so cameras stay above them as before);
 * 3. where a track holds overlapping parts, each later part moves to a new
 *    track directly above everything it overlaps, so it still covers them;
 * 4. empty tracks are removed. */
function normalizeItem(project: LinkProject, source: RundownItem): RundownItem {
  const frameRate = project.timebase.frameRate;
  const item = draftItemContent(source);
  const ends = impliedSceneEnds(project, source);
  for (const cue of item.cues) {
    const end = ends.get(cue.id);
    if (end !== undefined) cue.durationMs = framesToMs(end - timecodeToFrameNumber(cue.timecode, frameRate), frameRate);
  }
  const byStart = <T extends { id: string }>(entries: T[], start: (entry: T) => number): T[] => [...entries].sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
  for (const clip of byStart(item.referenceMediaClips.filter(entry => !entry.layerId), clip => timecodeToFrameNumber(clip.startTimecode, frameRate))) {
    clip.layerId = claimTrack(item, frameRate, clipSpan(clip, frameRate), 'top', false);
  }
  for (const cue of byStart(item.cues.filter(entry => !entry.layerId), cue => timecodeToFrameNumber(cue.timecode, frameRate))) {
    const span = cueSpan(cue, frameRate);
    const start = timecodeToFrameNumber(cue.timecode, frameRate);
    cue.layerId = claimTrack(item, frameRate, span ?? { ref: { kind: 'cue', id: cue.id }, start, end: start + 1 }, 'top', !span);
  }
  for (const layer of [...item.visualLayers]) {
    // Same start: the smaller key was on top before, so it is lifted last.
    const spans = spansOf(item, frameRate).filter(span => span.layerId === layer.id)
      .sort((a, b) => a.start - b.start || b.key.localeCompare(a.key));
    const lanes: string[] = [layer.id];
    const placed: { span: Span; lane: number }[] = [];
    for (const span of spans) {
      const lane = Math.max(-1, ...placed.filter(entry => overlaps(entry.span, span)).map(entry => entry.lane)) + 1;
      if (lane === lanes.length) lanes.push(insertTrack(item, span.ref, item.visualLayers.indexOf(requireTrack(item, lanes[lane - 1]!)), layer));
      placed.push({ span, lane });
      if (lane === 0) continue;
      const entry = span.ref.kind === 'clip' ? requireClip(item, span.ref.id) : requireCue(item, span.ref.id);
      entry.layerId = lanes[lane];
    }
  }
  pruneEmptyTracks(item);
  return commitItemContent(source, item);
}

/** The project with every programme under the content timeline rules; the same
 * object when nothing had to change. Applied on opening and after each edit.
 * Only the songs it changes are checked again (validateItemRelations). */
export function normalizeContentTimeline(project: LinkProject): LinkProject {
  if (!project.rundown.some(item => needsNormalizing(project, item))) return project;
  const normalized = new Set<RundownItem>();
  const next = { ...project, rundown: project.rundown.map((item) => {
    if (!needsNormalizing(project, item)) return item;
    const tidy = normalizeItem(project, item);
    normalized.add(tidy);
    return tidy;
  }) };
  for (const item of normalized) validateItemRelations(next, item);
  return next;
}

/** Every edit leaves the content timeline under its rules, in the same undo step. */
export function withContentTimeline(command: LinkCommand): LinkCommand {
  if (command.scope === 'lighting') return command;
  return { ...command, execute: project => normalizeContentTimeline(command.execute(project)) };
}
