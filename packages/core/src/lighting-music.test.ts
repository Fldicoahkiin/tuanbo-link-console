import { expect, it } from 'vitest';
import { createLightingDocument, createLightingMusic, lightingDocumentSchema } from '@tb/schema';
import { changeMusicTempo, musicBeatToMs, musicGrid, snapMusicTime, moveMusicCues, musicBarPosition, setMusicCueLock, lightingPositions } from './lighting-music';

it('128 BPM 网格直接换算，第一拍非零且与绝对 MTC 无关', () => {
  const document = { ...createLightingDocument(), music: { ...createLightingMusic(), firstBeatMs: 14400, accentBars:false }, version: 2 as const };
  for (const [beats, ms] of [[0.25,117.1875],[0.5,234.375],[1,468.75],[8,3750],[32,15000]]) expect(musicBeatToMs(document, beats!) - 14400).toBeCloseTo(ms!, 8);
  expect(snapMusicTime(document, 15000)).toBe(14400);
  expect(snapMusicTime(document, 300)).toBe(300);
  expect(musicGrid(document, 14_400, 30_000).map(value => value.ms)).toEqual([14400,18150,21900,25650,29400]);
  expect(musicGrid({...document,music:{...document.music,accentBars:true}},14400,19000).filter(value=>value.bar).map(value=>value.ms)).toEqual([14400,16275,18150]);
  expect(musicGrid({ ...document, music: { ...document.music, gridBeats: .001 } }, 0, 6 * 3600_000, 40).length).toBeLessThanOrEqual(2001);
});
it('拍号变化重新计算小节；渐快渐慢和三连音不累积舍入误差', () => {
  const document = createLightingDocument(); document.tempos = [{ beat: 0, bpm: 100, numerator: 6, denominator: 8, transition: 'linear' }, { beat: 3, bpm: 160, numerator: 3, denominator: 4, transition: 'linear' }, { beat: 9, bpm: 80, numerator: 3, denominator: 4 }];
  document.version = 2; document.music = { ...createLightingMusic(), gridBeats: 1, triplet: true };
  expect(musicBarPosition(document.tempos, 3)).toEqual({ bar: 2, beat: 1, first: true });
  expect(musicBarPosition(document.tempos, 6)).toEqual({ bar: 3, beat: 1, first: true });
  const expected = musicBeatToMs(document, 4 / 3); expect(snapMusicTime(document, expected + 1)).toBeCloseTo(expected, 8);
});
it('只移动节拍锁定 Cue，固定时间保留；越界与同目标冲突拒绝', () => {
  const document = createLightingDocument(); document.version = 2; document.music = createLightingMusic();
  document.tracks = [{ id:'t', name:'灯光', kind:'ma2', color:'#abcdef', group:'', muted:false, solo:false, locked:false, channel:1, controller:7, portProfileId:'', noteNames:{}, clips:[{ id:'c', name:'灯光', start:0, duration:10000, timeLock:'time', muted:false, events:[{ id:'a', at:468.75, beatAnchor:1, kind:'ma2', action:'goto', cue:'1.100', sequence:36, executor:'', label:'节拍' }, { id:'b', at:2000, kind:'ma2', action:'goto', cue:'2.000', sequence:36, executor:'', label:'固定' }] }] }];
  const changed = changeMusicTempo(document, [{ ...document.tempos[0]!, bpm:60 }], { ...document.music, firstBeatMs:100 }, 10000);
  expect(changed.changes).toEqual([{ id:'a', name:'节拍', fromMs:468.75, toMs:1100 }]);
  expect(changed.document.tracks[0]?.clips[0]?.events[1]?.at).toBe(2000);
  expect(() => moveMusicCues(document, [{ id:'a', name:'节拍', fromMs:468.75, toMs:2000 }], 10000)).toThrow('同一目标');
  expect(() => moveMusicCues(document, [{ id:'a', name:'节拍', fromMs:468.75, toMs:10000 }], 10000)).toThrow('范围');
  expect(document.tracks[0]?.clips[0]?.events[0]?.at).toBe(468.75);
});
it('段落允许相邻，不允许重叠；旧格式不能承载新字段', () => {
  const document = createLightingDocument(); const music = createLightingMusic();
  music.sections = [{ id:'a', name:'主歌', startMs:0, endMs:1000, color:'#abcdef', notes:'' }, { id:'b', name:'副歌', startMs:1000, endMs:2000, color:'#abcdef', notes:'' }];
  expect(lightingDocumentSchema.safeParse({ ...document, version:2, music }).success).toBe(true);
  expect(lightingDocumentSchema.safeParse({ ...document, music }).success).toBe(false);
  music.sections[1]!.startMs = 999;
  expect(lightingDocumentSchema.safeParse({ ...document, version:2, music }).success).toBe(false);
});
it('旧片段中仅一个 Cue 固定时间，同片段其他 Cue 保留节拍锁定', () => {
  const document = createLightingDocument();
  document.tracks = [{ id:'t', name:'灯光', kind:'ma2', color:'#abcdef', group:'', muted:false, solo:false, locked:false, channel:1, controller:7, portProfileId:'', noteNames:{}, clips:[{ id:'c', name:'灯光', start:0, duration:8, timeLock:'beat', muted:false, events:[{ id:'a', at:1, kind:'ma2', action:'goto', cue:'1.100', sequence:36, executor:'', label:'固定' }, { id:'b', at:2, kind:'ma2', action:'goto', cue:'2.000', sequence:36, executor:'', label:'跟拍' }] }] }];
  const locked = setMusicCueLock(document, new Set(['a']), false);
  expect(lightingPositions(locked).map(value => value.toMs)).toEqual([468.75,937.5]);
  const next = changeMusicTempo(locked, [{ ...document.tempos[0]!, bpm:60 }], createLightingMusic(), 20000);
  expect(lightingPositions(next.document).map(value => value.toMs)).toEqual([468.75,2000]);
  expect(document.tracks[0]!.clips[0]!.timeLock).toBe('beat');
  const moved = moveMusicCues(document, [{ id:'a', name:'固定', fromMs:468.75, toMs:1406.25 }], 20000);
  const retimed = changeMusicTempo(moved, [{ ...document.tempos[0]!, bpm:60 }], createLightingMusic(), 20000);
  expect(lightingPositions(retimed.document).map(value => value.toMs)).toEqual([3000,2000]);
});
