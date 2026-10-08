import { expect, it } from 'vitest';
import { createLightingDocument, createEmptyLinkProject, parseLinkProject, type AutomaticMusicCandidates } from '@tb/schema';
import { detectedBeatsPerBar, musicBeatSegments, saveMusicBeatSegments } from './music-beat-segments';
import { musicTempoSegments } from './music-tempo-segments';
import { setLightingCommand } from './lighting-edit';

const source = { assetId: 'audio', relativePath: 'song.wav', durationMs: 32933, sha256: 'a'.repeat(64) };
const candidates: AutomaticMusicCandidates = { sourceSha256: source.sha256, durationMs: source.durationMs, bpm: 120, items: [
  ...Array.from({ length: 65 }, (_, index) => ({ id: `beat:${index}`, kind: 'beat' as const, name: `节拍 ${index + 1}`, startMs: index * 500 + 100, endMs: null })),
  { id: 'section:1', kind: 'section', name: '副歌', startMs: 0, endMs: 32933 }
] };

it('仅按实际拍点编号分段，65 拍按 8 拍分成 9 段，不推断灯光或插入起点', () => {
  const points = musicBeatSegments(candidates, 8);
  expect(points.map(point => point.startMs)).toEqual([100, 4100, 8100, 12100, 16100, 20100, 24100, 28100, 32100]);
  expect(points.at(-1)?.endMs).toBe(32933);
  expect(musicBeatSegments(candidates, 1)).toHaveLength(65);
  expect(musicBeatSegments(candidates, 16)).toHaveLength(5);
  expect(musicBeatSegments({ ...candidates, items: [...candidates.items].reverse() }, 8)).toEqual(points);
});

it('重复拍点去重、无拍点不给结果、非等间距不按 BPM 重算，末端不越界', () => {
  expect(musicBeatSegments({ ...candidates, items: [] })).toEqual([]);
  expect(musicBeatSegments({ ...candidates, items: [...candidates.items, { ...candidates.items[0]!, id: 'duplicate-time' }] })).toEqual(musicBeatSegments(candidates));
  const changed = { ...candidates, items: candidates.items.map((point, index) => index === 8 ? { ...point, startMs: 4151 } : point) };
  expect(musicBeatSegments(changed, 8)[1]?.startMs).toBe(4151);
  expect(() => musicBeatSegments({ ...candidates, durationMs: 1000 })).toThrow();
});

it('自动识别速度分段，不需用户选择拍数；抖动和单个漏拍不切段', () => {
  expect(musicBeatSegments(candidates)).toHaveLength(1);
  expect(musicBeatSegments(candidates)[0]?.name).toBe('120 BPM');
  const beats = Array.from({ length: 33 }, (_, i) => i <= 16 ? i * 500 : 8000 + (i - 16) * (60000 / 90));
  expect(musicTempoSegments(beats, 19000)).toEqual([{ startMs: 0, endMs: 8000, bpm: 120 }, { startMs: 8000, endMs: 19000, bpm: 90 }]);
  expect(musicTempoSegments(beats.slice(0, 16).filter((_, i) => i !== 9), 8000)).toHaveLength(1);
  expect(musicTempoSegments(Array.from({ length: 40 }, (_, i) => i * 500 + (i % 2) * 10), 20000)).toHaveLength(1);
  expect(musicTempoSegments([0, 500], 1000)).toEqual([]);
});

it('细分使用相邻实测拍点；小节拍数来自强拍，不拿默认 4/4 当结果', () => {
  expect(musicBeatSegments(candidates, .5).slice(0, 3).map(item => item.startMs)).toEqual([100, 350, 600]);
  expect(detectedBeatsPerBar(candidates)).toBeNull();
  for (const count of [3, 4]) {
    const items = [...candidates.items, ...candidates.items.filter((item, index) => item.kind === 'beat' && index % count === 0).map(item => ({ ...item, id: `down:${item.id}`, kind: 'downbeat' as const }))];
    expect(detectedBeatsPerBar({ ...candidates, items })).toBe(count);
  }
});

it('保存仅写音乐标记，保留灯光与手工标记；整笔撤销和重开；更改间隔不累积重复', () => {
  const document = createLightingDocument(); document.version = 2;
  document.markers.push({ id: 'manual', name: '人工重击', kind: 'hit', startMs: 1234, endMs: null, notes: '', color: '#ffffff' });
  const before = parseLinkProject({ ...createEmptyLinkProject('节拍分段'), schemaVersion: 2, rundown: [{ id: 'song', title: '歌', referenceAudio: source, lighting: document }] });
  const arranged = saveMusicBeatSegments(document, source, candidates, 8);
  expect(arranged.tracks).toEqual(document.tracks); expect(arranged.tempos).toEqual(document.tempos);
  expect(arranged.markers[0]).toEqual(document.markers[0]); expect(arranged.markers.length).toBe(10);
  const command = setLightingCommand('song', arranged, '保存节拍分段');
  expect(parseLinkProject(JSON.parse(JSON.stringify(command.execute(before)))).rundown[0]?.lighting).toEqual(arranged);
  expect(command.undo(before)).toEqual(before);
  expect(saveMusicBeatSegments(arranged, source, candidates, 8)).toEqual(arranged);
  expect(saveMusicBeatSegments(arranged, source, candidates, 16).markers).toHaveLength(6);
  expect(() => saveMusicBeatSegments(arranged, { ...source, durationMs: 2000 }, candidates, 8)).toThrow('裁剪');
  expect(() => saveMusicBeatSegments(arranged, { ...source, sha256: 'b'.repeat(64) }, candidates, 8)).toThrow('音源');
});
