import { compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import { resolveTimelineCueSpan } from './timeline-state';
import { impliedSceneEnds, isCameraCue } from './content-timeline';
import { playbackFramesPerSecond, timecodeToFrameNumber } from './mtc-timecode';
import type { RuntimeUpdate } from './cue-runtime';
import type { LinkCue, LinkProject } from '@tb/schema';

type SceneWork = { media: ManagedMediaEvent[]; cues: RuntimeUpdate['dueCues'] };
/** The camera scene and clips the output shows at `frame`, top first, for a
 * preview drawn without OBS. Same rule as the output itself. */
export type ScenePicture = { camera: LinkCue | null; clipIds: string[] };
export type FrameRange = { start: number; end: number };
type SceneIndex = {
  projectId: string; itemId: string; layers: ReadonlyMap<string, number>;
  scenes: { cue: LinkCue; start: number; end: number }[];
  media: { event: ManagedMediaEvent; end: number }[];
  /** Scenes by end, for the one kept on program when no track has a picture. */
  byEnd: SceneIndex['scenes'];
  ends: number[];
  activeScenes: IntervalIndex<SceneIndex['scenes'][number]>;
  activeMedia: IntervalIndex<ManagedMediaEvent>;
};

/** Sorted starts plus prefix end bounds skip expired suffixes on arbitrary
 * seeks. Queries retain nested and overlapping finite camera intervals. */
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

/** Owned by a playback session. Ordinary frames do not compile the project, and
 * document history cannot retain a global cache of every old revision. */
export class SceneOutputTimeline {
  private readonly index: SceneIndex;
  private readonly fps: number;
  constructor(project: LinkProject, itemId: string, events = compileManagedMediaTimeline(project, itemId).events) {
    this.fps = playbackFramesPerSecond(project.timebase.frameRate);
    const item = project.rundown.find(entry => entry.id === itemId);
    if (!item) throw new Error('定位节目不存在');
    const layers = new Map(item.visualLayers.map((layer, order) => [layer.id, order]));
    const visible = new Set(item.visualLayers.filter(layer => layer.visible).map(layer => layer.id));
    // A camera saved without a length (older projects) plays the frames it did before.
    const implied = impliedSceneEnds(project, item);
    const scenes = item.cues.filter(cue => cue.enabled && (!cue.layerId || visible.has(cue.layerId)) && isCameraCue(cue))
      .map(cue => ({ cue, start: timecodeToFrameNumber(cue.timecode, project.timebase.frameRate),
        end: implied.get(cue.id) ?? resolveTimelineCueSpan(cue, project.timebase.frameRate).endFrame }))
      .sort((a, b) => a.start - b.start);
    const stops = new Map(events.filter(event => event.phase === 'stop').map(event => [event.clipId, event.frameNumber]));
    const media = events.filter(event => event.phase === 'start').map(event => ({ event, end: stops.get(event.clipId) ?? -1 }));
    const order = (cue: LinkCue): number => cue.layerId ? layers.get(cue.layerId) ?? -1 : -1;
    this.index = { projectId: project.projectId, itemId, layers, scenes, media,
      byEnd: [...scenes].sort((a, b) => a.end - b.end || order(b.cue) - order(a.cue) || a.start - b.start),
      ends: scenes.map(scene => scene.end).sort((a, b) => a - b),
      activeScenes: new IntervalIndex(scenes.map(scene => ({ start: scene.start, end: scene.end, value: scene }))),
      activeMedia: new IntervalIndex(media.map(entry => ({ start: entry.event.frameNumber, end: entry.end, value: entry.event }))) };
  }
  at(frame: number): SceneWork { return outputAt(this.index, frame); }
  picture(frame: number): ScenePicture {
    const { stack, fallback } = stackAt(this.index, frame);
    const camera = stack.find(entry => 'cue' in entry);
    return { camera: camera && 'cue' in camera ? camera.cue : stack.some(entry => !isSound(entry)) ? null : fallback?.cue ?? null,
      clipIds: stack.flatMap(entry => 'media' in entry ? [entry.media.clipId] : []) };
  }
  /** The frames each clip and camera is on air, by the same rule as the output:
   * keyed `media:<clip id>` / `cue:<cue id>`, ranges in order and merged. Every
   * part the output plays has an entry; an empty one is covered all along. A
   * part with no entry is not in the picture (hidden track, disabled cue, a
   * clip the song audio already plays). The camera held on program after its
   * end is not counted: that is not its span. */
  airtime(): Map<string, FrameRange[]> {
    const { media, scenes } = this.index;
    const result = new Map<string, FrameRange[]>([...media.map(entry => `media:${entry.event.clipId}`),
      ...scenes.map(entry => `cue:${entry.cue.id}`)].map(key => [key, []]));
    const boundaries = [...new Set([...media.flatMap(entry => [entry.event.frameNumber, entry.end]),
      ...scenes.flatMap(entry => [entry.start, entry.end])])].sort((a, b) => a - b);
    for (const [order, start] of boundaries.entries()) {
      const end = boundaries[order + 1];
      if (end === undefined) break;
      for (const entry of stackAt(this.index, start).stack) {
        const ranges = result.get(entry.key)!;
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
    const boundaries = [...new Set([0, ...this.index.media.flatMap(entry => [entry.event.frameNumber, entry.end]),
      ...this.index.scenes.flatMap(entry => [entry.start, entry.end])])].filter(frame => frame >= 0).sort((a, b) => a - b);
    const entries: ManagedMediaEvent[] = []; let previous = new Set<string>();
    for (const frame of boundaries) {
      const visible = this.at(frame).media;
      for (const event of visible) if (event.assetKind !== 'image' && !previous.has(event.clipId)) entries.push({ ...event, frameNumber: frame,
        sourceOffsetMs: event.sourceOffsetMs + Math.round((frame - event.frameNumber) * 1000 / this.fps) });
      previous = new Set(visible.map(event => event.clipId));
    }
    return entries;
  }
  cross(previous: number, frame: number, due: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]): SceneWork {
    const end = this.index.ends[firstAfter(this.index.ends, previous)];
    if (!due.length && !media.length && (end === undefined || end > frame)) return { cues: [], media: [] };
    const boundary = Math.min(frame, end !== undefined && end <= frame ? end : frame,
      ...due.filter(entry => entry.cue.actions.some(action => action.kind === 'obs.setProgramScene')).map(entry => entry.scheduledFrame),
      ...media.map(event => event.frameNumber));
    return boundaryWork(this.index.itemId, boundary, due, media, this.at(previous), this.at(frame));
  }
  /** Recovery rule B after a position gap: the picture at `frame`, whatever was
   * crossed on the way. Scenes go first so rebuilt shown sources land on the
   * scene now on program; everything is scheduled at `frame`. */
  rebuild(previous: number, frame: number, due: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]): SceneWork {
    // A clip that started and stopped inside the gap never played; there is nothing to stop.
    const started = new Set(media.filter(event => event.phase === 'start').map(event => event.clipId));
    const stops = media.filter(event => event.phase === 'stop' && !started.has(event.clipId)).map(event => ({ ...event, frameNumber: frame }));
    const work = boundaryWork(this.index.itemId, frame, [], stops, this.at(previous), this.at(frame));
    return { cues: [...work.cues, ...shownAt(due, frame)], media: work.media };
  }
  /** Recovery rule B when OBS's picture state is unknown (after a reconnect, or a
   * pause cut a send short): the picture at `frame` from nothing, with every clip
   * on air entering at `frame`, after the `stops` of clips that ended meanwhile. */
  restore(frame: number, shown: RuntimeUpdate['dueCues'], stops: ManagedMediaEvent[] = []): SceneWork {
    const work = boundaryWork(this.index.itemId, frame, [], stops.map(event => ({ ...event, frameNumber: frame })), { cues: [], media: [] }, this.at(frame));
    return { cues: [...work.cues, ...shownAt(shown, frame)], media: work.media };
  }
}

/** Shown-source actions one frame after the scene and clips they land on, since a
 * show acts on the scene then on program; camera switches come from the timeline. */
function shownAt(due: RuntimeUpdate['dueCues'], frame: number): RuntimeUpdate['dueCues'] {
  return due.flatMap((entry) => {
    const actions = entry.cue.actions.filter((action) => action.kind !== 'obs.setProgramScene');
    return actions.length ? [{ ...entry, cue: { ...entry.cue, actions }, scheduledFrame: frame + 1 }] : [];
  });
}

/** A finite camera clip temporarily covers lower tracks; its end reveals their current position. */
export function sceneOutputAt(project: LinkProject, itemId: string, frame: number): SceneWork {
  return new SceneOutputTimeline(project, itemId).at(frame);
}
type StackEntry = { key: string; layer: number; start: number } & ({ cue: LinkCue } | { media: ManagedMediaEvent });
const isSound = (entry: StackEntry): boolean => 'media' in entry && entry.media.assetKind === 'audio';

/** On air at `frame`, top track first: picture layers down to the first camera
 * (a camera is a complete frame), plus every playing sound clip on any track,
 * since sound has no picture to cover or be covered. `fallback` is the scene
 * kept on program when no track has a picture: the last one that ended. */
function stackAt(index: SceneIndex, frame: number): { stack: StackEntry[]; fallback: StackEntry & { cue: LinkCue } | undefined } {
  const layerOrder = (id?: string): number => id ? index.layers.get(id) ?? -1 : -1;
  const candidates: StackEntry[] = [
    ...index.activeScenes.at(frame).map(({ cue, start }) => ({ key: `cue:${cue.id}`, layer: layerOrder(cue.layerId), start, cue })),
    ...index.activeMedia.at(frame).map((media) => ({ key: `media:${media.clipId}`, layer: layerOrder(media.layerId), start: media.frameNumber, media }))
  ].sort((a, b) => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key));
  // Camera scenes are complete frames. Keep their appearance and place every
  // active media layer above the first camera in an application-owned scene.
  const cameraIndex = candidates.findIndex(candidate => 'cue' in candidate);
  const stack = candidates.filter((candidate, order) => cameraIndex < 0 || order <= cameraIndex || isSound(candidate));
  const last = index.byEnd[firstAfter(index.ends, frame) - 1];
  return { stack, fallback: last && { key: `cue:${last.cue.id}`, layer: layerOrder(last.cue.layerId), start: last.start, cue: last.cue } };
}

