import { describe, expect, it } from 'vitest';
import { parseMidi, writeMidi } from 'midi-file';
import { createLightingDocument, lightingDocumentSchema, lightingEventSchema } from '@tb/schema';
import { exportLightingMidi, importLightingMidi } from './lighting-midi-file';
import { compileLightingPackets, LightingScheduler } from './lighting-playback';
import { LightingTempoMap } from './lighting-edit';
import { writeLightingMidi } from './lighting-midi-writer';

describe('灯光 MIDI 文件交换', () => {
  it('999 BPM 与小数 BPM 导出重开保留原始节拍，不因整数微秒舍入越界', () => {
    for (const bpm of [10, 123.456789, 998.9999, 999]) {
      const document = createLightingDocument();
      document.tempos = [{ beat: 0, bpm, numerator: 4, denominator: 4 }];
      const bytes = exportLightingMidi(document);
      const imported = importLightingMidi(bytes);
      expect(imported.warnings).toEqual([]);
      expect(imported.document.tempos).toEqual(document.tempos);
      const midi = parseMidi(bytes);
      midi.tracks = midi.tracks.map((events) => events.filter((event) => event.type !== 'sequencerSpecific'));
      const standard = importLightingMidi(writeLightingMidi(midi.tracks, 960));
      expect(standard.document.tempos[0]?.bpm).toBeLessThanOrEqual(999);
      const expected = new LightingTempoMap(document.tempos);
      const actual = new LightingTempoMap(standard.document.tempos);
      const hourBeat = expected.msToBeat(3600000);
      expect(Math.abs(actual.beatToMs(hourBeat) - 3600000)).toBeLessThan(1000 / 30);
    }
  });
  it('外部 999 BPM 的标准整数微秒可导入并提示边界舍入，真正超范围拒绝', () => {
    const midi = (microsecondsPerBeat: number): Uint8Array => writeLightingMidi([[
      { deltaTime: 0, type: 'setTempo', microsecondsPerBeat },
      { deltaTime: 0, type: 'endOfTrack' }
    ]], 960);
    const imported = importLightingMidi(midi(60060));
    expect(imported.document.tempos[0]?.bpm).toBe(999);
    expect(imported.warnings).toContain('MIDI 的 999 BPM 因整数微秒舍入略超上限，已还原为 999 BPM');
    expect(() => importLightingMidi(midi(60059))).toThrow();
    expect(() => importLightingMidi(midi(0))).toThrow();
  });
  it.each([[10, 999], [999, 10], [998.999, 999], [999, 998.999]])('范围边界渐变 %s → %s 的标准节拍仍可读取', (from, to) => {
    const document = createLightingDocument();
    document.tempos = [
      { beat: 0, bpm: from, numerator: 4, denominator: 4, transition: 'linear' },
      { beat: 8000, bpm: to, numerator: 4, denominator: 4 }
    ];
    const bytes = exportLightingMidi(document);
    expect(importLightingMidi(bytes).document.tempos).toEqual(document.tempos);
    const midi = parseMidi(bytes);
    midi.tracks = midi.tracks.map((events) => events.filter((event) => event.type !== 'sequencerSpecific'));
    const standard = importLightingMidi(writeLightingMidi(midi.tracks, 960));
    const originalMap = new LightingTempoMap(document.tempos);
    const standardMap = new LightingTempoMap(standard.document.tempos);
    for (let beat = 0; beat <= 8000; beat += 8) {
      // Standard SMF has integer microseconds, at most half a microsecond
      // per beat of rounding; the exact model is asserted above separately.
      expect(Math.abs(standardMap.beatToMs(beat) - originalMap.beatToMs(beat))).toBeLessThan(beat * 0.0005 + 0.03);
    }
  });
  it('连续变速保留原模型，标准 MIDI 独立读取仍保持播放时间', () => {
    const document = createLightingDocument();
    document.tempos = [{ beat: 0, bpm: 60, numerator: 4, denominator: 4, transition: 'linear' }, { beat: 8000, bpm: 180, numerator: 3, denominator: 4, transition: 'linear' }, { beat: 12000, bpm: 90, numerator: 7, denominator: 8 }];
    const bytes = exportLightingMidi(document);
    const imported = importLightingMidi(bytes);
    expect(imported.warnings).toEqual([]);
    expect(imported.document.tempos).toEqual(document.tempos);
    const native = parseMidi(bytes);
    native.tracks = native.tracks.map((events) => events.filter((event) => event.type !== 'sequencerSpecific'));
    const standard = importLightingMidi(writeLightingMidi(native.tracks, 960));
    expect(standard.warnings).toEqual([]);
    expect(standard.document.tempos.length).toBeGreaterThan(3);
    const originalMap = new LightingTempoMap(document.tempos); const standardMap = new LightingTempoMap(standard.document.tempos);
    for (let step = 0; step <= 12000; step += 1) {
      expect(Math.abs(standardMap.beatToMs(step) - originalMap.beatToMs(step))).toBeLessThan(0.03);
    }
    expect(Math.abs(standardMap.beatToMs(12000) - originalMap.beatToMs(12000))).toBeLessThan(0.001);
  });
  it('其他软件修改节拍后不以旧渐变元数据覆盖，损坏元数据明确拒绝', () => {
    const document = createLightingDocument();
    document.tempos = [{ beat: 0, bpm: 60, numerator: 4, denominator: 4, transition: 'linear' }, { beat: 8, bpm: 180, numerator: 4, denominator: 4 }];
    const midi = parseMidi(exportLightingMidi(document));
    const first = midi.tracks[0]!.find((event) => event.type === 'setTempo');
    if (first?.type !== 'setTempo') throw new Error('Missing tempo');
    first.microsecondsPerBeat = 500000;
    const imported = importLightingMidi(new Uint8Array(writeMidi(midi)));
    expect(imported.warnings).toContain('标准 MIDI 节拍图已被修改，按文件中的新节拍图导入');
    expect(imported.document.tempos[0]?.bpm).toBe(120);
    expect(imported.document.tempos.every((tempo) => !tempo.transition)).toBe(true);
    const metadata = midi.tracks.flat().find((event) => event.type === 'sequencerSpecific');
    if (metadata?.type !== 'sequencerSpecific') throw new Error('Missing metadata');
    metadata.data = Array.from(metadata.data).slice(0, -1);
    expect(() => importLightingMidi(new Uint8Array(writeMidi(midi)))).toThrow('连续变速扩展损坏');
  });
  it('区域、重叠区域与同名同起点标记在变速后往返，不产生重复起点', () => {
    const document = createLightingDocument();
    document.tempos.push({ beat: 4, bpm: 60, numerator: 3, denominator: 4 });
    document.markers = [
      { id: 'point', name: '副歌', startMs: 1000, endMs: null },
      { id: 'region', name: '副歌', startMs: 1000, endMs: 6000 },
      { id: 'overlap', name: '副歌', startMs: 1000, endMs: 4000 },
      { id: 'later', name: '尾声', startMs: 3000, endMs: 7000 }
    ];
    const bytes = exportLightingMidi(document);
    // Standard readers retain normal start markers without understanding our extension.
    expect(parseMidi(bytes).tracks[0]!.filter((event) => event.type === 'marker')).toHaveLength(4);
    const imported = importLightingMidi(bytes);
    expect(imported.warnings).toEqual([]);
    expect(imported.document.markers.map(({ name, startMs, endMs }) => ({ name, startMs, endMs }))).toEqual(document.markers.map(({ name, startMs, endMs }) => ({ name, startMs, endMs })));
    expect(importLightingMidi(exportLightingMidi(imported.document)).document.markers).toHaveLength(4);
  });
  it('损坏或失去起点的区域扩展拒绝导入，其他软件扩展仍明确提示', () => {
    const document = createLightingDocument();
    document.markers.push({ id: 'r', name: '区域', startMs: 1000, endMs: 2000 });
    const midi = parseMidi(exportLightingMidi(document));
    const extension = midi.tracks[0]!.find((event) => event.type === 'sequencerSpecific');
    expect(extension?.type).toBe('sequencerSpecific');
    if (extension?.type !== 'sequencerSpecific') throw new Error('缺少区域扩展');
    const data = Array.from(extension.data);
    extension.data = data.slice(0, -1);
    expect(() => importLightingMidi(new Uint8Array(writeMidi(midi)))).toThrow('区域扩展数据损坏');
    extension.data = data;
    midi.tracks[0] = midi.tracks[0]!.filter((event) => event.type !== 'marker');
    expect(() => importLightingMidi(new Uint8Array(writeMidi(midi)))).toThrow('区域扩展缺少对应起点');
    extension.data = [1, 2, 3];
    expect(importLightingMidi(new Uint8Array(writeMidi(midi))).warnings).toContain('未转换 MIDI 元数据或事件：sequencerSpecific');
  });
  it('小于一个 tick 的区域仍保持正长度', () => {
    const document = createLightingDocument();
    document.markers.push({ id: 'r', name: '短区域', startMs: 1000, endMs: 1000.0001 });
    const marker = importLightingMidi(exportLightingMidi(document)).document.markers[0]!;
    expect(marker.endMs).toBeGreaterThan(marker.startMs);
    expect(marker.endMs! - marker.startMs).toBeLessThan(1);
  });
  it.each(['beat', 'time'] as const)('极短%s音符导出至少保留一个 tick，释放必须晚于开启', (timeLock) => {
    const document = createLightingDocument();
    document.tracks.push({ id: 'track', name: '短音符', kind: 'midi', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'clip', name: '短点', start: 0, duration: 10, timeLock, muted: false, events: [
      { id: 'note', kind: 'note', at: 0, note: 60, velocity: 95, duration: 0.0001, releaseVelocity: 45 }
    ] }] });
    const bytes = exportLightingMidi(document);
    const messages = parseMidi(bytes).tracks[1]!.filter((event) => event.type === 'noteOn' || event.type === 'noteOff');
    expect(messages.map((event) => event.type)).toEqual(['noteOn', 'noteOff']);
    expect(messages[1]?.deltaTime).toBeGreaterThanOrEqual(1);
    const imported = importLightingMidi(bytes);
    expect(imported.warnings).toEqual([]);
    expect(imported.document.tracks[0]?.clips[0]?.events).toHaveLength(1);
    expect(imported.document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ kind: 'note', releaseVelocity: 45 });
  });
  it('同音连续触发在共同边界先释放再开启，同时释放保持稳定顺序', () => {
    const document = importLightingMidi(new Uint8Array(writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 960 }, tracks: [[
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 90 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 61, velocity: 80 },
      { deltaTime: 960, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 40 },
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 61, velocity: 30 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 70 },
      { deltaTime: 960, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 20 },
      { deltaTime: 0, type: 'endOfTrack' }
    ]] }))).document;
    const exported = exportLightingMidi(document);
    const notes = parseMidi(exported).tracks[1]!.filter((event) => event.type === 'noteOn' || event.type === 'noteOff');
    expect(notes.map((event) => [event.type, event.noteNumber, event.deltaTime])).toEqual([
      ['noteOn', 60, 0], ['noteOn', 61, 0], ['noteOff', 60, 960], ['noteOff', 61, 0], ['noteOn', 60, 0], ['noteOff', 60, 960]
    ]);
    const roundTrip = importLightingMidi(exported);
    expect(roundTrip.warnings).toEqual([]);
    expect(roundTrip.document.tracks[0]?.clips[0]?.events).toHaveLength(3);
  });
  it('非零释放力度经导入、保存重开、实际调度和导出保持一致', () => {
    const bytes = new Uint8Array(writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 480 }, tracks: [[
      { deltaTime: 0, type: 'noteOn', channel: 2, noteNumber: 60, velocity: 95 },
      { deltaTime: 480, type: 'noteOff', channel: 2, noteNumber: 60, velocity: 87 },
      { deltaTime: 0, type: 'endOfTrack' }
    ]] }));
    const imported = importLightingMidi(bytes);
    expect(imported.warnings).toEqual([]);
    const document = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(imported.document)));
    expect(document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ kind: 'note', velocity: 95, releaseVelocity: 87, duration: 1 });
    document.tracks[0]!.portProfileId = 'test-output';
    const sent: number[][] = [];
    const scheduler = new LightingScheduler(compileLightingPackets(document), (packet) => sent.push(packet.bytes));
    scheduler.locate(0); scheduler.tick(0); scheduler.tick(500);
    expect(sent).toEqual([[0x92, 60, 95], [0x82, 60, 87]]);
    const output = parseMidi(exportLightingMidi(document));
    expect(output.tracks.flat().find((event) => event.type === 'noteOff')).toMatchObject({ channel: 2, noteNumber: 60, velocity: 87 });
    expect(importLightingMidi(exportLightingMidi(document)).document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ releaseVelocity: 87 });
  });
  it('长音符、力度、CC、Program、中文标记和变速往返', () => {
    const document = createLightingDocument();
    document.tempos.push({ beat: 8, bpm: 90, numerator: 3, denominator: 4 });
    document.markers.push({ id: 'marker', name: '副歌起点', startMs: 4000, endMs: null });
    document.tracks.push({ id: 'track', name: '灯光', kind: 'midi', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 3, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'clip', name: '主段', start: 4, duration: 16, timeLock: 'beat', muted: false, events: [
      { id: 'note', kind: 'note', at: 0, note: 60, velocity: 95, duration: 10 },
      { id: 'cc', kind: 'cc', at: 2, controller: 7, value: 100 },
      { id: 'program', kind: 'program', at: 3, program: 6 }
    ] }] });
    const imported = importLightingMidi(exportLightingMidi(document));
    expect(imported.warnings).toEqual([]);
    expect(imported.document.tracks[0]?.channel).toBe(3);
    expect(imported.document.tracks[0]?.clips[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'note', at: 4, duration: 10, velocity: 95 }),
      expect.objectContaining({ kind: 'cc', at: 6, value: 100 }),
      expect.objectContaining({ kind: 'program', at: 7, program: 6 })
    ]));
    expect(imported.document.markers[0]?.name).toBe('副歌起点');
    expect(imported.document.tempos[1]?.bpm).toBeCloseTo(90, 3);
    expect(imported.document.tempos[1]?.numerator).toBe(3);
    expect(parseMidi(exportLightingMidi(imported.document)).header.format).toBe(1);
  });
  it('缺少释放的音符拒绝导入，不制造无限持续音符', () => {
    const bytes = new Uint8Array(writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 480 }, tracks: [[{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 90 }, { deltaTime: 480, type: 'endOfTrack' }]] }));
    expect(() => importLightingMidi(bytes)).toThrow('Note Off');
  });
  it('拒绝伪造原始音符、截断 SysEx 和非法数据字节', () => {
    for (const bytes of [[0x90, 60, 127], [0xf0, 127], [0xb0, 7, 255], [0xc0, 2, 3], [127]]) {
      expect(lightingEventSchema.safeParse({ id: 'x', kind: 'raw', at: 0, label: '', bytes }).success).toBe(false);
    }
    expect(lightingEventSchema.safeParse({ id: 'x', kind: 'raw', at: 0, label: 'MSC', bytes: [0xf0, 127, 0xf7] }).success).toBe(true);
  });
});
