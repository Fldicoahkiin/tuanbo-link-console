import { expect, it } from 'vitest';
import { createLightingDocument } from '@tb/schema';
import { ma2SongPoints, setLightingEffectSpeed } from '@tb/core/link';
import { cueEventEntries } from './cue-event-view';
import { saveCueIngredients } from './LightingCueComposer';
import { effectSpeedView } from './LightingCueEffectSpeed';

const materials = [
  { name: '画圆', sequence: 294, cue: '1', executor: '', delayMs: 0 },
  { name: '频闪', sequence: 346, cue: '2', executor: '', delayMs: 0 }
];
function point() {
  const document = saveCueIngredients({ ...createLightingDocument(), version: 2, outputMode: 'network', tempos: [{ beat: 0, bpm: 128, numerator: 4, denominator: 4 }] }, materials, '副歌', 2000, 10000, 'point');
  return setLightingEffectSpeed(document, 'point', { mode: 'song', beats: 2 });
}

it('效果速度设在整个组合点上，换算成本点的歌曲速度，时间线点位带标记', () => {
  const document = point();
  expect(effectSpeedView(document, 'point')).toMatchObject({ pointId: 'point', atMs: 2000, speed: { mode: 'song', beats: 2 }, bpm: 64, songBpm: 128, error: '' });
  expect(ma2SongPoints(document)).toEqual([expect.objectContaining({ id: 'point', effectBpm: 64 })]);
  expect(cueEventEntries(document)).toEqual([expect.objectContaining({ id: 'point', effectSpeed: true })]);
  expect(cueEventEntries(setLightingEffectSpeed(document, 'point', undefined))[0]?.effectSpeed).toBe(false);
});
it('改点位素材和名称后效果速度保留，改成埋步的素材不带速度', () => {
  const document = point();
  const changed = saveCueIngredients(document, [materials[0]!], '副歌改', 2000, 10000, 'point');
  expect(effectSpeedView(changed, 'point').speed).toEqual({ mode: 'song', beats: 2 });
  const prepared = saveCueIngredients(document, [{ ...materials[0]!, preparation: { cue: '5', leadMs: 500 } }], '副歌', 2000, 10000, 'point');
  expect(prepared.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).some(event => event.kind === 'ma2' && event.effectSpeed)).toBe(false);
});
it('换算超出控台范围时保留设置并显示原因，便于改档', () => {
  const document = { ...point(), tempos: [{ beat: 0, bpm: 300, numerator: 4, denominator: 4 }] };
  const fast = setLightingEffectSpeed(document, 'point', { mode: 'song', beats: 0.25 });
  const view = effectSpeedView(fast, 'point');
  expect(view).toMatchObject({ speed: { mode: 'song', beats: 0.25 }, bpm: null });
  expect(view.error).toContain('超出');
});
