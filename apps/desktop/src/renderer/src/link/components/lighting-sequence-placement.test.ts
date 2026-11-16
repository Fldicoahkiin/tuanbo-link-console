import { expect, it, vi } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { lightingSequenceSteps, ma2SongPoints } from '@tb/core/link';
import { placeEffect } from './useLightingEffectStamp';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const sequence = { sequence: 10, complete: true, cues: [1, 2, 3].map(number => ({ number: `${number}.000`, name: `第 ${number} 步` })) };
function fixture() {
  const document = createLightingDocument(); document.tempos = [{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }];
  const track: LightingTrack = { id: 'template', name: '三步', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: 10, cue: '1.000', executor: '' } };
  document.templates = [{ id: 'sequence', name: '三步', nativeSequence: true, track }];
  return document;
}
it('整套三步按一拍依次放入，形成三个独立同步点而非合成一步', () => {
  const result = placeEffect(fixture(), { effectId: 'sequence', ms: 1000, id: 'first' }, 10000, [sequence]);
  expect(ma2SongPoints(result).map(point => [point.atMs, point.cues[0]?.cue])).toEqual([[1000, '1.000'], [1500, '2.000'], [2000, '3.000']]);
  expect(new Set(ma2SongPoints(result).map(point => point.id)).size).toBe(3);
});
it('可调间隔按节拍图换算；未读完整或放不下时整个操作失败，原编排不变', () => {
  const document = fixture();
  expect(lightingSequenceSteps(document, sequence, '', 0, 2).map(step => step.delayMs)).toEqual([0, 1000, 2000]);
  expect(() => placeEffect(document, { effectId: 'sequence', ms: 0, id: 'first' }, 900, [sequence])).toThrow('歌曲结尾');
  expect(() => placeEffect(document, { effectId: 'sequence', ms: 0, id: 'first' }, 10000, [{ ...sequence, complete: false }])).toThrow('还没读完整');
  expect(document.tracks).toEqual([]);
});

it('已识别的歌曲使用真实拍点及分数拍，优先于默认 120 BPM', () => {
  const beats = { state: 'ready' as const, method: 'ibt' as const, taskId: 'test', bpm: 100, beatsPerBar: 4,
    beats: [0, 600, 1300, 2100].map((atMs, i) => ({ id: String(i), sourceId: String(i), atMs, strong: i === 0 })), segments: [], editPointsMs: [], pieces: [] };
  expect(lightingSequenceSteps(fixture(), sequence, '', 0, 1, beats).map(step => step.delayMs)).toEqual([0, 600, 1300]);
  expect(lightingSequenceSteps(fixture(), sequence, '', 300, 0.5, beats).map(step => step.delayMs)).toEqual([0, 300, 650]);
  const intro = { ...beats, beats: [980, 8140.000000000001, 8680, 9220].map((atMs, i) => ({ id: String(i), sourceId: String(i), atMs, strong: false })) };
  expect(lightingSequenceSteps(fixture(), sequence, '', 0, 1, intro)[0]?.delayMs).toBe(0);
});
