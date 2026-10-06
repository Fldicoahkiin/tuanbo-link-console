import { compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import { resolveTimelineCueSpan } from './timeline-state';
import { playbackFramesPerSecond, timecodeToFrameNumber } from './mtc-timecode';
import type { RuntimeUpdate } from './cue-runtime';
import type { LinkCue, LinkProject } from '@tb/schema';

type SceneWork = { media: ManagedMediaEvent[]; cues: RuntimeUpdate['dueCues'] };
type SceneIndex = {
  projectId: string; itemId: string; layers: ReadonlyMap<string, number>;
  scenes: { cue: LinkCue; start: number; end: number | null }[];
  media: { event: ManagedMediaEvent; end: number }[];
  ends: number[];
  sceneStarts: number[];
  visualStarts: number[];
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
    const scenes = item.cues.filter(cue => cue.enabled && (!cue.layerId || visible.has(cue.layerId)) && cue.actions.some(action => action.kind === 'obs.setProgramScene'))
      .map(cue => ({ cue, start: timecodeToFrameNumber(cue.timecode, project.timebase.frameRate), end: cue.durationMs === undefined ? null : resolveTimelineCueSpan(cue, project.timebase.frameRate).endFrame }))
      .sort((a, b) => a.start - b.start);
    const stops = new Map(events.filter(event => event.phase === 'stop').map(event => [event.clipId, event.frameNumber]));
    const media = events.filter(event => event.phase === 'start').map(event => ({ event, end: stops.get(event.clipId) ?? -1 }));
    this.index = { projectId: project.projectId, itemId, layers, scenes, media,
      ends: scenes.flatMap(scene => scene.end === null ? [] : [scene.end]).sort((a, b) => a - b),
      sceneStarts: scenes.map(scene => scene.start),
      visualStarts: media.filter(entry => entry.event.assetKind !== 'audio').map(entry => entry.event.frameNumber).sort((a, b) => a - b),
      activeScenes: new IntervalIndex(scenes.flatMap(scene => scene.end === null ? [] : [{ start: scene.start, end: scene.end, value: scene }])),
      activeMedia: new IntervalIndex(media.map(entry => ({ start: entry.event.frameNumber, end: entry.end, value: entry.event }))) };
  }
  at(frame: number): SceneWork { return outputAt(this.index, frame); }
  /** Visible entries, including a camera's end revealing a clip midway. Built
   * once per playback snapshot; no hidden clip starts merely to be preloaded. */
  preloadEntries(): ManagedMediaEvent[] {
    const boundaries = [...new Set([0, ...this.index.media.flatMap(entry => [entry.event.frameNumber, entry.end]),
      ...this.index.scenes.flatMap(entry => entry.end === null ? [entry.start] : [entry.start, entry.end])])].filter(frame => frame >= 0).sort((a, b) => a - b);
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
}

/** A finite camera clip temporarily covers lower tracks; its end reveals their current position. */
export function sceneOutputAt(project: LinkProject, itemId: string, frame: number): SceneWork {
  return new SceneOutputTimeline(project, itemId).at(frame);
}
function outputAt(index: SceneIndex, frame: number): SceneWork {
  const { itemId } = index;
  const layerOrder = (id?: string): number => id ? index.layers.get(id) ?? -1 : -1;
  const lastScene = firstAfter(index.sceneStarts, frame) - 1;
  const latestSceneStart = index.sceneStarts[lastScene] ?? -1;
  const latestMediaStart = index.visualStarts[firstAfter(index.visualStarts, frame) - 1] ?? -1;
  const activeScenes = index.activeScenes.at(frame);
  let firstLatestScene = lastScene;
  for (let cursor = lastScene; cursor >= 0 && index.scenes[cursor]!.start === latestSceneStart; cursor--) {
    const entry = index.scenes[cursor]!; firstLatestScene = cursor;
    // A point switch holds until the next visual start, not forever over media.
    if (entry.end === null && latestMediaStart <= entry.start) activeScenes.push(entry);
  }
  const activeMedia = index.activeMedia.at(frame);
  const candidates = [
    ...activeScenes.map(({ cue, start }) => ({ key: `cue:${cue.id}`, layer: layerOrder(cue.layerId), start, cue })),
    ...activeMedia.map((media) => ({ key: `media:${media.clipId}`, layer: layerOrder(media.layerId), start: media.frameNumber, media }))
  ].sort((a, b) => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key));
  const target = candidates[0];
  // Camera scenes are complete frames. Keep their appearance and place every
  // active media layer above the first camera in an application-owned scene.
  const cameraIndex = candidates.findIndex(candidate => 'cue' in candidate);
  const stack = cameraIndex < 0 ? candidates : candidates.slice(0, cameraIndex + 1);
  const layers = stack.flatMap(candidate => 'media' in candidate
    ? candidate.media.sceneName ? [candidate.media.sceneName] : []
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
  const cue = target && 'cue' in target ? target.cue : index.scenes[firstLatestScene]?.cue;
  return { media: [], cues: cue ? [{ cue: { ...cue, actions: cue.actions.filter((action) => action.kind === 'obs.setProgramScene') }, scheduledFrame: frame, executionId: crypto.randomUUID() }] : [] };
}

export function sceneBoundaryWork(project: LinkProject, itemId: string, previous: number, frame: number, due: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]): SceneWork {
  if (project.obsOutputMode !== 'scenes') return { cues: due, media };
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
  const selection = single?.sceneName && !single.deferSceneSwitch && retained.has(single.clipId)
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
