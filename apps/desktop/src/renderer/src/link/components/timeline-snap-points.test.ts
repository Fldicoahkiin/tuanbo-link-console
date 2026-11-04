import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { resolveTimelineState } from '@tb/core/link';
import { timelineSnapPoints } from './timeline-snap-points';
import { timelineInteractionTime } from './timeline-geometry';

it('播放头吸附场景的左右边缘，与缩放无关', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('吸附'), rundown: [{ id: 'song', title: '测试',
    cues: [{ id: 'scene', name: '场景', timecode: { hours: 0, minutes: 0, seconds: 3, frames: 0 }, durationMs: 2000,
      actions: [{ id: 'action', kind: 'obs.setProgramScene', label: '场景', sceneName: '场景' }] }] }] });
  const item = project.rundown[0]!;
  const state = resolveTimelineState(project, item, 0);
  const points = timelineSnapPoints(state, item.cues, '30');
  expect(points).toContain(3000);
  expect(points).toContain(5000);
  for (const zoom of [32, 64]) expect(timelineInteractionTime(5000 - 6 / zoom * 1000, 30000, '30', true, points, 14 / zoom * 1000)).toBe(5000);
  expect(timelineSnapPoints(state, item.cues, '30', undefined, { kind: 'cue', id: 'scene' })).toEqual([0]);
});
