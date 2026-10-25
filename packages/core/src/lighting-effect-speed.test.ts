import { describe, expect, it } from 'vitest';
import { createLightingDocument, createLightingMusic, lightingDocumentSchema, type LightingDocument, type LightingEvent, type Ma2SongSyncResult } from '@tb/schema';
import { lightingEffectBpm, setLightingEffectSpeed, songBpmAt } from './lighting-effect-speed';
import { applyMa2SongReadback, ma2SongPoints } from './ma2-song-sequence';

const cue = (id: string, at: number, extra: Partial<Extract<LightingEvent, { kind: 'ma2' }>> = {}): LightingEvent => ({ id, kind: 'ma2', at, label: id, action: 'goto', executor: '', sequence: 2, cue: '1', runMode: 'independent', ...extra });
function sample(events: LightingEvent[]): LightingDocument {
  const document = createLightingDocument();
  document.version = 2;
  document.outputMode = 'network';
  document.tempos = [{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }, { beat: 16, bpm: 140, numerator: 4, denominator: 4 }];
  document.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{
    id: 'clip', name: '编排', start: 0, duration: 60000, timeLock: 'time', muted: false, events }] }];
  return lightingDocumentSchema.parse(document);
}

describe('效果速度', () => {
  it('跟随歌曲时按点所在位置的节拍图速度换算，固定速度原样使用', () => {
    const document = sample([]);
    // 16 beats at 120 BPM end at 8 s; after that the song runs at 140.
    expect(songBpmAt(document, 4000)).toBe(120);
    expect(songBpmAt(document, 9000)).toBe(140);
    expect(lightingEffectBpm(document, { mode: 'song', beats: 2 }, 4000)).toBe(60);
    expect(lightingEffectBpm(document, { mode: 'song', beats: 0.25 }, 9000)).toBe(560);
    expect(lightingEffectBpm(document, { mode: 'fixed', bpm: 90.5 }, 9000)).toBe(90.5);
  });
  it('换算以音乐的第一拍为起点，结果取到 0.01 BPM', () => {
    const document = { ...sample([]), music: { ...createLightingMusic(), firstBeatMs: 1000 } };
    expect(songBpmAt(document, 8500)).toBe(120);
    expect(songBpmAt(document, 9500)).toBe(140);
    expect(lightingEffectBpm({ tempos: [{ beat: 0, bpm: 128, numerator: 4, denominator: 4 }] }, { mode: 'song', beats: 32 }, 0)).toBe(4);
    expect(lightingEffectBpm({ tempos: [{ beat: 0, bpm: 100, numerator: 4, denominator: 4 }] }, { mode: 'song', beats: 0.25 }, 0)).toBe(400);
    expect(lightingEffectBpm({ tempos: [{ beat: 0, bpm: 110, numerator: 4, denominator: 4 }] }, { mode: 'song', beats: 32 }, 0)).toBe(3.44);
  });
  it('超出控台可写范围时报错，不截断成能写的值', () => {
    expect(() => lightingEffectBpm({ tempos: [{ beat: 0, bpm: 300, numerator: 4, denominator: 4 }] }, { mode: 'song', beats: 0.25 }, 0)).toThrow('超出');
  });
  it('设在组合点上时每个素材都带同一个速度，清除后都去掉', () => {
    const document = sample([cue('point', 0, { effectGroupId: 'point' }), cue('member', 0, { effectGroupId: 'point', sequence: 3 }), cue('other', 2000)]);
    const set = setLightingEffectSpeed(document, 'member', { mode: 'song', beats: 1 });
    const events = set.tracks[0]!.clips[0]!.events;
    expect(events.filter(event => event.kind === 'ma2' && event.effectSpeed).map(event => event.id)).toEqual(['point', 'member']);
    expect(ma2SongPoints(set).map(point => point.effectBpm)).toEqual([120, undefined]);
    const cleared = setLightingEffectSpeed(set, 'point', undefined);
    expect(cleared.tracks[0]!.clips[0]!.events.some(event => event.kind === 'ma2' && event.effectSpeed)).toBe(false);
    expect(ma2SongPoints(cleared)[0]).not.toHaveProperty('effectBpm');
  });
  it('只有调用指定 Cue 的点能设，锁定轨道不能改', () => {
    expect(() => setLightingEffectSpeed(sample([cue('go', 0, { action: 'go', executor: '1.1', cue: undefined, sequence: undefined })]), 'go', { mode: 'fixed', bpm: 60 })).toThrow('调用指定 Cue');
    const locked = sample([cue('point', 0)]);
    locked.tracks[0]!.locked = true;
    expect(() => setLightingEffectSpeed(locked, 'point', { mode: 'fixed', bpm: 60 })).toThrow('锁定');
    expect(() => setLightingEffectSpeed(sample([]), 'missing', { mode: 'fixed', bpm: 60 })).toThrow('不存在');
  });
  it('组合点的素材速度不一致时同步前就报错，不猜用哪个', () => {
    const document = sample([cue('point', 0, { effectGroupId: 'point', effectSpeed: { mode: 'fixed', bpm: 60 } }), cue('member', 0, { effectGroupId: 'point', sequence: 3 })]);
    expect(() => ma2SongPoints(document)).toThrow('效果速度不一致');
  });
  it('工程格式 1 不能带效果速度；非调用指定 Cue 的点也不能带', () => {
    const document = sample([cue('point', 0, { effectSpeed: { mode: 'fixed', bpm: 60 } })]);
    expect(lightingDocumentSchema.safeParse({ ...document, version: 1 }).success).toBe(false);
    expect(lightingDocumentSchema.safeParse({ ...document, tracks: [{ ...document.tracks[0]!, clips: [{ ...document.tracks[0]!.clips[0]!, events: [cue('off', 0, { action: 'off', executor: '1.1', effectSpeed: { mode: 'fixed', bpm: 60 } })] }] }] }).success).toBe(false);
    const offGrid: unknown = JSON.parse(JSON.stringify(sample([cue('song', 0, { effectSpeed: { mode: 'song', beats: 2 } })])).replace('"beats":2', '"beats":3'));
    expect(lightingDocumentSchema.safeParse(offGrid).success).toBe(false);
  });
  it('同步回读把组合点换成本曲 Cue 后仍保留效果速度', () => {
    const document = sample([cue('point', 0, { effectGroupId: 'point', effectSpeed: { mode: 'song', beats: 2 } }), cue('member', 0, { effectGroupId: 'point', sequence: 3, effectSpeed: { mode: 'song', beats: 2 } })]);
    const binding = { endpoint: '192.0.2.1:30000', show: 'Show', layout: null, executor: '1000.101', sequence: 9000, name: '歌曲', baselineXml: '<MA/>', points: [{ id: 'point', cue: '1.000', effectBpm: 60 }] };
    const result: Ma2SongSyncResult = { binding, library: { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-20T00:00:00.000Z',
      sequences: [{ sequence: 9000, name: '歌曲', cues: [{ index: 1, number: '1.000', name: 'point' }] }], fixtureUsage: [], errors: [] }, layout: null, backupFile: '', changed: true };
    const merged = applyMa2SongReadback(document, ma2SongPoints(document), result);
    expect(merged.tracks[0]!.clips[0]!.events).toEqual([expect.objectContaining({ id: 'point', sequence: 9000, cue: '1.000', effectSpeed: { mode: 'song', beats: 2 } })]);
    expect(ma2SongPoints(merged)[0]).toMatchObject({ cues: [{ sequence: 9000, cue: '1.000' }], effectBpm: 60 });
  });
});
