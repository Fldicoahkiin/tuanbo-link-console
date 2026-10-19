import { expect, it } from 'vitest';
import type { Ma2CueAttributes } from '@tb/schema';
import { emptyMa2AttributeFilter, ma2CueAttributeState, matchesMa2AttributeFilter } from './ma2-attribute-filter';

function cue(presets: string[]): Ma2CueAttributes {
  return { sequence: 1, cueIndex: 1, attributes: presets, groups: presets.map(attribute => ({ attribute, attributeName: attribute, presetType: attribute, presetName: attribute, feature: attribute, featureName: attribute })), fixtureIds: [], hasEffects: false, unknownChannels: 0, readAt: new Date().toISOString(), content: { state: 'complete', issues: [], parts: [0], hasCommands: false, hasPlaybackSettings: false, tracking: 'none', rows: [] } };
}
it('distinguishes pure intensity, compound cues, all/any matching and effects', () => {
  const mixed = cue(['DIMMER', 'COLOR']);
  expect(matchesMa2AttributeFilter(mixed, { ...emptyMa2AttributeFilter, roles: ['intensity'] })).toBe(true);
  expect(matchesMa2AttributeFilter(mixed, { ...emptyMa2AttributeFilter, roles: ['intensity'], mode: 'only' })).toBe(false);
  expect(matchesMa2AttributeFilter(cue(['DIMMER']), { ...emptyMa2AttributeFilter, roles: ['intensity'], mode: 'only' })).toBe(true);
  expect(matchesMa2AttributeFilter(mixed, { ...emptyMa2AttributeFilter, roles: ['intensity', 'position'] })).toBe(false);
  expect(matchesMa2AttributeFilter(mixed, { ...emptyMa2AttributeFilter, roles: ['intensity', 'position'], mode: 'contains-any' })).toBe(true);
  expect(matchesMa2AttributeFilter({ ...cue(['DIMMER']), hasEffects: true }, { ...emptyMa2AttributeFilter, roles: ['intensity'], mode: 'only' })).toBe(false);
});
it('never equates no filter, unread, missing payload, failed or tracking data with empty cues', () => {
  const empty = cue([]);
  const filter = { ...emptyMa2AttributeFilter, status: 'empty' as const };
  expect(matchesMa2AttributeFilter(undefined, emptyMa2AttributeFilter)).toBe(true);
  expect(matchesMa2AttributeFilter(empty, filter)).toBe(true);
  expect(matchesMa2AttributeFilter(undefined, filter)).toBe(false);
  const legacy = { ...empty }; delete legacy.content;
  expect(matchesMa2AttributeFilter(legacy, filter)).toBe(false);
  expect(matchesMa2AttributeFilter(empty, filter, true)).toBe(false);
  expect(matchesMa2AttributeFilter({ ...empty, content: { ...empty.content!, tracking: 'possible' } }, filter)).toBe(false);
  expect(matchesMa2AttributeFilter({ ...empty, content: { ...empty.content!, hasCommands: true } }, filter)).toBe(false);
  expect(ma2CueAttributeState({ ...empty, content: { ...empty.content!, state: 'partial', issues: ['missing Part'] } })).toBe('partial');
});
it('does not claim exact attribute sets for partial reads or stale results', () => {
  const data = { ...cue(['DIMMER']), content: { ...cue([]).content!, state: 'partial' as const, issues: ['missing'] } };
  expect(matchesMa2AttributeFilter(data, { ...emptyMa2AttributeFilter, mode: 'only', roles: ['intensity'] })).toBe(false);
  expect(matchesMa2AttributeFilter(data, { ...emptyMa2AttributeFilter, roles: ['intensity'] }, true)).toBe(false);
});
it('allows Beam parent or Shutter child filters without treating prism as shutter',()=>{
  const shutter=cue(['SHUTTER']); shutter.groups![0]={attribute:'SHUTTER',attributeName:'Shutter',presetType:'BEAM',presetName:'Beam',feature:'SHUTTER',featureName:'Shutter'};
  const filter={...emptyMa2AttributeFilter,mode:'only' as const,roles:['shutter'] as const};
  expect(matchesMa2AttributeFilter(shutter,{...filter,roles:[...filter.roles]})).toBe(true);
  expect(matchesMa2AttributeFilter(shutter,{...filter,roles:['beam']})).toBe(true);
  const prism={...shutter,attributes:['SHUTTER','PRISMA'],groups:[...shutter.groups!,{attribute:'PRISMA',attributeName:'Prism',presetType:'BEAM',presetName:'Beam',feature:'PRISMA',featureName:'Prism'}]};
  expect(matchesMa2AttributeFilter(prism,{...filter,roles:['shutter']})).toBe(false);
  expect(matchesMa2AttributeFilter(prism,{...filter,roles:['beam']})).toBe(true);
});
