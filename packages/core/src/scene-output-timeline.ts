import { compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import { resolveTimelineCueSpan } from './timeline-state';
import { impliedSceneEnds, isCameraCue } from './content-timeline';
import { playbackFramesPerSecond, timecodeToFrameNumber } from './mtc-timecode';
import type { RuntimeUpdate } from './cue-runtime';
import type { CompositionLayer, OnAirPicture, PictureClip, PictureShow, PictureTarget } from './on-air-picture';
import type { LinkCue, LinkProject } from '@tb/schema';

type SceneWork = { media: ManagedMediaEvent[]; cues: RuntimeUpdate['dueCues'] };
/** The camera scene and clips the output shows at `frame`, top first, for a
 * preview drawn without OBS. Read from `pictureAt`. */
export type ScenePicture = { camera: LinkCue | null; clipIds: string[] };
export type FrameRange = { start: number; end: number };
type Scene = { cue: LinkCue; start: number; end: number };
type Media = { event: ManagedMediaEvent; end: number };
type Show = { show: PictureShow; order: number };
type SceneIndex = {
  projectId: string; itemId: string; layers: ReadonlyMap<string, number>;
  scenes: Scene[];
  media: Media[];
  cues: ReadonlyMap<string, LinkCue>;
  events: ReadonlyMap<string, ManagedMediaEvent>;
  /** The clip each clip carries on from: same decoder, ending on its first frame, at the source position it starts from. */
  continues: ReadonlyMap<string, string>;
  /** Scenes by end, for the one kept on program when no track has a picture. */
  byEnd: Scene[];
  ends: number[];
  cuts: number[];
  activeScenes: IntervalIndex<Scene>;
  activeMedia: IntervalIndex<ManagedMediaEvent>;
  activeShows: IntervalIndex<Show>;
  showCues: ReadonlySet<string>;
};

/** Sorted starts plus prefix end bounds skip expired suffixes on arbitrary
 * seeks. Queries retain nested and overlapping finite intervals. */
class IntervalIndex<T> {
  private readonly entries: { start: number; end: number; value: T }[];
  private readonly starts: number[];
  private readonly furthestEnds: number[];
  constructor(entries: { start: number; end: number; value: T }[]) {
    this.entries = entries.sort((a, b) => a.start - b.start);
    this.starts = this.entries.map(entry => entry.start);
    let furthest = -Infinity;
    this.furthestEnds = this.entries.map(entry => (furthest = Math.max(furthest, entry.end)));
  }
  at(frame: number): T[] {
    const result: T[] = [];
    for (let index = firstAfter(this.starts, frame) - 1; index >= 0 && this.furthestEnds[index]! > frame; index--) {
      const entry = this.entries[index]!;
      if (entry.end > frame) result.push(entry.value);
    }
    return result;
  }
}

/**
 * What the output shows at each frame of one song: the only place that works it
 * out (design 01 §4.1). `pictureAt` is the rule; the output work (`at`), the
 * preview without OBS (`picture`), the dimmed covered stretches (`airtime`), the
 * preload plan and the editor's timeline state (`TimelineStateIndex`) all read it.
 *
 * The rule: the top track first; a camera is a whole frame, so nothing below the
 * first camera is in the picture (those clips are `covered`); sound has no
 * picture, so no camera covers it; with no picture on any track the last camera
 * that ended stays on program. "Show source" cues are open for their length.
 *
 * Owned by a playback session or an editor revision. Ordinary frames do not
 * compile the project, and document history cannot retain a global cache of
 * every old revision.
 */
export class SceneOutputTimeline {
  private readonly index: SceneIndex;
  private readonly fps: number;
  constructor(project: LinkProject, itemId: string, events = compileManagedMediaTimeline(project, itemId).events) {
    const frameRate = project.timebase.frameRate;
    this.fps = playbackFramesPerSecond(frameRate);
    const item = project.rundown.find(entry => entry.id === itemId);
    if (!item) throw new Error('定位节目不存在');
    const layers = new Map(item.visualLayers.map((layer, order) => [layer.id, order]));
    const visible = new Set(item.visualLayers.filter(layer => layer.visible).map(layer => layer.id));
    // A camera saved without a length (older projects) plays the frames it did before.
    const implied = impliedSceneEnds(project, item);
    const scenes = item.cues.filter(cue => cue.enabled && (!cue.layerId || visible.has(cue.layerId)) && isCameraCue(cue))
      .map(cue => ({ cue, start: timecodeToFrameNumber(cue.timecode, frameRate),
        end: implied.get(cue.id) ?? resolveTimelineCueSpan(cue, frameRate).endFrame }))
      .sort((a, b) => a.start - b.start);
    const stops = new Map(events.filter(event => event.phase === 'stop').map(event => [event.clipId, event.frameNumber]));
    const starts = events.filter(event => event.phase === 'start');
    const media = starts.map(event => ({ event, end: stops.get(event.clipId) ?? -1 }));
    // A show cue is a span on a track; one that is off, or on a hidden track, never opens.
    // One without a length has no span (opening a project refuses it; the playback session still plays its point).
    const shows = item.cues.flatMap((cue, order) => {
      if (!cue.enabled || !cue.layerId || !visible.has(cue.layerId) || cue.durationMs === undefined) return [];
      const actions = cue.actions.flatMap(action => action.kind === 'obs.setSceneItemEnabled' && action.enabled ? [action] : []);
      if (!actions.length) return [];
      const span = resolveTimelineCueSpan(cue, frameRate);
      const layerId = cue.layerId;
      return actions.map(action => ({ start: span.startFrame, end: span.endFrame, value: { order,
        show: { cueId: cue.id, actionId: action.id, sceneName: action.sceneName, sourceName: action.sourceName, layerId } } }));
    });
    const order = (cue: LinkCue): number => cue.layerId ? layers.get(cue.layerId) ?? -1 : -1;
    this.index = { projectId: project.projectId, itemId, layers, scenes, media,
      cues: new Map(item.cues.map(cue => [cue.id, cue])),
      events: new Map(starts.map(event => [event.clipId, event])),
      continues: continuations(media, this.fps),
      byEnd: [...scenes].sort((a, b) => a.end - b.end || order(b.cue) - order(a.cue) || a.start - b.start),
      ends: scenes.map(scene => scene.end).sort((a, b) => a - b),
      cuts: [...new Set([...media.flatMap(entry => [entry.event.frameNumber, entry.end]),
        ...scenes.flatMap(entry => [entry.start, entry.end]), ...shows.flatMap(entry => [entry.start, entry.end])])]
        .filter(frame => frame >= 0).sort((a, b) => a - b),
      activeScenes: new IntervalIndex(scenes.map(scene => ({ start: scene.start, end: scene.end, value: scene }))),
      activeMedia: new IntervalIndex(media.map(entry => ({ start: entry.event.frameNumber, end: entry.end, value: entry.event }))),
      activeShows: new IntervalIndex(shows), showCues: new Set(shows.map(entry => entry.value.show.cueId)) };
  }

  /** The picture OBS should show at `frame`. Interval lookups only, so it can be asked every frame. */
  pictureAt(frame: number): OnAirPicture {
    const { stack, covered, fallback } = stackAt(this.index, frame);
    const picture = stack.some(entry => !isSound(entry));
    // With no picture on any track the last scene stays on program; sound joins it.
    const layered = picture || !fallback ? stack : [...stack, fallback].sort(stackOrder);
    const layers: CompositionLayer[] = layered.flatMap(entry => sceneNamesOf(entry).map(sceneName => ({ sceneName })));
    const camera = stack.find(isScene);
    const held = !picture && !camera ? fallback : undefined;
    const top = layered[0];
    const target: PictureTarget = layers.length > 1 ? { kind: 'composition', sceneName: compositionScene(this.index.projectId), layers }
      : top && 'media' in top ? { kind: 'clip', sceneName: top.media.sceneName, clipId: top.media.clipId }
        : camera ? { kind: 'scene', sceneName: layers[0]!.sceneName, cueId: camera.cue.id }
          : { kind: 'hold', cueId: held?.cue.id ?? null, sceneName: held ? layers[0]!.sceneName : null };
    const clip = (event: ManagedMediaEvent): PictureClip => this.clipAt(event, frame);
    return { frame, target,
      camera: camera ? { cueId: camera.cue.id, held: false } : held ? { cueId: held.cue.id, held: true } : null,
      clips: stack.flatMap(entry => 'media' in entry && !isSound(entry) ? [clip(entry.media)] : []),
      covered: covered.map(clip),
      sounds: stack.flatMap(entry => 'media' in entry && isSound(entry) ? [clip(entry.media)] : []),
      shows: this.index.activeShows.at(frame).sort((a, b) => a.order - b.order).map(entry => entry.show) };
  }

  /** Every frame where the picture can change: clip, camera and show source starts and ends, in order. */
  cutPoints(): readonly number[] { return this.index.cuts; }
  /** The "show source" Cues that are spans of the picture: their shows and hides are picture state, not point actions. */
  showCueIds(): ReadonlySet<string> { return this.index.showCues; }

  /** The output work that puts the picture at `frame` on program, from `pictureAt`. */
  at(frame: number): SceneWork {
    const { target, clips, sounds } = this.pictureAt(frame);
    switch (target.kind) {
      case 'composition': return {
        media: this.inStackOrder([...clips, ...sounds]).map(event => ({ ...event, deferSceneSwitch: true })),
        cues: [{ scheduledFrame: frame, executionId: crypto.randomUUID(), cue: {
          id: `timeline-composition:${this.index.itemId}`, name: '更新时间线叠加', enabled: true, notes: '',
          timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
          actions: [{ id: `timeline-composition:${this.index.itemId}:scene`, label: '按轨道顺序叠加', kind: 'obs.setProgramScene', sceneName: target.sceneName, sceneLayers: target.layers.map(layer => layer.sceneName) }]
        } }] };
      case 'clip': return { media: [this.event(target.clipId)], cues: [] };
      case 'scene':
      case 'hold': {
        // With no underlying clip, retain the last scene, without replaying its nonvisual actions.
        const cue = target.cueId === null ? undefined : this.index.cues.get(target.cueId);
        return { media: [], cues: cue ? [{ cue: { ...cue, actions: cue.actions.filter((action) => action.kind === 'obs.setProgramScene') }, scheduledFrame: frame, executionId: crypto.randomUUID() }] : [] };
      }
    }
  }

  /** The preview drawn without OBS: the camera in the picture (or the one held), and every clip in it, top first. */
  picture(frame: number): ScenePicture {
    const { camera, clips, sounds } = this.pictureAt(frame);
    return { camera: camera ? this.index.cues.get(camera.cueId) ?? null : null,
      clipIds: this.inStackOrder([...clips, ...sounds]).map(event => event.clipId) };
  }

  /** The frames each clip and camera is on air, from `pictureAt`: keyed
   * `media:<clip id>` / `cue:<cue id>`, ranges in order and merged. Every
   * part the output plays has an entry; an empty one is covered all along. A
   * part with no entry is not in the picture (hidden track, disabled cue, a
   * clip the song audio already plays). The camera held on program after its
   * end is not counted: that is not its span. */
  airtime(): Map<string, FrameRange[]> {
    const { media, scenes, cuts } = this.index;
    const result = new Map<string, FrameRange[]>([...media.map(entry => `media:${entry.event.clipId}`),
      ...scenes.map(entry => `cue:${entry.cue.id}`)].map(key => [key, []]));
    for (const [order, start] of cuts.entries()) {
      const end = cuts[order + 1];
      if (end === undefined) break;
      const { camera, clips, sounds } = this.pictureAt(start);
      const keys = [...clips, ...sounds].map(clip => `media:${clip.clipId}`);
      if (camera && !camera.held) keys.push(`cue:${camera.cueId}`);
      for (const key of keys) {
        const ranges = result.get(key)!;
        const last = ranges.at(-1);
        if (last?.end === start) last.end = end;
        else ranges.push({ start, end });
      }
    }
    return result;
  }

  /** Visible entries, including a camera's end revealing a clip midway. Built
   * once per playback snapshot; no hidden clip starts merely to be preloaded. */
  preloadEntries(): ManagedMediaEvent[] {
    const boundaries = [...new Set([0, ...this.index.cuts])].sort((a, b) => a - b);
    const entries: ManagedMediaEvent[] = []; let previous = new Set<string>();
    for (const frame of boundaries) {
      const visible = this.at(frame).media;
      for (const event of visible) if (event.assetKind !== 'image' && !previous.has(event.clipId)) entries.push({ ...event, frameNumber: frame,
        sourceOffsetMs: event.sourceOffsetMs + Math.round((frame - event.frameNumber) * 1000 / this.fps) });
      previous = new Set(visible.map(event => event.clipId));
    }
    return entries;
  }

  private event(clipId: string): ManagedMediaEvent {
    const event = this.index.events.get(clipId);
    if (!event) throw new Error(`画面里的素材片段不存在：${clipId}`);
    return event;
  }
  /** The clips' start events, top track first, as the picture stacks them. */
  private inStackOrder(clips: readonly PictureClip[]): ManagedMediaEvent[] {
    return clips.map(clip => mediaEntry(this.index, this.event(clip.clipId))).sort(stackOrder).map(entry => entry.media);
  }
  private clipAt(event: ManagedMediaEvent, frame: number): PictureClip {
    return { clipId: event.clipId, sourceName: event.sourceName, assetId: event.assetId, layerId: event.layerId, sceneName: event.sceneName,
      offsetMs: event.sourceOffsetMs + Math.round((frame - event.frameNumber) * 1000 / this.fps),
      continuesFrom: this.index.continues.get(event.clipId) };
  }
}

type StackEntry = { key: string; layer: number; start: number } & ({ cue: LinkCue } | { media: ManagedMediaEvent });
type SceneEntry = StackEntry & { cue: LinkCue };
const isSound = (entry: StackEntry): boolean => 'media' in entry && entry.media.assetKind === 'audio';
const isScene = (entry: StackEntry): entry is SceneEntry => 'cue' in entry;
/** Top track first; on one track the later start; then by key, so ties never depend on input order. */
const stackOrder = (a: StackEntry, b: StackEntry): number => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key);
const compositionScene = (projectId: string): string => `团播联动台·叠加·${projectId}`;
const layerOrder = (index: SceneIndex, id?: string): number => id ? index.layers.get(id) ?? -1 : -1;
type MediaEntry = StackEntry & { media: ManagedMediaEvent };
const mediaEntry = (index: SceneIndex, media: ManagedMediaEvent): MediaEntry =>
  ({ key: `media:${media.clipId}`, layer: layerOrder(index, media.layerId), start: media.frameNumber, media });
