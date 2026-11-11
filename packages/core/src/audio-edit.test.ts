import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, referenceAudioSchema, audioTracksSchema } from '@tb/schema';
import { audioSegments, audioTracks, audioContainsMediaSource, dragAudioSegment, editedAudio, splitAudioSegments, updateAudioSegment } from './audio-edit';
import { editReferenceAudioCommand, setReferenceAudioCommand } from './link-command';

const audio = { assetId: 'song', relativePath: 'assets/music.wav', sha256: 'a'.repeat(64), durationMs: 5000 };
describe('可编辑歌曲音频', () => {
  it('拖动片段不改变素材入点，裁剪可恢复，并在相邻片段处停止', () => {
    const segment = { id: 'middle', startMs: 2000, sourceOffsetMs: 1000, durationMs: 2000 };
    const segments = [{ id: 'before', startMs: 0, sourceOffsetMs: 0, durationMs: 1000 }, segment,
      { id: 'after', startMs: 6000, sourceOffsetMs: 0, durationMs: 1000 }];
    expect(dragAudioSegment(segments, 'middle', 'move', -9000, 5000)).toEqual({ ...segment, startMs: 1000 });
    expect(dragAudioSegment(segments, 'middle', 'move', 9000, 5000)).toEqual({ ...segment, startMs: 4000 });
    const trimmed = dragAudioSegment(segments, 'middle', 'start', 500, 5000);
    expect(trimmed).toEqual({ ...segment, startMs: 2500, sourceOffsetMs: 1500, durationMs: 1500 });
    expect(dragAudioSegment([trimmed], 'middle', 'start', -500, 5000)).toEqual(segment);
    expect(dragAudioSegment(segments, 'middle', 'start', -9000, 5000)).toEqual({ ...segment, startMs: 1000, sourceOffsetMs: 0, durationMs: 3000 });
    expect(dragAudioSegment(segments, 'middle', 'end', 9000, 5000).durationMs).toBe(4000);
    expect(dragAudioSegment(segments, 'middle', 'end', -9000, 5000).durationMs).toBe(1);
    expect(dragAudioSegment(segments, 'middle', 'start', 9000, 5000).durationMs).toBe(1);
    expect(segments[1]).toEqual(segment);
  });
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
  it('节拍不再写进歌曲音频：旧格式的节拍字段只在打开旧工程时读', () => {
    const project = createEmptyLinkProject('测试');
    project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', referenceAudio: audio, visualLayers: [], referenceMediaClips: [], cues: [] });
    const withBeats = { ...audio, beats: { sourceSha256: audio.sha256, level: 'standard' as const, pointsMs: [500, 1000] } };
    expect(() => editReferenceAudioCommand('song', withBeats, '应用节拍').execute(project)).toThrow('节拍已经改存在歌曲上');
    expect(() => setReferenceAudioCommand('song', withBeats).execute(project)).toThrow('节拍已经改存在歌曲上');
    const command = editReferenceAudioCommand('song', editedAudio(audio, splitAudioSegments(audioSegments(audio), [2000])), '分割');
    expect(command.execute(project).rundown[0]!.referenceAudio?.timeline?.segments).toHaveLength(2);
    expect(command.undo(project)).toEqual(project);
  });
  it('拒绝其他歌曲的节拍缓存和无序标记', () => {
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: 'b'.repeat(64), level: 'dense', pointsMs: [100] } })).toThrow();
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: audio.sha256, level: 'dense', pointsMs: [100, 100] } })).toThrow();
  });
});

