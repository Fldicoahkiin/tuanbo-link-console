import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, referenceAudioSchema, audioTracksSchema } from '@tb/schema';
import { audioSegments, audioTracks, audioContainsMediaSource, dragAudioSegment, editedAudio, editedSongDurationMs, padAudioTimeline, songDurationMs, songLeadBlankMs, songTailBlankMs, splitAudioSegments, updateAudioSegment } from './audio-edit';
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
  describe('前后空白（0.5.9 E13）', () => {
    const second = { assetId: 'voice', relativePath: 'assets/voice.wav', sha256: 'b'.repeat(64), durationMs: 2000 };
    const tracks = [
      { id: 'music', title: '歌曲音频', source: audio, segments: [{ id: 'm', startMs: 1000, sourceOffsetMs: 0, durationMs: 4000 }] },
      { id: 'voice', title: '原声', source: second, segments: [{ id: 'v', startMs: 1500, sourceOffsetMs: 0, durationMs: 2000 }] }
    ];
    const mix = { assetId: 'mix', relativePath: 'assets/mix.wav', sha256: 'c'.repeat(64) };
    const song = (songMs?: number) => {
      const durationMs = songMs ?? 5000;
      return referenceAudioSchema.parse({ ...mix, durationMs, timeline: { source: { ...mix, durationMs },
        segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs }], tracks, ...(songMs === undefined ? {} : { durationMs: songMs }) } });
    };

    it('歌曲总长：有 timeline.durationMs 就是它，没有就是所有音轨里最晚的结尾', () => {
      expect(songDurationMs(audio)).toBe(5000);
      expect(songDurationMs(song())).toBe(5000);
      expect(songDurationMs(song(7000))).toBe(7000);
      expect(songLeadBlankMs(song(7000))).toBe(1000);
      expect(songTailBlankMs(song(7000))).toBe(2000);
      expect(songTailBlankMs(song())).toBe(0);
      expect(songLeadBlankMs(audio)).toBe(0);
    });

    it('padAudioTimeline 所有音轨一起挪，总长 = 新的最晚结尾 + 尾空白，空白按帧取整', () => {
      const padded = padAudioTimeline(song(), 480, 1000, '25');
      expect(padded.tracks.map(track => track.segments.map(segment => segment.startMs))).toEqual([[1480], [1980]]);
      expect(padded.durationMs).toBe(6480);
      expect(padAudioTimeline(song(), 500, 0, '25').tracks[0]!.segments[0]!.startMs).toBe(1520);
      expect(padded.tracks.map(track => track.source)).toEqual([audio, second]);
      // 25 fps: 40 ms frames; 30 fps: 33.3 ms frames, rounded to whole milliseconds.
      const odd = padAudioTimeline(song(), 1010, 1030, '25');
      expect(odd.tracks[0]!.segments[0]!.startMs).toBe(1000 + 1000);
      expect(odd.durationMs).toBe(6000 + 1040);
      const thirty = padAudioTimeline(song(), 50, 50, '30');
      expect(thirty.tracks[0]!.segments[0]!.startMs).toBe(1000 + 67);
      expect(thirty.durationMs).toBe(5067 + 67);
      expect(padAudioTimeline(song(), -1000, 0, '25').tracks[0]!.segments[0]!.startMs).toBe(0);
      expect(() => padAudioTimeline(song(), -1040, 0, '25')).toThrow('前面的空白不能比 0 还短');
      expect(() => padAudioTimeline(song(), 0, -1, '25')).toThrow('空白的长度无效');
      expect(() => padAudioTimeline(song(), 0, 86_400_000, '25')).toThrow('24 小时');
    });

    it('改片段不会把尾空白吃掉；片段拖过总长时，歌延长到这段的结尾，后面不再留空白', () => {
      const padded = song(7000);
      expect(editedSongDurationMs(song(), tracks)).toBeUndefined();
      expect(editedSongDurationMs(padded, tracks)).toBe(7000);
      const shorter = [{ ...tracks[0]!, segments: [{ id: 'm', startMs: 1000, sourceOffsetMs: 0, durationMs: 2000 }] }, tracks[1]!];
      expect(editedSongDurationMs(padded, shorter)).toBe(7000);
      const past = [{ ...tracks[0]!, segments: [{ id: 'm', startMs: 4000, sourceOffsetMs: 0, durationMs: 4000 }] }, tracks[1]!];
      expect(editedSongDurationMs(padded, past)).toBe(8000);
      // One track, as updateAudioSegment checks it: a saved length stays, and only grows past the moved segment.
      const single = referenceAudioSchema.parse({ ...audio, durationMs: 7000, timeline: { source: audio, segments: [{ id: 'm', startMs: 1000, sourceOffsetMs: 0, durationMs: 4000 }], durationMs: 7000 } });
      expect(updateAudioSegment(single, 'm', { startMs: 2500 })).toEqual([{ id: 'm', startMs: 2500, sourceOffsetMs: 0, durationMs: 4000 }]);
      expect(updateAudioSegment(single, 'm', { startMs: 5000 })).toEqual([{ id: 'm', startMs: 5000, sourceOffsetMs: 0, durationMs: 4000 }]);
      // Dragging works on segments alone and is not limited by the song's length; the length follows from the result.
      const dragged = dragAudioSegment(single.timeline!.segments, 'm', 'move', 4000, 5000);
      expect(dragged.startMs).toBe(5000);
      expect(editedSongDurationMs(single, [{ segments: [dragged] }])).toBe(9000);
      expect(editedSongDurationMs(single, [{ segments: [dragAudioSegment(single.timeline!.segments, 'm', 'move', 500, 5000)] }])).toBe(7000);
    });

    it('改音频的命令遇到带总长的音频，把工程升到 3 版；不带的照旧', () => {
      const project = createEmptyLinkProject('空白');
      project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', referenceAudio: song(), visualLayers: [], referenceMediaClips: [], cues: [] });
      expect(editReferenceAudioCommand('song', song(), '编辑').execute(project).schemaVersion).toBe(1);
      const next = editReferenceAudioCommand('song', song(7000), '编辑').execute(project);
      expect(next.schemaVersion).toBe(3);
      expect(next.rundown[0]!.referenceAudio?.timeline?.durationMs).toBe(7000);
    });
  });
  it('拒绝其他歌曲的节拍缓存和无序标记', () => {
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: 'b'.repeat(64), level: 'dense', pointsMs: [100] } })).toThrow();
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: audio.sha256, level: 'dense', pointsMs: [100, 100] } })).toThrow();
  });
});

