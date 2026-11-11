import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, serializeLinkProject } from '@tb/schema';
import { acceptMusicStructure } from './music-structure';
import { migrateSongMusic, withSongMusic } from './song-music-migration';

const audio = { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', sha256: 'a'.repeat(64), durationMs: 4000 };
const automatic = acceptMusicStructure({}, audio, { sourceSha256: audio.sha256, durationMs: audio.durationMs, bpm: 120,
  items: Array.from({ length: 8 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })) }, 'old-task').structure;
const ibt = { sourceSha256: audio.sha256, level: 'dense' as const, levels: { dense: [0, 500, 1000, 1500, 2000, 2500], standard: [0, 1000, 2000], sparse: [0, 2000] }, pointsMs: [0, 500, 1000, 1500, 2000, 2500] };
const project = (rundown: unknown[]) => parseLinkProject({ ...createEmptyLinkProject('旧工程'), schemaVersion: 2, rundown });

describe('打开旧工程：节拍搬到歌上', () => {
  it('灯光工作台的音乐识别原样搬过来，绑原来的音频，灯光其余内容不变', () => {
    const lighting = { ...createLightingDocument(), version: 2 as const, musicAnalysis: automatic };
    const { project: next, moved, dropped } = migrateSongMusic(project([{ id: 'song', title: '歌', referenceAudio: audio, lighting }]));
    expect([moved, dropped]).toEqual([1, []]);
    const item = next.rundown[0]!;
    expect(item.music).toEqual({ version: 1, sourceSha256: audio.sha256, sourceDurationMs: audio.durationMs, method: 'automatic', structure: automatic });
    const { musicAnalysis, ...rest } = lighting;
    expect(musicAnalysis).toBe(automatic);
    expect(item.lighting).toEqual(rest);
    expect(next.schemaVersion).toBe(3);
  });

  it('编辑器的简易检测换成同一种结果：每一档的拍点都在，最稀那档是强拍；没存各档时就用存下的点', () => {
    const next = withSongMusic(project([
      { id: 'levels', title: '有各档', referenceAudio: { ...audio, beats: ibt } },
      { id: 'points', title: '只有点', referenceAudio: { ...audio, beats: { sourceSha256: audio.sha256, level: 'standard', pointsMs: [0, 1000, 2000, 3000, 3500] } } }
    ]));
    const [levels, points] = next.rundown;
    expect(levels!.music!.method).toBe('ibt');
    expect(levels!.music!.structure.beats.map(beat => beat.atMs)).toEqual(ibt.levels.dense);
    expect(levels!.music!.structure.beats.filter(beat => beat.strong).map(beat => beat.atMs)).toEqual(ibt.levels.sparse);
    for (const value of [...ibt.levels.standard, ...ibt.pointsMs]) expect(levels!.music!.structure.beats.some(beat => beat.atMs === value)).toBe(true);
    expect(points!.music!.structure.beats.map(beat => beat.atMs)).toEqual([0, 1000, 2000, 3000, 3500]);
    expect(points!.referenceAudio).toEqual(audio);
  });

  it('两者都有时取自动分析，简易检测的那份交出去记日志，不进工程', () => {
    const { project: next, dropped } = migrateSongMusic(project([{ id: 'song', title: '歌', referenceAudio: { ...audio, beats: ibt }, lighting: { ...createLightingDocument(), version: 2, musicAnalysis: automatic } }]));
    expect(next.rundown[0]!.music!.method).toBe('automatic');
    expect(next.rundown[0]!.music!.structure).toEqual(automatic);
    expect(dropped).toEqual([{ itemId: 'song', title: '歌', beats: ibt }]);
    expect(serializeLinkProject(next)).not.toContain('"levels"');
  });

  it('没有旧节拍的工程原样返回，版本不变，也就不算有改动', () => {
    const old = project([{ id: 'song', title: '歌', referenceAudio: audio, lighting: createLightingDocument() }]);
    expect(migrateSongMusic(old)).toEqual({ project: old, moved: 0, dropped: [] });
    expect(withSongMusic(old)).toBe(old);
    const v1 = parseLinkProject({ ...createEmptyLinkProject('普通'), rundown: [{ id: 'song', title: '歌', referenceAudio: audio }] });
    expect(withSongMusic(v1).schemaVersion).toBe(1);
  });
});
