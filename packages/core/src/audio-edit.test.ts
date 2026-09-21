import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, referenceAudioSchema, audioTracksSchema } from '@tb/schema';
import { audioSegments, audioTracks, audioContainsMediaSource, editedAudio, splitAudioSegments, updateAudioSegment } from './audio-edit';
import { editReferenceAudioCommand } from './link-command';

const audio = { assetId: 'song', relativePath: 'assets/music.wav', sha256: 'a'.repeat(64), durationMs: 5000 };
describe('可编辑歌曲音频', () => {
  it('多轨允许跨轨重叠，拒绝源范围错误，保留旧视频主音频的重复出声保护', () => {
    const tracks = audioTracks({ ...audio, sourceMediaAssetId: 'video' });
    const two = [...tracks, { ...tracks[0]!, id: 'second' }];
    expect(audioTracksSchema.parse(two)).toEqual(two);
    expect(() => audioTracksSchema.parse([{ ...tracks[0], segments: [{ id: 'bad', startMs: 0, sourceOffsetMs: 4900, durationMs: 200 }] }])).toThrow();
    const mixed = referenceAudioSchema.parse({ ...audio, timeline: { source: audio, segments: audioSegments(audio), tracks: two } });
    expect(audioTracks(mixed)).toEqual(two);
    expect(audioContainsMediaSource(mixed, 'video')).toBe(true);
  });
  it('分割保留连续的素材位置与总时长', () => {
    let id = 0;
    const result = splitAudioSegments(audioSegments(audio), [0, 1500, 1500, 3200, 5000], () => `part-${id++}`);
    expect(result.map(({ startMs, sourceOffsetMs, durationMs }) => ({ startMs, sourceOffsetMs, durationMs }))).toEqual([
      { startMs: 0, sourceOffsetMs: 0, durationMs: 1500 }, { startMs: 1500, sourceOffsetMs: 1500, durationMs: 1700 }, { startMs: 3200, sourceOffsetMs: 3200, durationMs: 1800 }
    ]);
    expect(editedAudio(audio, result).sha256).toBe(audio.sha256);
  });
  it('拒绝重叠、负入点、越过源文件结尾', () => {
    const edit = editedAudio(audio, splitAudioSegments(audioSegments(audio), [2000]));
    expect(() => updateAudioSegment(edit, edit.timeline!.segments[1]!.id, { startMs: 1000 })).toThrow();
    expect(() => updateAudioSegment(edit, edit.timeline!.segments[0]!.id, { sourceOffsetMs: -1 })).toThrow();
    expect(() => updateAudioSegment(edit, edit.timeline!.segments[1]!.id, { durationMs: 4000 })).toThrow();
  });
  it('节拍保存不修改歌曲路径和时长，可以撤销', () => {
    const project = createEmptyLinkProject('测试');
    project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', referenceAudio: audio, visualLayers: [], referenceMediaClips: [], cues: [] });
    const command = editReferenceAudioCommand('song', { ...audio, beats: { sourceSha256: audio.sha256, level: 'standard', pointsMs: [500, 1000] } }, '应用节拍');
    const changed = command.execute(project);
    expect(changed.rundown[0]!.referenceAudio).toMatchObject(audio);
    expect(changed.rundown[0]!.referenceAudio?.beats?.pointsMs).toEqual([500, 1000]);
    expect(command.undo(project)).toEqual(project);
  });
  it('拒绝其他歌曲的节拍缓存和无序标记', () => {
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: 'b'.repeat(64), level: 'dense', pointsMs: [100] } })).toThrow();
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: audio.sha256, level: 'dense', pointsMs: [100, 100] } })).toThrow();
  });
});

