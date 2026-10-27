import { expect, it } from 'vitest';
import { programContents } from './program-contents';

it('节目卡片分开数灯光点、动作和素材，空的不写', () => {
  const lighting = { tracks: [{ clips: [{ events: [1, 2] }, { events: [3] }] }] };
  expect(programContents({ lighting, cues: [], referenceMediaClips: [] })).toBe('3 个灯光点');
  expect(programContents({ lighting, cues: [1, 2], referenceMediaClips: [1] })).toBe('3 个灯光点 · 2 个动作 · 1 个素材');
  expect(programContents({ cues: [], referenceMediaClips: [] })).toBe('还没有编排');
});
