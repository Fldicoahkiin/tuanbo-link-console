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
  // Camera scenes are complete frames. Keep their appearance and place every
  // active media layer above the first camera in an application-owned scene.
  const cameraIndex = candidates.findIndex(candidate => 'cue' in candidate);
  const stack = cameraIndex < 0 ? candidates : candidates.slice(0, cameraIndex + 1);
  const layers = stack.flatMap(candidate => 'media' in candidate
    ? candidate.media.sceneName ? [candidate.media.sceneName] : []
    : candidate.cue.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : []));
  if (layers.length > 1) {
    const sceneName = `团播联动台·叠加·${project.projectId}`;
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
  const single = after.media.length === 1 ? after.media[0] : undefined;
  const selection = single?.sceneName && !single.deferSceneSwitch && retained.has(single.clipId)
    ? [{ scheduledFrame: frame, executionId: crypto.randomUUID(), cue: {
      id: `timeline-selection:${itemId}`, name: '显示持续播放的素材', enabled: true, notes: '',
      timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      actions: [{ id: `timeline-selection:${itemId}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene' as const, sceneName: single.sceneName }]
    } }] : [];
  return { cues: [...cues, ...after.cues, ...selection], media: [...stops, ...entering.map((event) => ({ ...event, frameNumber: frame }))] };
}
