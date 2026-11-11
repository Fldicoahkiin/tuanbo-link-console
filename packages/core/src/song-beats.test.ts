import { describe, expect, it } from 'vitest';
import type { AutomaticMusicCandidates, ReferenceAudio, RundownItem } from '@tb/schema';
import { acceptMusicStructure } from './music-structure';
import { songBeats, songBeatsAtDensity, songMusicAudio, songMusicSource, songTimeToMusicSource } from './song-beats';

const source = { assetId: 'source', relativePath: 'assets/reference-audio/song.wav', sha256: 'a'.repeat(64), durationMs: 6000 };
const candidates: AutomaticMusicCandidates = { sourceSha256: source.sha256, durationMs: source.durationMs, bpm: 120, items: [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `down:${i}`, kind: 'downbeat' as const, name: '强拍', startMs: i * 2000, endMs: null })),
  { id: 'section:0', kind: 'section', name: '前', startMs: 0, endMs: 3000 }, { id: 'section:1', kind: 'section', name: '后', startMs: 3000, endMs: 6000 }
] };
const music = acceptMusicStructure({}, source, candidates, 'task');
const song = (referenceAudio: ReferenceAudio | undefined): Pick<RundownItem, 'music' | 'referenceAudio' | 'title'> => ({ title: '歌', music, ...(referenceAudio ? { referenceAudio } : {}) });
const rendered = (segments: Array<{ startMs: number; sourceOffsetMs: number; durationMs: number }>, sha = 'b'): ReferenceAudio => ({
  assetId: 'render', relativePath: 'assets/reference-audio/render.wav', sha256: sha.repeat(64), durationMs: Math.max(...segments.map(entry => entry.startMs + entry.durationMs)),
  timeline: { source, segments: segments.map((entry, index) => ({ id: `s${index}`, ...entry })) }
});
const times = (item: Pick<RundownItem, 'music' | 'referenceAudio' | 'title'>): number[] => { const beats = songBeats(item); return beats.state === 'ready' ? beats.beats.map(beat => beat.atMs) : []; };

describe('songBeats：一首歌的节拍放到歌曲时间上', () => {
  it('原样：没剪过的歌，拍点和段落就是识别的结果', () => {
    const beats = songBeats(song(source));
    expect(beats.state).toBe('ready');
    if (beats.state !== 'ready') return;
    expect(beats.beats.map(beat => beat.atMs)).toEqual(music.structure.beats.map(beat => beat.atMs));
    expect(beats.segments.map(segment => [segment.startMs, segment.endMs])).toEqual([[0, 3000], [3000, 6000]]);
    expect(beats.editPointsMs).toEqual([...new Set([...music.structure.beats.map(beat => beat.atMs), 3000, 6000])].sort((a, b) => a - b));
    expect(beats).toMatchObject({ method: 'automatic', bpm: 120, beatsPerBar: music.structure.beatsPerBar });
  });

  it('经片段换算：剪掉的部分没有拍点，后面的拍点跟着片段挪；多音轨时看第一条音轨', () => {
    const cut = rendered([{ startMs: 0, sourceOffsetMs: 0, durationMs: 1000 }, { startMs: 1000, sourceOffsetMs: 4000, durationMs: 2000 }]);
    expect(times(song(cut))).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    const beats = songBeats(song(cut));
    if (beats.state !== 'ready') throw new Error('节拍没有跟过来');
    expect(beats.segments.map(segment => [segment.id, segment.sourceId, segment.startMs, segment.endMs])).toEqual([['segment:0', 'segment:0', 0, 1000], ['segment:3000', 'segment:3000', 1000, 3000]]);
    expect(songTimeToMusicSource(beats, 1500)).toBe(4500);
    expect(songTimeToMusicSource(beats, 3500)).toBeUndefined();
    const music2 = { ...source, assetId: 'voice', sha256: 'c'.repeat(64) };
    const tracks = { ...cut, timeline: { ...cut.timeline!, source: { ...cut, timeline: undefined }, tracks: [
      { id: 'music', title: '歌曲音频', source, segments: [{ id: 'm', startMs: 500, sourceOffsetMs: 0, durationMs: 2000 }] },
      { id: 'voice', title: '人声', source: music2, segments: [{ id: 'v', startMs: 0, sourceOffsetMs: 0, durationMs: 3000 }] }
    ] } };
    expect(times(song(tracks))).toEqual([500, 1000, 1500, 2000]);
    expect(songMusicSource({ title: '歌', referenceAudio: tracks })).toEqual(source);
  });

  it('失效：音乐换了或歌里没有音乐，等重新识别', () => {
    expect(songBeats(song({ ...source, sha256: 'd'.repeat(64) }))).toEqual({ state: 'stale', reason: '音乐换了，需要重新识别节拍' });
    expect(songBeats(song(undefined)).state).toBe('stale');
    expect(songBeats({ title: '歌', referenceAudio: source })).toEqual({ state: 'none' });
    expect(songMusicAudio({ title: '歌', referenceAudio: { ...source, sha256: 'd'.repeat(64) } }, music)).toBeUndefined();
  });

  it('旧数据绑的是当时的歌曲音频：歌曲音频还是那一份时原样用', () => {
    const audio = rendered([{ startMs: 0, sourceOffsetMs: 0, durationMs: 3000 }], 'e');
    const old = acceptMusicStructure({}, audio, { ...candidates, sourceSha256: audio.sha256, durationMs: audio.durationMs, items: candidates.items.filter(item => item.startMs < 3000 && (item.endMs ?? 0) <= 3000) }, 'old');
    const item = { title: '歌', music: old, referenceAudio: audio };
    expect(times(item)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    expect(songMusicAudio(item, old)).toBe(audio);
  });

  it('同一首歌再问一次是同一个结果；显示密度不存，同一密度是同一个数组', () => {
    const item = song(source);
    expect(songBeats(item)).toBe(songBeats({ ...item }));
    const beats = songBeats(item);
    if (beats.state !== 'ready') throw new Error('没有节拍');
    expect(songBeatsAtDensity(beats.beats, 'dense')).toBe(beats.beats);
    expect(songBeatsAtDensity(beats.beats, 'standard').map(beat => beat.atMs)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(songBeatsAtDensity(beats.beats, 'sparse').map(beat => beat.atMs)).toEqual([0, 2000, 4000]);
    expect(songBeatsAtDensity(beats.beats, 'sparse')).toBe(songBeatsAtDensity(beats.beats, 'sparse'));
    expect(songMusicSource(item)).toBe(songMusicSource(item));
  });
});
