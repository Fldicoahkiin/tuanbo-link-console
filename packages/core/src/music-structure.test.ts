import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, musicStructureSchema, parseLinkProject, type AutomaticMusicCandidates, type AutomaticMusicRun } from '@tb/schema';
import { acceptMusicStructure, editMusicStructure, matchingMusicStructure, musicStructureSegments, recognizeMusicStructure } from './music-structure';
import { fuseMusicBeats } from './music-beat-fusion';
import { setLightingCommand } from './lighting-edit';

const source = { assetId: 'audio', relativePath: 'song.wav', durationMs: 32000, sha256: 'a'.repeat(64) };
function candidates(step = 500): AutomaticMusicCandidates {
  return { sourceSha256: source.sha256, durationMs: source.durationMs, bpm: 60000 / step, items: [
    ...Array.from({ length: Math.floor(32000 / step) }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * step, endMs: null })),
    ...Array.from({ length: Math.floor(32000 / step / 4) }, (_, i) => ({ id: `down:${i}`, kind: 'downbeat' as const, name: '强拍', startMs: i * step * 4, endMs: null })),
    { id: 'section:0', kind: 'section', name: '主歌', startMs: 0, endMs: 16000 }, { id: 'section:1', kind: 'section', name: '副歌', startMs: 16000, endMs: 32000 }
  ] };
}
it('相同 BPM 的音乐结构变化也分段，结果独立存储而不生成编号标记', () => {
  const document = createLightingDocument();
  const next = acceptMusicStructure(document, source, candidates(), 'task');
  expect(next.musicAnalysis?.segments.map(segment => [segment.startMs, segment.endMs, segment.bpm])).toEqual([[0, 16000, 120], [16000, 32000, 120]]);
  expect(next.musicAnalysis?.beatsPerBar).toBe(4);
  expect(next.musicAnalysis?.segments.map(segment => segment.name)).toEqual(['段落 1', '段落 2']);
  expect(next.tempos).toEqual(document.tempos); expect(next.tracks).toEqual(document.tracks); expect(next.markers).toEqual([]);
  expect(matchingMusicStructure(next, { ...source, sha256: 'b'.repeat(64) })).toBeUndefined();
  expect(matchingMusicStructure(next, { ...source, durationMs: 30000 })).toBeUndefined();
  expect(() => acceptMusicStructure(document, { ...source, durationMs: 30000 }, candidates(), 'late')).toThrow('音源');
});
it('refreshes cached automatic labels and tempo from beat evidence while retaining manual labels', () => {
  const data = recognizeMusicStructure(candidates(), 'cached');
  data.segments[0] = { ...data.segments[0]!, name: '主歌 1', bpm: 333 };
  data.segments[1] = { ...data.segments[1]!, name: '我的段落', edited: true };
  const before = structuredClone(data);
  expect(musicStructureSegments(data).map(segment => [segment.name, segment.bpm])).toEqual([['段落 1', 120], ['我的段落', 120]]);
  expect(data).toEqual(before);
});
it('清除保留 BPM、抑制重新出现；删除修正在重新分析后保留', () => {
  let document = acceptMusicStructure(createLightingDocument(), source, candidates(), 'task');
  document = editMusicStructure(document, { kind: 'remove-beat', id: document.musicAnalysis!.beats[5]!.id });
  const segment = document.musicAnalysis!.segments[0]!;
  document = editMusicStructure(document, { kind: 'segment', segment: { ...segment, name: '用户名称' } });
  const next = acceptMusicStructure(document, source, candidates(), 'rerun');
  expect(next.musicAnalysis?.beats).toHaveLength(63); expect(next.musicAnalysis?.segments[0]?.name).toBe('用户名称');
  const cleared = editMusicStructure(next, { kind: 'clear' });
  expect(cleared.musicAnalysis).toMatchObject({ state: 'cleared', bpm: 120, beats: [], segments: [] });
  expect(matchingMusicStructure(cleared, source)?.state).toBe('cleared');
  expect(acceptMusicStructure(cleared, source, candidates(), 'explicit').musicAnalysis?.beats).toHaveLength(64);
});
it('保存重开、撤销整笔恢复；拒绝段落重叠及旧格式写入', () => {
  const lighting = createLightingDocument();
  const project = parseLinkProject({ ...createEmptyLinkProject('测试'), schemaVersion: 2, rundown: [{ id: 'song', title: '歌', referenceAudio: source, lighting }] });
  const document = acceptMusicStructure(lighting, source, candidates(), 'task');
  const command = setLightingCommand('song', document, '自动音乐识别');
  expect(parseLinkProject(JSON.parse(JSON.stringify(command.execute(project)))).rundown[0]?.lighting?.musicAnalysis).toEqual(document.musicAnalysis);
  expect(command.undo(project)).toEqual(project);
  expect(() => editMusicStructure(document, { kind: 'segment', segment: { ...document.musicAnalysis!.segments[0]!, endMs: 17000 } })).toThrow();
  expect(lightingDocumentSchema.safeParse({ ...document, version: 1 }).success).toBe(false);
  expect(musicStructureSchema.safeParse({ ...document.musicAnalysis, segments: [{ ...document.musicAnalysis!.segments[0], endMs: 40000 }] }).success).toBe(false);
});
it('持续变速、渐变、静音、短段分别处理，不强行切固定拍数', () => {
  const base = candidates();
  const values = Array.from({ length: 49 }, (_, i) => i <= 24 ? i * 500 : 12000 + (i - 24) * (60000 / 90));
  const changed = { ...base, items: values.map((at, i) => ({ id: String(i), kind: 'beat' as const, name: '拍点', startMs: at, endMs: null })) };
  expect(recognizeMusicStructure(changed, 'step').segments.map(segment => segment.bpm)).toEqual([120, 90]);
  const nearby = recognizeMusicStructure({ ...changed, items: [...changed.items,
    { id: 's0', kind: 'section', name: '前', startMs: 0, endMs: 12150 },
    { id: 's1', kind: 'section', name: '后', startMs: 12150, endMs: source.durationMs }
  ] }, 'nearby');
  expect(nearby.segments.map(segment => [segment.startMs, segment.endMs, segment.bpm, segment.reason])).toEqual([[0, 12000, 120, 'whole'], [12000, 32000, 90, 'both']]);
  let at = 0;
  const ramp = Array.from({ length: 49 }, (_, i) => { const point = { id: String(i), kind: 'beat' as const, name: '拍点', startMs: at, endMs: null }; at += 400 + i * 4; return point; });
  expect(recognizeMusicStructure({ ...base, items: ramp }, 'ramp').segments.some(segment => segment.endBpm !== null)).toBe(true);
  expect(recognizeMusicStructure({ ...base, bpm: null, items: [] }, 'silent')).toMatchObject({ bpm: null, beats: [], segments: [] });
  expect(recognizeMusicStructure({ ...base, items: base.items.filter(item => item.kind !== 'section') }, 'steady').segments).toHaveLength(1);
});
it('多模型融合选择连续序列，单模型漏拍不把公共拍点删掉', () => {
  const beats = Array.from({ length: 32 }, (_, i) => i * .5);
  const labels = (points: number[]) => ({ beats: points, downbeats: [0, 2, 4, 6], sections: [], events: [] });
  const run: AutomaticMusicRun = { version: 1, run_id: crypto.randomUUID(), engine_fingerprint: 'b'.repeat(64), device: 'cpu', audio: { source_sha256: source.sha256, pcm_sha256: 'c'.repeat(64), sample_rate: 48000, sample_count: 48000 * 32, channels: 2 }, timings: { total_seconds: 1, decode_seconds: 0, engine_seconds: {}, cached: false }, diagnostics: { 'beat-this-final0': labels(beats.filter((_, i) => i !== 9)), 'beat-this-final1': labels(beats), 'beat-this-final2': labels(beats.map(time => time + .01)), 'all-in-one': labels(beats) }, publication: 'not-validated', enabled_capabilities: [] };
  const result = fuseMusicBeats(run);
  expect(result.beats).toHaveLength(32); expect(result.downbeats).toHaveLength(4); expect(result.ambiguous).toBe(false);
  run.diagnostics['beat-this-final0'] = labels(beats.filter((_, i) => i % 2 === 0));
  expect(fuseMusicBeats(run).beats).toHaveLength(32);
});
it('分段 BPM 使用各段累计拍间隔，避免量化后的 .52 秒中位数复制到所有段', () => {
  const base = candidates();
  const times = [0];
  for (let i = 0; i < 60; i++) times.push(times.at(-1)! + (i < 30 ? i % 3 === 0 ? 530 : 520 : i % 3 === 0 ? 510 : 520));
  const split = times[30]!;
  const input = { ...base, items: [
    ...times.map((at, index) => ({ id: `b${index}`, kind: 'beat' as const, name: '拍点', startMs: at, endMs: null })),
    { id: 's0', kind: 'section' as const, name: '前段', startMs: 0, endMs: split },
    { id: 's1', kind: 'section' as const, name: '后段', startMs: split, endMs: 32000 }
  ] };
  expect(recognizeMusicStructure(input, 'local').segments.map(s => s.bpm)).toEqual([114.65, 116.13]);
});
it('短歌持续小幅变速也分段，单拍抖动和漏拍不拆段', () => {
  const base = candidates();
  const make = (periods: number[]) => {
    const times = [0]; for (const period of periods) times.push(times.at(-1)! + period);
    return recognizeMusicStructure({ ...base, items: times.map((at, index) => ({ id: String(index), kind: 'beat' as const, name: '拍点', startMs: at, endMs: null })) }, 'local');
  };
  expect(make([...Array<number>(12).fill(500), ...Array<number>(12).fill(60000 / 114)]).segments.map(s => s.bpm)).toEqual([120, 114]);
  expect(make(Array.from({ length: 40 }, (_, i) => i === 17 ? 1000 : i % 2 ? 510 : 490)).segments).toHaveLength(1);
});
it('短段使用连续相邻拍间隔补足 BPM，旧结果无需重分析且不修改文档', () => {
  const data = recognizeMusicStructure(candidates(), 'short');
  data.segments = [{ ...data.segments[0]!, startMs: 1250, endMs: 2350, bpm: null }];
  const before = JSON.stringify(data);
  expect(musicStructureSegments(data)[0]?.bpm).toBe(120);
  expect(JSON.stringify(data)).toBe(before);
  data.segments = [{ ...data.segments[0]!, startMs: 0, endMs: 1100 }];
  expect(musicStructureSegments(data)[0]?.bpm).toBe(120);
});
it('短段不得跨停顿或变速借用 BPM，也不覆盖识别歧义', () => {
  const data = recognizeMusicStructure(candidates(), 'short');
  data.segments = [{ ...data.segments[0]!, startMs: 1250, endMs: 2350, bpm: null }];
  data.beats = [0, 500, 1000, 1500, 2500, 3500].map(atMs => ({ id: String(atMs), atMs, strong: false }));
  expect(musicStructureSegments(data)[0]?.bpm).toBeNull();
  data.beats = [0, 500, 1000, 5000, 5500, 6000].map(atMs => ({ id: String(atMs), atMs, strong: false }));
  expect(musicStructureSegments(data)[0]?.bpm).toBeNull();
  data.beats = recognizeMusicStructure(candidates(), 'beats').beats; data.bpm = null;
  expect(musicStructureSegments(data)[0]?.bpm).toBeNull();
});
it('孤立半拍合并计算局部速度，连续双倍速度仍保持双倍', () => {
  const base = candidates();
  const times = [8000, 8280, 8520, 9040, 9560, 10080];
  const result = recognizeMusicStructure({ ...base, items: times.map((at, index) => ({ id: String(index), kind: 'beat' as const, name: '拍点', startMs: at, endMs: null })) }, 'subdivisions');
  expect(result.segments[0]?.bpm).toBe(115.38);
  expect(recognizeMusicStructure(candidates(250), 'double').segments.every(segment => segment.bpm === 240)).toBe(true);
});
