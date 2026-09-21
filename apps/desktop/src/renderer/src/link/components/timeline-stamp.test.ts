import { describe, expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema } from '@tb/schema';
import { stampTimeline } from './timeline-stamp';

describe('播放头打点', () => {
  it('重叠片段优先写入已选片段，没有选中时单独新建手动片段', () => {
    const first = stampTimeline(createLightingDocument(), undefined, 500, 5000);
    const original = first.document.tracks[0]!;
    const clips = [original.clips[0]!, { ...original.clips[0]!, id: 'overlap', events: [] }];
    const document = { ...first.document, tracks: [{ ...original, clips }] };
    const selected = stampTimeline(document, original.id, 1500, 5000, 'overlap');
    expect(selected.clipId).toBe('overlap');
    expect(selected.document.tracks[0]?.clips.find(clip => clip.id === first.clipId)).toEqual(clips[0]);
    const separate = stampTimeline(document, original.id, 1500, 5000);
    expect(separate.document.tracks[0]?.clips.slice(0, 2)).toEqual(clips);
    expect(separate.document.tracks[0]?.clips[2]).toMatchObject({ name: '手动打点', events: [{ at: 1500 }] });
    expect(lightingDocumentSchema.safeParse(separate.document).success).toBe(true);
  });
  it('没有选中片段时可创建首点，连续打点保留前一点且不改原文档', () => {
    const original = createLightingDocument();
    const first = stampTimeline(original, undefined, 500, 5000);
    const second = stampTimeline(first.document, first.trackId, 1000, 5000);
    expect(original.tracks).toHaveLength(0);
    expect(second.document.tracks[0]?.clips[0]?.events).toMatchObject([{ at: 500, cue: '1' }, { at: 1000, cue: '2' }]);
    expect(lightingDocumentSchema.safeParse(second.document).success).toBe(true);
  });
  it('多轨道按明确目标打点，锁定和范围错误会明确拒绝', () => {
    const first = stampTimeline(createLightingDocument(), undefined, 500, 5000);
    const track = first.document.tracks[0]!;
    const document = { ...first.document, tracks: [track, { ...track, id: 'second', clips: track.clips.map(clip => ({ ...clip, id: 'second-clip', events: [] })) }] };
    expect(() => stampTimeline(document, undefined, 1000, 5000)).toThrow('请选择');
    const next = stampTimeline(document, 'second', 1000, 5000);
    expect(next.document.tracks[0]?.clips[0]?.events).toHaveLength(1);
    expect(next.document.tracks[1]?.clips[0]?.events).toHaveLength(1);
    expect(() => stampTimeline({ ...document, tracks: [{ ...track, locked: true }] }, track.id, 1000, 5000)).toThrow('锁定');
    expect(() => stampTimeline(document, track.id, 5000, 5000)).toThrow('音频范围');
  });
});