const sceneEntry = (index: SceneIndex, { cue, start }: Scene): SceneEntry =>
  ({ key: `cue:${cue.id}`, layer: layerOrder(index, cue.layerId), start, cue });
function sceneNamesOf(entry: StackEntry): string[] {
  return 'media' in entry ? [entry.media.sceneName]
    : entry.cue.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : []);
}

/** On air at `frame`, top track first: picture layers down to the first camera
 * (a camera is a complete frame), plus every playing sound clip on any track,
 * since sound has no picture to cover or be covered. `covered`: the clips below
 * that camera. `fallback` is the scene kept on program when no track has a
 * picture: the last one that ended. */
function stackAt(index: SceneIndex, frame: number): { stack: StackEntry[]; covered: ManagedMediaEvent[]; fallback: SceneEntry | undefined } {
  const candidates: StackEntry[] = [
    ...index.activeScenes.at(frame).map(scene => sceneEntry(index, scene)),
    ...index.activeMedia.at(frame).map(media => mediaEntry(index, media))
  ].sort(stackOrder);
  const cameraIndex = candidates.findIndex(isScene);
  const stack = candidates.filter((candidate, order) => cameraIndex < 0 || order <= cameraIndex || isSound(candidate));
  const covered = cameraIndex < 0 ? [] : candidates.flatMap((candidate, order) =>
    order > cameraIndex && 'media' in candidate && candidate.media.assetKind !== 'audio' ? [candidate.media] : []);
  const last = index.byEnd[firstAfter(index.ends, frame) - 1];
  return { stack, covered, fallback: last && sceneEntry(index, last) };
}

