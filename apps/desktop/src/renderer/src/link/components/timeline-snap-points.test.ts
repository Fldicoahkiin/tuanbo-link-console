import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { resolveTimelineState } from '@tb/core/link';
import { displayedSceneDuration, timelineSnapPoints } from './timeline-snap-points';
import { timelineInteractionTime } from './timeline-geometry';

it.each([undefined, 2000])('播放头吸附场景的左右边缘，时长 %s', (durationMs) => {
  const project = parseLinkProject({ ...createEmptyLinkProject('吸附'), rundown: [{ id: 'song', title: '测试',
    cues: [{ id: 'scene', name: '场景', timecode: { hours: 0, minutes: 0, seconds: 3, frames: 0 }, durationMs,
      actions: [{ id: 'action', kind: 'obs.setProgramScene', label: '场景', sceneName: '场景' }] }] }] });
  const item = project.rundown[0]!;
  const state = resolveTimelineState(project, item, 0);
  for (const zoom of [32, 64]) {
    const points = timelineSnapPoints(state, item.cues, '30', zoom);
    const end = 3000 + displayedSceneDuration(item.cues[0], zoom);
    expect(points).toContain(3000);
    expect(points).toContain(end);
    expect(timelineInteractionTime(end - 6 / zoom * 1000, 30000, '30', true, points, 14 / zoom * 1000)).toBe(end);
    expect(timelineSnapPoints(state, item.cues, '30', zoom, undefined, { kind: 'cue', id: 'scene' })).toEqual([0]);
  }
});
