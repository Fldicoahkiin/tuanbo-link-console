import { sceneOutputAt } from './scene-output-timeline';
import { compileManagedMediaTimeline, resolveTimelineState, millisecondsToFrameNumber, frameNumberToTimecode, type MtcSample } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

export function internalSample(project: LinkProject, positionMs: number): MtcSample {
  const totalFrames = millisecondsToFrameNumber(positionMs, project.timebase.frameRate);
  return { totalFrames, timecode: frameNumberToTimecode(totalFrames, project.timebase.frameRate),
    frameRate: project.timebase.frameRate, direction: 'forward', receivedAtMs: performance.now() };
}

export function internalSeekState(project: LinkProject, itemId: string, positionMs: number) {
  const item = project.rundown.find((entry) => entry.id === itemId);
  if (!item) throw new Error('定位节目不存在');
  if (project.obsOutputMode === 'scenes') return sceneOutputAt(project, itemId, millisecondsToFrameNumber(positionMs, project.timebase.frameRate));
  const state = resolveTimelineState(project, item, positionMs);
  const media = compileManagedMediaTimeline(project, itemId).events.filter((event) =>
    event.phase === 'start' && state.activeVisualClipIds.includes(event.clipId));
  const cues = state.visualObsCues.filter((entry) => entry.visible).map(({ cue, startFrame }) => ({
    cue: { ...cue, actions: cue.actions.filter((action) => action.kind === 'obs.setSceneItemEnabled'
      || action.kind === 'obs.setSceneItemTransform' || action.kind === 'obs.setSceneItemIndex') },
    scheduledFrame: startFrame, executionId: crypto.randomUUID()
  }));
  return { media, cues };
}