function outputAt(index: SceneIndex, frame: number): SceneWork {
  const { itemId } = index;
  const { stack: playing, fallback } = stackAt(index, frame);
  // With no picture on any track the last scene stays on program; sound joins it.
  const stack = playing.some(entry => !isSound(entry)) || !fallback ? playing
    : [...playing, fallback].sort((a, b) => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key));
  const target = stack[0];
  const layers = stack.flatMap(candidate => 'media' in candidate
    ? [candidate.media.sceneName]
    : candidate.cue.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : []));
  if (layers.length > 1) {
    const sceneName = `团播联动台·叠加·${index.projectId}`;
    return {
      media: stack.flatMap(candidate => 'media' in candidate ? [{ ...candidate.media, deferSceneSwitch: true }] : []),
      cues: [{ scheduledFrame: frame, executionId: crypto.randomUUID(), cue: {
        id: `timeline-composition:${itemId}`, name: '更新时间线叠加', enabled: true, notes: '',
        timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: `timeline-composition:${itemId}:scene`, label: '按轨道顺序叠加', kind: 'obs.setProgramScene', sceneName, sceneLayers: layers }]
      } }]
    };
  }
  if (target && 'media' in target) return { media: [target.media], cues: [] };
  // With no underlying clip, retain the last scene, without replaying its nonvisual actions.
  const cue = target && 'cue' in target ? target.cue : fallback?.cue;
  return { media: [], cues: cue ? [{ cue: { ...cue, actions: cue.actions.filter((action) => action.kind === 'obs.setProgramScene') }, scheduledFrame: frame, executionId: crypto.randomUUID() }] : [] };
}

