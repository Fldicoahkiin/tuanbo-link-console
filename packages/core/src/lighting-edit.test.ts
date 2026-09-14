import { describe, expect, it } from 'vitest';
import { createLightingDocument, createEmptyLinkProject, lightingDocumentSchema, parseLinkProject, serializeLinkProject, type LightingClip } from '@tb/schema';
import { LightingTempoMap, lightingClipInTime, copyLightingEventsAt, lightingClipSpan, lightingCurveValue, lightingEventTime, offsetLightingEvents, quantizeLightingClip, setLightingCommand, splitLightingClip, trimLightingClip, mergeLightingClips } from './lighting-edit';
import { exportLightingMidi } from './lighting-midi-file';
import { copyLightingEvents, pasteLightingEvents } from './lighting-clipboard';
import { compileLightingPackets, LightingScheduler, type LightingPacket } from './lighting-playback';

const clip: LightingClip = { id: 'clip', name: '灯光', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'note', kind: 'note', at: 100, note: 60, velocity: 100, duration: 4000 }] };
function document() { const value = createLightingDocument(); value.outputMode = 'direct'; value.tracks.push({ id: 'track', name: '测试', kind: 'midi', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: 'light', noteNames: {}, clips: [structuredClone(clip)] }); return value; }

describe('灯光编排编辑与时间基准', () => {
  it('控台 MSC 设备号只作用于生成的 MA2 指令，原始 MIDI 保持原地址', () => {
    const value = document();
    value.tracks[0]!.clips[0]!.events = [
      { id: 'cue', kind: 'ma2', at: 0, action: 'goto', cue: '1.25', sequence: 9901, executor: '99.219', label: '测试 Cue' },
      { id: 'raw', kind: 'raw', at: 10, bytes: [0xf0, 0x7f, 12, 2, 1, 1, 0xf7], label: '原始地址' }
    ];
    const packets = compileLightingPackets(value, 5);
    expect(packets[0]?.bytes).toEqual([0xf0, 0x7f, 5, 2, 1, 1, ...Array.from('1.250\0' + '219.99', (letter) => letter.charCodeAt(0)), 0xf7]);
    expect(packets[1]?.bytes).toEqual([0xf0, 0x7f, 12, 2, 1, 1, 0xf7]);
    expect(compileLightingPackets(value)[0]?.bytes[2]).toBe(127);
    expect(compileLightingPackets(value, 0)[0]?.bytes[2]).toBe(0);
    expect(() => compileLightingPackets(value, 128)).toThrow('0–127');
  });
  it('渐快渐慢跨变速点转换曲线，控制值误差不超过千分之一且长音符不拆分', () => {
    const map = new LightingTempoMap([
      { beat: 0, bpm: 60, numerator: 4, denominator: 4, transition: 'linear' },
      { beat: 4, bpm: 240, numerator: 4, denominator: 4 },
      { beat: 5, bpm: 180, numerator: 3, denominator: 4, transition: 'linear' },
      { beat: 8, bpm: 10, numerator: 3, denominator: 4 }
    ]);
    for (const shape of ['linear', 'smooth', 'hold'] as const) {
      const from = { id: 'a', kind: 'point' as const, at: 0, value: 0, shape, controlValues: [127, 0] as [number, number] };
      const to = { id: 'b', kind: 'point' as const, at: 8, value: 127, shape: 'hold' as const };
      const source: LightingClip = { ...clip, timeLock: 'beat', start: 1, duration: 9, events: [from, to, { id: 'note', kind: 'note', at: 0.1, duration: 8, note: 60, velocity: 100 }] };
      const converted = lightingClipInTime(source, map);
      const points = converted.events.filter((event) => event.kind === 'point');
      expect(points.length).toBeLessThan(3000);
      expect(new Set(converted.events.map((event) => event.id)).size).toBe(converted.events.length);
      expect(converted.events.filter((event) => event.kind === 'note')).toHaveLength(1);
      for (let step = 0; step < 10000; step += 1) {
        const beat = step * 8 / 10000;
        const at = map.beatToMs(beat + source.start) - converted.start;
        const index = points.findIndex((point) => point.at > at) - 1;
        const left = points[index]!; const right = points[index + 1]!;
        const actual = lightingCurveValue(left, right, (at - left.at) / (right.at - left.at));
        expect(Math.abs(actual - lightingCurveValue(from, to, beat / 8))).toBeLessThanOrEqual(0.001000001);
      }
      const value = document(); value.tracks[0]!.clips = [converted];
      expect(lightingDocumentSchema.safeParse(value).success).toBe(true);
    }
  });
  it('线性渐快渐慢的节拍与绝对时间互逆，边界无跳变', () => {
    for (const [start, end] of [[60, 180], [180, 60], [120, 120.00000001], [10, 999], [999, 10]]) {
      const duration = 120000 * 8 / (start! + end!);
      const map = new LightingTempoMap([
        { beat: 0, bpm: start!, numerator: 4, denominator: 4, transition: 'linear' },
        { beat: 8, bpm: end!, numerator: 3, denominator: 4 }
      ]);
      expect(map.beatToMs(8)).toBeCloseTo(duration, 8);
      expect(map.msToBeat(duration / 2)).toBeCloseTo((start! * duration / 2 + (end! - start!) * duration / 8) / 60000, 10);
      for (let index = 0; index <= 1000; index += 1) {
        const beat = index * 0.016;
        expect(map.msToBeat(map.beatToMs(beat))).toBeCloseTo(beat, 10);
      }
      expect(map.beatToMs(8 + 1e-9) - map.beatToMs(8 - 1e-9)).toBeLessThan(0.00002);
      expect(map.hasRampBetween(duration, duration + 1000)).toBe(false);
      expect(map.hasRampBetween(0, duration)).toBe(true);
    }
  });
  it('渐变只移动节拍锁定的 Cue 和音符，时间锁定位置保持不变', () => {
    const value = document();
    value.tempos = [{ beat: 0, bpm: 60, numerator: 4, denominator: 4, transition: 'linear' }, { beat: 8, bpm: 180, numerator: 4, denominator: 4 }];
    value.tracks[0]!.clips = [
      { ...clip, id: 'beats', timeLock: 'beat', duration: 8, events: [{ id: 'n', kind: 'note', at: 3, duration: 5, note: 60, velocity: 100 }, { id: 'cue', kind: 'ma2', at: 3, action: 'goto', executor: '1.1', sequence: 1, cue: '1', label: 'Cue' }] },
      { ...clip, id: 'seconds', events: [{ id: 'fixed', kind: 'note', at: 2000, duration: 2000, note: 62, velocity: 100 }] }
    ];
    const packets = compileLightingPackets(lightingDocumentSchema.parse(value));
    expect(packets.filter((packet) => packet.phase === 'on').map((packet) => packet.atMs)).toEqual([2000, 2000]);
    expect(packets.filter((packet) => packet.phase === 'off').map((packet) => packet.atMs)).toEqual([4000, 4000]);
    expect(packets.find((packet) => packet.bytes[0] === 0xf0)?.atMs).toBe(2000);
    const converted = lightingClipInTime(value.tracks[0]!.clips[0]!, new LightingTempoMap(value.tempos));
    expect(converted.events.find((event) => event.kind === 'note')).toMatchObject({ at: 2000, duration: 2000 });
    expect(exportLightingMidi(value).length).toBeGreaterThan(0);
  });
  it('跨多个变速点合并保持曲线每个时刻的值，长音符不会拆成重触发', () => {
    const map = new LightingTempoMap([
      { beat: 0, bpm: 120, numerator: 4, denominator: 4 },
      { beat: 3, bpm: 60, numerator: 4, denominator: 4 },
      { beat: 6, bpm: 180, numerator: 3, denominator: 4 }
    ]);
    for (const shape of ['linear', 'smooth', 'hold'] as const) {
      const from = { id: 'from', kind: 'point' as const, at: 0, value: 12, shape, controlValues: [25, 110] as [number, number] };
      const to = { id: 'to', kind: 'point' as const, at: 8, value: 120, shape: 'hold' as const };
      const source: LightingClip = { ...clip, timeLock: 'beat', start: 1, duration: 9, events: [from, to, { id: 'long', kind: 'note', at: 0.5, duration: 7, note: 62, velocity: 100 }] };
      const original = structuredClone(source);
      for (const merged of [lightingClipInTime(source, map), mergeLightingClips([source, { ...clip, start: 10000, duration: 1000, events: [] }], map)]) {
      const points = merged.events.filter((event) => event.kind === 'point');
      for (let beat = 0; beat < 8; beat += 0.017) {
        const at = map.beatToMs(1 + beat) - merged.start;
        const index = points.reduce((found, point, current) => point.at <= at ? current : found, -1);
        const left = points[index]!; const right = points[index + 1]!;
        expect(lightingCurveValue(left, right, (at - left.at) / (right.at - left.at))).toBeCloseTo(lightingCurveValue(from, to, beat / 8), 9);
      }
      const notes = merged.events.filter((event) => event.kind === 'note');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.duration).toBeCloseTo(map.beatToMs(8.5) - map.beatToMs(1.5), 9);
      expect(source).toEqual(original);
      const value = document(); value.tracks[0]!.clips = [merged];
      expect(lightingDocumentSchema.parse(JSON.parse(JSON.stringify(value))).tracks[0]!.clips[0]).toEqual(merged);
      }
    }
  });
  it('整组复制以最早点为锚点，保留完整音符并延长片段', () => {
    const source: LightingClip = { ...clip, events: [
      { id: 'later', kind: 'note', at: 2000, note: 60, velocity: 100, duration: 4000 },
      { id: 'earlier', kind: 'cc', at: 1000, controller: 7, value: 80 },
      { id: 'unselected', kind: 'program', at: 500, program: 4 }
    ] };
    const result = copyLightingEventsAt(source, new Set(['later', 'earlier']), 9000);
    expect(result.clip.events.slice(3)).toMatchObject([{ at: 10000, duration: 4000 }, { at: 9000, value: 80 }]);
    expect(result.clip.duration).toBe(14000);
    expect(new Set(result.clip.events.map((event) => event.id)).size).toBe(5);
    expect(result.copiedIds).toEqual(result.clip.events.slice(3).map((event) => event.id));
    expect(source.events).toHaveLength(3);
    expect(source.duration).toBe(10000);
    expect(() => copyLightingEventsAt(source, new Set(['later']), -1)).toThrow('复制位置');
    expect(() => copyLightingEventsAt(source, new Set(['later']), NaN)).toThrow('复制位置');
    expect(copyLightingEventsAt(source, new Set(), 0).clip).toBe(source);
  });
  it('节拍锁定复制保留拍间距、音符长度及曲线控制点', () => {
    const source: LightingClip = { ...clip, timeLock: 'beat', duration: 8, events: [
      { id: 'curve', kind: 'point', at: 1, value: 20, shape: 'smooth', controlValues: [30, 70] },
      { id: 'note', kind: 'note', at: 3, note: 60, velocity: 100, duration: 2 }
    ] };
    const result = copyLightingEventsAt(source, new Set(['curve', 'note']), 7);
    expect(result.clip.events.slice(2)).toMatchObject([{ at: 7, controlValues: [30, 70] }, { at: 9, duration: 2 }]);
    expect(result.clip.duration).toBe(11);
    const map = new LightingTempoMap([{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }, { beat: 8, bpm: 60, numerator: 4, denominator: 4 }]);
    expect(lightingEventTime(result.clip, result.clip.events[2]!, map)).toBe(3500);
    expect(lightingEventTime(result.clip, result.clip.events[3]!, map)).toBe(5000);
    const value = document(); value.tracks[0]!.clips = [result.clip];
    expect(lightingDocumentSchema.parse(JSON.parse(JSON.stringify(value))).tracks[0]!.clips[0]).toEqual(result.clip);
  });
  it('批量偏移跨变速点保持实际时间间隔，并延长片段容纳完整音符', () => {
    const map = new LightingTempoMap([{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }, { beat: 4, bpm: 60, numerator: 4, denominator: 4 }]);
    const source: LightingClip = { ...clip, timeLock: 'beat', duration: 6, events: [
      { id: 'a', kind: 'note', at: 2, duration: 1, note: 60, velocity: 100 },
      { id: 'b', kind: 'cc', at: 5, controller: 7, value: 100 },
      { id: 'c', kind: 'note', at: 5, duration: 1, note: 62, velocity: 100 }
    ] };
    const shifted = offsetLightingEvents(source, new Set(['a', 'c']), 2000, map);
    expect(lightingEventTime(shifted, shifted.events[0]!, map)).toBe(3000);
    expect(lightingEventTime(shifted, shifted.events[2]!, map)).toBe(5000);
    expect(shifted.events[1]).toEqual(source.events[1]);
    expect(shifted.duration).toBe(8);
    expect(source.duration).toBe(6);
    expect(() => offsetLightingEvents(source, new Set(['a']), -2000, map)).toThrow('片段起点');
    expect(() => offsetLightingEvents(source, new Set(['a']), NaN, map)).toThrow('有效数字');
  });
  it('修剪跨界音符并移除片段外事件，合并保持绝对时间', () => {
    const trimmed = trimLightingClip(clip, 1000);
    expect(trimmed.events[0]).toMatchObject({ at: 100, duration: 900 });
    const map = new LightingTempoMap(createLightingDocument().tempos);
    const merged = mergeLightingClips([trimmed, { ...trimmed, id: 'second', start: 4, duration: 2, timeLock: 'beat', events: [{ id: 'later', kind: 'cc', at: 1, controller: 7, value: 127 }] }], map);
    expect(merged).toMatchObject({ start: 0, duration: 3000, timeLock: 'time' });
    expect(merged.events[1]).toMatchObject({ kind: 'cc', at: 2500 });
  });
  it('线性曲线拆分保留边界值', () => {
    const curve = { ...clip, events: [{ id: 'a', kind: 'point' as const, at: 0, value: 0, shape: 'linear' as const }, { id: 'b', kind: 'point' as const, at: 8000, value: 100, shape: 'hold' as const }] };
    const [left, right] = splitLightingClip(curve, 4000);
    expect(left.events.at(-1)).toMatchObject({ at: 4000, value: 50 });
    expect(right.events).toEqual(expect.arrayContaining([expect.objectContaining({ at: 0, value: 50 })]));
    const value = document(); value.tracks[0]!.clips = [left, right];
    expect(lightingDocumentSchema.safeParse(value).success).toBe(true);
  });
  it('平滑曲线多次拆分并保存重开，所有位置的曲率保持不变', () => {
    const from = { id: 'a', kind: 'point' as const, at: 0, value: 12, shape: 'smooth' as const };
    const to = { id: 'b', kind: 'point' as const, at: 8000, value: 120, shape: 'hold' as const };
    const curve: LightingClip = { ...clip, events: [from, to] };
    const [first, rest] = splitLightingClip(curve, 2300);
    const [second, last] = splitLightingClip(rest, 1800);
    const value = document(); value.tracks[0]!.clips = [first, second, last];
    const restored = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(value)));
    for (let at = 0; at <= 8000; at += 17) {
      const segment = restored.tracks[0]!.clips.find((part) => part.start <= at && part.start + part.duration > at)!;
      const points = segment.events.filter((event) => event.kind === 'point').sort((a, b) => a.at - b.at);
      const a = points[0]!; const b = points[1]!;
      expect(lightingCurveValue(a, b, (at - segment.start - a.at) / (b.at - a.at))).toBeCloseTo(lightingCurveValue(from, to, at / 8000), 10);
    }
    expect(curve.events).toEqual([from, to]);
  });
  it('变速前后双向转换无累计误差', () => {
    const map = new LightingTempoMap([{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }, { beat: 8, bpm: 60, numerator: 3, denominator: 4 }]);
    expect(map.beatToMs(10)).toBe(6000); expect(map.msToBeat(6000)).toBe(10);
    for (let beat = 0; beat < 100; beat += 0.13) expect(map.msToBeat(map.beatToMs(beat))).toBeCloseTo(beat, 10);
    expect(lightingClipSpan({ ...clip, timeLock: 'beat', start: 7, duration: 3 }, map)).toEqual({ startMs: 3500, endMs: 6000 });
  });
  it.each(['linear', 'smooth', 'hold'] as const)('在已有 %s 控制点处拆分，保留左侧终点及整段输出', (shape) => {
    const curve: LightingClip = { ...clip, events: [
      { id: 'a', kind: 'point', at: 0, value: 0, shape },
      { id: 'b', kind: 'point', at: 4000, value: 100, shape: 'linear' },
      { id: 'c', kind: 'point', at: 8000, value: 20, shape: 'hold' }
    ] };
    const [left, right] = splitLightingClip(curve, 4000);
    expect(left.events.at(-1)).toMatchObject({ at: 4000, value: 100, shape: 'hold' });
    expect(right.events[0]).toMatchObject({ at: 0, value: 100, shape: 'linear' });
    const original = document(); original.tracks[0]!.clips = [curve];
    const split = document(); split.tracks[0]!.clips = [left, right];
    expect(lightingDocumentSchema.safeParse(split).success).toBe(true);
    const output = (value: ReturnType<typeof document>) => new Map(compileLightingPackets(value).map((packet) => [packet.atMs, packet.bytes]));
    expect(output(split)).toEqual(output(original));
    expect(trimLightingClip(curve, 4000).events.at(-1)).toMatchObject({ at: 4000, value: 100 });
  });
  it.each([NaN, Infinity, -Infinity])('拒绝非法拆分位置 %s 而不生成损坏片段', (at) => {
    expect(() => splitLightingClip(clip, at)).toThrow('片段内部');
  });
  it('时间锁定片段不随 BPM 移动，节拍锁定会变化', () => {
    const map = new LightingTempoMap([{ beat: 0, bpm: 60, numerator: 4, denominator: 4 }]);
    expect(lightingClipSpan(clip, map).endMs).toBe(10000);
    expect(lightingClipSpan({ ...clip, duration: 4, timeLock: 'beat' }, map).endMs).toBe(4000);
  });
  it('拆分跨界音符时保持左右时长并生成新身份', () => {
    const [left, right] = splitLightingClip(clip, 1000);
    expect(left.events[0]).toMatchObject({ duration: 900 });
    expect(right.events[0]).toMatchObject({ at: 0, duration: 3100 });
    expect(right.events[0]?.id).not.toBe('note');
  });
  it('量化不会把长音符推出片段边界', () => {
    const map = new LightingTempoMap(createLightingDocument().tempos);
    const result = quantizeLightingClip({ ...clip, events: [{ ...clip.events[0]!, at: 5900 }] }, map, 1);
    expect(result.events[0]?.at).toBe(6000);
  });
  it('拒绝越界事件、重复对象和循环范围倒置', () => {
    const value = document(); value.tracks[0]!.clips[0]!.events[0]!.at = 10000;
    expect(lightingDocumentSchema.safeParse(value).success).toBe(false);
    const invalid = document(); invalid.loop.endMs = invalid.loop.startMs;
    expect(lightingDocumentSchema.safeParse(invalid).success).toBe(false);
  });
  it('灯光命令使用 schema 2 保存并可恢复原工程', () => {
    const original = createEmptyLinkProject('灯光测试');
    original.rundown.push({ id: 'song', title: '测试', enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [] });
    const command = setLightingCommand('song', document()); const result = command.execute(original);
    expect(result.schemaVersion).toBe(2); expect(result.rundown[0]?.lighting?.tracks).toHaveLength(1);
    expect(original.rundown[0]?.lighting).toBeUndefined(); expect(command.undo(original)).toEqual(original);
  });
});
describe('灯光输出调度', () => {
  it('MA2 指定 Cue 使用三位小数并把页.编号转换为 MSC 编号.页', () => {
    const value = document();
    value.tracks[0]!.clips[0]!.events = [{ id: 'cue', kind: 'ma2', at: 100, cue: '37.2', label: '', sequence: 1, executor: '1.5', action: 'goto' }];
    expect(compileLightingPackets(value)[0]?.bytes).toEqual([0xf0, 0x7f, 0x7f, 2, 1, 1, 0x33, 0x37, 0x2e, 0x32, 0x30, 0x30, 0, 0x35, 0x2e, 0x31, 0xf7]);
  });
  it('MA2 关闭执行器使用 Go_Off，不发送暂停', () => {
    const value = document();
    value.tracks[0]!.clips[0]!.events = [{ id: 'cue', kind: 'ma2', at: 100, cue: '37.2', label: '', sequence: 1, executor: '5.9', action: 'off' }];
    expect(compileLightingPackets(value)[0]?.bytes).toEqual([0xf0, 0x7f, 0x7f, 2, 1, 0x0b, 0x30, 0x2e, 0x30, 0x30, 0x30, 0, 0x39, 0x2e, 0x35, 0xf7]);
  });
  it('下一 Cue 不能被悄悄替换为指定 Cue，过精编号不能被截断', () => {
    const value = document();
    const event = { id: 'cue', kind: 'ma2' as const, at: 100, cue: '1', label: '', sequence: 1, executor: '1.5', action: 'go' as const };
    value.tracks[0]!.clips[0]!.events = [event];
    expect(() => compileLightingPackets(value)).toThrow('下一步');
    value.tracks[0]!.clips[0]!.events = [{ ...event, action: 'goto', cue: '1.0001' }];
    expect(() => compileLightingPackets(value)).toThrow('三位小数');
  });
  it('长音符不受旧两秒触发限制，停止释放音符', () => {
    const sent: LightingPacket[] = []; const scheduler = new LightingScheduler(compileLightingPackets(document()), (packet) => sent.push(packet));
    scheduler.locate(0); scheduler.tick(100); expect(sent[0]?.bytes).toEqual([0x90, 60, 100]);
    scheduler.tick(3000); expect(sent).toHaveLength(1); scheduler.stop(); expect(sent[1]?.bytes).toEqual([0x80, 60, 0]);
  });
  it('中途定位不补发历史音符或无主释放', () => {
    const sent: LightingPacket[] = []; const scheduler = new LightingScheduler(compileLightingPackets(document()), (packet) => sent.push(packet));
    scheduler.locate(2000); scheduler.tick(5000); expect(sent).toEqual([]);
  });
  it('循环回起点可再次触发，同位置重复 tick 不重复', () => {
    const sent: LightingPacket[] = []; const scheduler = new LightingScheduler(compileLightingPackets(document()), (packet) => sent.push(packet));
    scheduler.locate(0); scheduler.tick(100); scheduler.tick(100); expect(sent).toHaveLength(1);
    scheduler.tick(0); scheduler.tick(100); expect(sent.map((packet) => packet.phase)).toEqual(['on', 'off', 'on']);
  });
  it('跨过循环终点时补齐最后轮询区间，排除终点并释放长音符', () => {
    const value = document();
    value.tracks[0]!.clips[0]!.events = [
      { id: 'start', kind: 'cc', at: 1000, controller: 7, value: 10 },
      { id: 'held', kind: 'note', at: 4996, duration: 100, note: 60, velocity: 100 },
      { id: 'last', kind: 'ma2', at: 4999, cue: '1.250', label: '', sequence: 1, executor: '1.5', action: 'goto' },
      { id: 'end', kind: 'cc', at: 5000, controller: 7, value: 99 }
    ];
    const sent: LightingPacket[] = [];
    const scheduler = new LightingScheduler(compileLightingPackets(value), (packet) => sent.push(packet));
    scheduler.locate(1000); scheduler.tick(4995); scheduler.loop(1000, 5000);
    expect(sent.map((packet) => packet.phase)).toEqual(['control', 'on', 'control', 'off']);
    expect(sent[2]?.bytes[0]).toBe(0xf0);
    expect(sent.some((packet) => packet.atMs === 5000)).toBe(false);
    scheduler.tick(1000); scheduler.tick(1000);
    expect(sent.filter((packet) => packet.atMs === 1000)).toHaveLength(2);
    scheduler.loop(1000, 5000);
    expect(sent.filter((packet) => packet.bytes[0] === 0xf0)).toHaveLength(2);
    const count = sent.length; scheduler.stop(); expect(sent).toHaveLength(count);
  });
  it('无效定位与循环不释放当前音符或改变播放队列', () => {
    const sent: LightingPacket[] = [];
    const scheduler = new LightingScheduler(compileLightingPackets(document()), (packet) => sent.push(packet));
    scheduler.locate(0); scheduler.tick(100);
    expect(() => scheduler.locate(NaN)).toThrow('定位');
    expect(() => scheduler.loop(1000, 1000)).toThrow('循环');
    expect(() => scheduler.loop(-1, 5000)).toThrow('循环');
    expect(() => scheduler.finish(Number.NaN)).toThrow('结束');
    expect(sent).toHaveLength(1);
    scheduler.stop(); expect(sent.at(-1)?.phase).toBe('off');
  });
  it('自然结束补齐尾段并释放，重复结束和未开始结束不会重放历史', () => {
    const value = document();
    value.tracks[0]!.clips[0]!.events = [
      { id: 'tail', kind: 'note', at: 4999, duration: 100, note: 60, velocity: 100 },
      { id: 'boundary', kind: 'cc', at: 5000, controller: 7, value: 99 }
    ];
    const sent: LightingPacket[] = [];
    const scheduler = new LightingScheduler(compileLightingPackets(value), (packet) => sent.push(packet));
    scheduler.finish(5000); expect(sent).toEqual([]);
    scheduler.locate(0); scheduler.tick(4995); scheduler.finish(5000);
    expect(sent.map((packet) => packet.bytes)).toEqual([[0x90, 60, 100], [0x80, 60, 0]]);
    scheduler.finish(5000); scheduler.stop(); expect(sent).toHaveLength(2);
  });
  it('相同音高重叠时最后一个音符结束才释放', () => {
    const value = document(); value.tracks[0]!.clips[0]!.events.push({ id: 'second', kind: 'note', at: 200, note: 60, velocity: 90, duration: 6000 });
    const sent: LightingPacket[] = []; const scheduler = new LightingScheduler(compileLightingPackets(value), (packet) => sent.push(packet));
    scheduler.locate(0); scheduler.tick(5000); expect(sent.map((packet) => packet.phase)).toEqual(['on', 'on']);
    scheduler.tick(6200); expect(sent.at(-1)?.phase).toBe('off');
  });
  it('时间码模式不重复发送触发事件', () => { const value = document(); value.outputMode = 'timecode'; expect(compileLightingPackets(value)).toEqual([]); });
  it('静音轨道不输出', () => { const value = document(); value.tracks[0]!.muted = true; expect(compileLightingPackets(value)).toEqual([]); });
  it('线性曲线按固定密度生成并保留终点', () => {
    const value = document(); value.tracks[0]!.clips[0]!.events = [{ id: 'a', kind: 'point', at: 0, value: 0, shape: 'linear' }, { id: 'b', kind: 'point', at: 1000, value: 127, shape: 'hold' }];
    const packets = compileLightingPackets(value); expect(packets).toHaveLength(26); expect(packets.at(-1)?.bytes).toEqual([0xb0, 7, 127]);
  });
});


