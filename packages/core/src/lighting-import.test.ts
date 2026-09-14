import { describe, expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, type LightingTrack } from '@tb/schema';
import { appendLightingDocument } from './lighting-import';

function sourceDocument() {
  const source = createLightingDocument();
  const track: LightingTrack = { id: 'track', name: '来源', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '片段', timeLock: 'time', start: 1000, duration: 2000, muted: false, events: [{ id: 'event', kind: 'ma2', at: 500, cue: '1.25', label: '亮起', action: 'goto', sequence: 2, executor: '1.5' }] }] };
  source.tracks = [track];
  source.templates = [{ id: 'template', name: '复用', track: structuredClone(track) }];
  source.markers = [{ id: 'marker', name: '主歌', startMs: 1500, endMs: null }];
  source.ma2Bindings = [{ id: 'binding', timecode: 9, name: 'MA2', readAt: '2026-09-11T00:00:00.000Z', sourceXml: '<MA><Timecode index="8" /></MA>', baselineTracks: [structuredClone(track)], mappings: [{ trackId: 'track', clipId: 'clip', eventId: 'event', path: 'Timecode:8/Track:0/SubTrack:0/Event:0', sequence: 2, executor: '1.5', cueIndex: 1 }] }];
  return source;
}

describe('灯光工程追加导入', () => {
  it('保留模板、标记、绑定和基线，重映射后仍关联到导入事件', () => {
    const source = sourceDocument(); const current = sourceDocument(); delete current.ma2Bindings;
    current.tempos[0]!.bpm = 90;
    const before = structuredClone(source);
    const result = appendLightingDocument(current, source);
    expect(result.tracks).toHaveLength(2); expect(result.templates).toHaveLength(2); expect(result.markers).toHaveLength(2);
    expect(result.tempos).toEqual(current.tempos); expect(result.tracks[0]).toEqual(current.tracks[0]);
    const imported = result.tracks[1]!; const binding = result.ma2Bindings![0]!;
    expect(imported.id).not.toBe(source.tracks[0]!.id);
    expect(binding.mappings[0]).toMatchObject({ trackId: imported.id, clipId: imported.clips[0]!.id, eventId: imported.clips[0]!.events[0]!.id });
    expect(binding.baselineTracks[0]).toEqual(imported);
    expect(binding.sourceXml).toBe(source.ma2Bindings![0]!.sourceXml);
    expect(result.templates[1]!.track.id).not.toBe(imported.id);
    expect(lightingDocumentSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    imported.clips[0]!.events[0]!.at = 700;
    expect(binding.baselineTracks[0]!.clips[0]!.events[0]!.at).toBe(500);
    expect(source).toEqual(before);
  });
  it('控台基线中已被本地删除的事件仍保留映射，重复 Timecode 拒绝整体导入', () => {
    const source = sourceDocument(); source.tracks[0]!.clips[0]!.events = [];
    const current = sourceDocument(); delete current.ma2Bindings;
    const result = appendLightingDocument(current, source);
    expect(result.tracks[1]!.clips[0]!.events).toEqual([]);
    expect(result.ma2Bindings![0]!.baselineTracks[0]!.clips[0]!.events).toHaveLength(1);
    expect(() => appendLightingDocument(result, source)).toThrow('不能重复导入');
    expect(result.tracks).toHaveLength(2);
  });
  it('导入模板按源节拍图转换完整音符，不依赖目标 BPM', () => {
    const source = sourceDocument(); const template = source.templates[0]!.track.clips[0]!;
    template.timeLock = 'beat'; template.start = 2; template.duration = 8;
    template.events = [{ id: 'note', kind: 'note', at: 1, duration: 5, note: 60, velocity: 100 }];
    source.tempos.push({ beat: 4, bpm: 60, numerator: 4, denominator: 4 });
    const current = sourceDocument(); delete current.ma2Bindings; current.tempos[0]!.bpm = 90;
    const result = appendLightingDocument(current, source);
    expect(result.templates[1]!.track.clips[0]).toMatchObject({ start: 1000, duration: 7000, timeLock: 'time', events: [{ at: 500, duration: 4500 }] });
  });
});