export function sceneBoundaryWork(project: LinkProject, itemId: string, previous: number, frame: number, due: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]): SceneWork {
  return new SceneOutputTimeline(project, itemId).cross(previous, frame, due, media);
}
function boundaryWork(itemId: string, frame: number, due: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[], before: SceneWork, after: SceneWork): SceneWork {
  const key = (work: SceneWork): string => JSON.stringify([work.media.map(event => event.clipId), work.cues.map(entry => entry.cue.actions)]);
  const cues = due.flatMap((entry) => {
    const actions = entry.cue.actions.filter((action) => action.kind !== 'obs.setProgramScene');
    return actions.length ? [{ ...entry, cue: { ...entry.cue, actions } }] : [];
  });
  const stops = media.filter((event) => event.phase === 'stop');
  if (key(before) === key(after)) return { cues, media: stops };
  // A change above a playing clip must not seek/pause its decoder again.
  // Keep scene selection separate from media lifecycle when removing an overlay.
  const retained = new Set(before.media.map(event => event.clipId));
  const entering = after.media.filter(event => !retained.has(event.clipId));
  // Adjacent clips on the same owned input reposition that decoder directly.
  // Hiding/stopping it first creates an avoidable inactive/decode cycle and a
  // blank frame. A real gap, different source, or covered clip still stops.
  const physicalStops = stops.filter(stop => !entering.some(start =>
    start.sourceName === stop.sourceName && start.layerId === stop.layerId
    && start.frameNumber === stop.frameNumber));
  const single = after.media.length === 1 ? after.media[0] : undefined;
  const selection = single && !single.deferSceneSwitch && retained.has(single.clipId)
    ? [{ scheduledFrame: frame, executionId: crypto.randomUUID(), cue: {
      id: `timeline-selection:${itemId}`, name: '显示持续播放的素材', enabled: true, notes: '',
      timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      actions: [{ id: `timeline-selection:${itemId}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene' as const, sceneName: single.sceneName }]
    } }] : [];
  return { cues: [...cues, ...after.cues.map(entry => ({ ...entry, scheduledFrame: frame })), ...selection], media: [...physicalStops, ...entering.map((event) => ({ ...event, frameNumber: frame }))] };
}

function firstAfter(frames: readonly number[], frame: number): number {
  let low = 0, high = frames.length;
  while (low < high) { const middle = (low + high) >>> 1; if (frames[middle]! <= frame) low = middle + 1; else high = middle; }
  return low;
}
