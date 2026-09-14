import { compileManagedMediaTimeline, resolveTimelineCueSpan, timecodeToFrameNumber, type ManagedMediaEvent, type RuntimeUpdate } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

type SceneWork = { media: ManagedMediaEvent[]; cues: RuntimeUpdate['dueCues'] };
/** A finite camera clip temporarily covers lower tracks; its end reveals their current position. */
export function sceneOutputAt(project: LinkProject, itemId: string, frame: number): SceneWork {
  const item = project.rundown.find((entry) => entry.id === itemId);
  if (!item) throw new Error('定位节目不存在');
  const layerOrder = (id?: string): number => item.visualLayers.findIndex((layer) => layer.id === id);
  const visible = (id?: string): boolean => !id || item.visualLayers.some((layer) => layer.id === id && layer.visible);
  const scenes = item.cues.filter((cue) => cue.enabled && visible(cue.layerId) && cue.actions.some((action) => action.kind === 'obs.setProgramScene')
    && timecodeToFrameNumber(cue.timecode, project.timebase.frameRate) <= frame);
  const events = compileManagedMediaTimeline(project, itemId).events;
  const activeScenes = scenes.filter((cue) => {
    if (cue.durationMs !== undefined) return resolveTimelineCueSpan(cue, project.timebase.frameRate).endFrame > frame;
    // A point scene switch holds until the next visual start, not forever above later media.
    const start = timecodeToFrameNumber(cue.timecode, project.timebase.frameRate);
    return !scenes.some((next) => timecodeToFrameNumber(next.timecode, project.timebase.frameRate) > start)
      && !events.some((event) => event.phase === 'start' && event.assetKind !== 'audio' && event.frameNumber > start && event.frameNumber <= frame);
  });
  const activeMedia = events.filter((event) => event.phase === 'start' && event.frameNumber <= frame
    && events.some((stop) => stop.clipId === event.clipId && stop.phase === 'stop' && stop.frameNumber > frame));
  const candidates = [
    ...activeScenes.map((cue) => ({ key: `cue:${cue.id}`, layer: layerOrder(cue.layerId), start: timecodeToFrameNumber(cue.timecode, project.timebase.frameRate), cue })),
    ...activeMedia.map((media) => ({ key: `media:${media.clipId}`, layer: layerOrder(media.layerId), start: media.frameNumber, media }))
  ].sort((a, b) => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key));
  const target = candidates[0];
  if (target && 'media' in target) return { media: [target.media], cues: [] };
  // With no underlying clip, retain the last scene, without replaying its nonvisual actions.
  const cue = target && 'cue' in target ? target.cue : scenes.sort((a, b) => timecodeToFrameNumber(b.timecode, project.timebase.frameRate) - timecodeToFrameNumber(a.timecode, project.timebase.frameRate))[0];
  return { media: [], cues: cue ? [{ cue: { ...cue, actions: cue.actions.filter((action) => action.kind === 'obs.setProgramScene') }, scheduledFrame: frame, executionId: crypto.randomUUID() }] : [] };
}

export function sceneBoundaryWork(project: LinkProject, itemId: string, previous: number, frame: number, due: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]): SceneWork {
  if (project.obsOutputMode !== 'scenes') return { cues: due, media };
  const hasSceneEnd = project.rundown.find((item) => item.id === itemId)?.cues.some((cue) => {
    if (!cue.enabled || cue.durationMs === undefined || !cue.actions.some((action) => action.kind === 'obs.setProgramScene')) return false;
    const end = resolveTimelineCueSpan(cue, project.timebase.frameRate).endFrame;
    return previous < end && end <= frame;
  });
  if (!due.length && !media.length && !hasSceneEnd) return { cues: [], media: [] };
  const before = sceneOutputAt(project, itemId, previous);
  const after = sceneOutputAt(project, itemId, frame);
  const key = (work: SceneWork): string | undefined => work.media[0]?.clipId ?? work.cues[0]?.cue.id;
  const cues = due.flatMap((entry) => {
    const actions = entry.cue.actions.filter((action) => action.kind !== 'obs.setProgramScene');
    return actions.length ? [{ ...entry, cue: { ...entry.cue, actions } }] : [];
  });
  const stops = media.filter((event) => event.phase === 'stop');
  if (key(before) === key(after)) return { cues, media: stops };
  return { cues: [...cues, ...after.cues], media: [...stops, ...after.media.map((event) => ({ ...event, frameNumber: frame }))] };
}
