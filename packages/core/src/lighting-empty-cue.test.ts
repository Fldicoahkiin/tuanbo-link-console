import { expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, lightingEventSchema } from '@tb/schema';
import { placeEmptyLightingCue } from './lighting-empty-cue';
import { compileLightingPackets, compileLightingNetworkActions } from './lighting-playback';
import { moveLightingEffect } from './lighting-effect-group';

it('空 Cue 保存重开和移动保持为空，不继承控台绑定或要求 MIDI 输出', () => {
  const created = placeEmptyLightingCue(createLightingDocument(), 'empty', 1000, 10000);
  const reopened = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(created)));
  expect(reopened.tracks[0]?.clips[0]?.events).toEqual([{ id: 'empty', kind: 'empty-cue', at: 1000, label: '' }]);
  expect(reopened.tracks[0]?.cueStamp).toBeUndefined();
  expect(moveLightingEffect(reopened, 'empty', 2500, 10000).tracks[0]?.clips[0]?.events[0]?.at).toBe(2500);
  expect(compileLightingPackets(reopened)).toEqual([]);
  expect(compileLightingNetworkActions(reopened)).toEqual([]);
  expect(lightingEventSchema.safeParse({ id: 'empty', kind: 'empty-cue', at: 1000, label: '', sequence: 9907 }).success).toBe(false);
});

it('空 Cue 拒绝范围外位置及锁定轨道修改', () => {
  expect(() => placeEmptyLightingCue(createLightingDocument(), 'empty', 10000, 10000)).toThrow('音频范围');
  const created = placeEmptyLightingCue(createLightingDocument(), 'empty', 1000, 10000);
  created.tracks[0]!.locked = true;
  expect(() => placeEmptyLightingCue(created, 'empty', 1000, 10000)).toThrow();
});
