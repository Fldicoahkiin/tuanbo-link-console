import { expect, it } from 'vitest';
import { createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { moveLightingEffect, removeLightingEffects } from './lighting-effect-group';
const track = (id: string, at: number) => lightingTrackSchema.parse({ id, name: id, kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: `clip-${id}`, name: id, start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id, at, kind: 'ma2', action: 'goto', sequence: 1, cue: '1', executor: '1.101', label: id, effectGroupId: 'a' }] }] });
it('组合跨轨移动保持间距，并一次删除完整组合', () => {
  const document = { ...createLightingDocument(), tracks: [track('a', 1000), track('b', 1500)] };
  const moved = moveLightingEffect(document, 'a', 2000, 10000);
  expect(moved.tracks.flatMap(value => value.clips.flatMap(clip => clip.events.map(event => event.at)))).toEqual([2000, 2500]);
  expect(removeLightingEffects(moved, ['a']).tracks.flatMap(value => value.clips.flatMap(clip => clip.events))).toEqual([]);
  expect(() => moveLightingEffect(document, 'a', 9700, 10000)).toThrow('超出');
  expect(() => removeLightingEffects({ ...document, tracks: [track('a', 1000), { ...track('b', 1500), locked: true }] }, ['a'])).toThrow('锁定');
});