/** A clip carries on from the one before it when both play on the same decoder,
 * the earlier one ends on the later one's first frame, and the source runs on
 * from where it was (within half a frame): a clip split in two. */
function continuations(media: readonly Media[], fps: number): Map<string, string> {
  const result = new Map<string, string>();
  const decoderAt = (event: ManagedMediaEvent, frame: number): string => `${event.sourceName}\n${event.layerId}\n${frame}`;
  const byEnd = new Map<string, Media[]>();
  for (const entry of media) {
    const key = decoderAt(entry.event, entry.end);
    byEnd.set(key, [...byEnd.get(key) ?? [], entry]);
  }
  for (const { event } of media) {
    const before = byEnd.get(decoderAt(event, event.frameNumber))?.find(entry => entry.event.assetId === event.assetId
      && Math.abs(entry.event.sourceOffsetMs + (entry.end - entry.event.frameNumber) * 1000 / fps - event.sourceOffsetMs) <= 500 / fps);
    if (before) result.set(event.clipId, before.event.clipId);
  }
  return result;
}

function firstAfter(frames: readonly number[], frame: number): number {
  let low = 0, high = frames.length;
  while (low < high) { const middle = (low + high) >>> 1; if (frames[middle]! <= frame) low = middle + 1; else high = middle; }
  return low;
}
