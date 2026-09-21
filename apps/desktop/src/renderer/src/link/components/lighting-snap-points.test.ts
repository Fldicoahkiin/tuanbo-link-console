import { expect, it } from 'vitest';
import { createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { lightingSnapPoints } from './timeline-snap-points';
it('灯光吸附仅采用音频范围、节拍和 Cue，排除自身与越界内容', () => {
  const document = createLightingDocument();
  document.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 1000, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'self', kind: 'ma2', action: 'go', executor: '1.101', label: '1', at: 200 }, { id: 'other', kind: 'ma2', action: 'go', executor: '1.101', label: '2', at: 500 }, { id: 'outside', kind: 'ma2', action: 'go', executor: '1.101', label: '3', at: 8000 }] }] })];
  expect(lightingSnapPoints(document, [500, 1000, 1000, 7000], 4000, 'self')).toEqual([0, 500, 1000, 1500, 4000]);
});