describe('MA2 原生推杆节目数据', () => {
  const master = { id: 'master', kind: 'ma2-fader' as const, at: 500, executor: '99.219', fader: 'Master' as const, level: 0.755, label: '主推杆' };
  it('编辑命令、序列化重开和撤销保留精确值及输出目标', () => {
    const value = document(); value.outputMode = 'timecode'; value.tracks[0]!.clips[0]!.events = [master];
    const original = createEmptyLinkProject('推杆保存');
    original.rundown.push({ id: 'song', title: '测试', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [] });
    const command = setLightingCommand('song', value);
    const saved = parseLinkProject(JSON.parse(serializeLinkProject(command.execute(original))));
    expect(saved.schemaVersion).toBe(2);
    expect(saved.rundown[0]?.lighting?.tracks[0]?.clips[0]?.events).toEqual([master]);
    expect(command.undo(original)).toEqual(original);
    expect(compileLightingPackets(value)).toEqual([]);
    expect(() => compileLightingPackets({ ...value, outputMode: 'direct' })).toThrow('原生推杆');
    expect(() => exportLightingMidi(value)).toThrow('原生推杆');
  });
  it('复制和拆分不量化推杆值，也不改变目标', () => {
    const source = { ...clip, events: [master] };
    const copied = copyLightingEvents(source, new Set([master.id]));
    if (!copied) throw new Error('推杆复制失败');
    const pasted = pasteLightingEvents({ ...clip, events: [] }, copied, 1200, new LightingTempoMap(createLightingDocument().tempos));
    expect({ ...pasted.clip.events[0], id: master.id }).toEqual({ ...master, at: 1200 });
    expect(pasted.clip.events[0]?.id).not.toBe(master.id);
    const [left, right] = splitLightingClip(source, 250);
    expect(left.events).toEqual([]);
    expect({ ...right.events[0], id: master.id }).toEqual({ ...master, at: 250 });
  });
  it('拒绝无效比例、执行器和未经定义的推杆目标', () => {
    for (const patch of [{ level: -0.1 }, { level: 1.01 }, { level: NaN }, { executor: '0.1' }, { fader: 'Speed' }]) {
      const value = document(); value.tracks[0]!.clips[0]!.events = [{ ...master, ...patch } as typeof master];
      expect(lightingDocumentSchema.safeParse(value).success).toBe(false);
    }
  });
});
