import { expect, it } from 'vitest';
import { importLightingReaper } from './lighting-reaper';
import { writeMidi } from 'midi-file';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { compileLightingPackets } from './lighting-playback';

it('原生多 Take 保留启用版本、各自偏移倍速和全部播放状态', () => {
  const result = importLightingReaper(readFileSync(new URL('./fixtures/reaper-native-takes-6.05.rpp', import.meta.url), 'utf8'));
  expect(result.warnings).toEqual([]);
  for (const version of [1, 2, 3]) {
    const track = result.document.tracks.find((entry) => entry.name === `native-takes-${version}`)!;
    expect(track.clips).toHaveLength(3);
    expect(track.clips.filter((clip) => !clip.muted).map((clip) => clip.name)).toEqual(version === 3 ? ['Version 1', 'Version 2', 'Version 3'] : [`Version ${version}`]);
    const packets = compileLightingPackets({ ...result.document, tracks: [{ ...track, muted: false, portProfileId: 'test-output' }] });
    expect(packets.filter((packet) => packet.phase === 'on').map((packet) => packet.bytes[1])).toEqual(version === 3 ? [61, 62, 63] : [60 + version]);
    for (const [index, clip] of track.clips.entries()) {
      const notes = clip.events.filter((event) => event.kind === 'note');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note).toBe(61 + index);
      expect(clip.start + notes[0]!.at).toBeCloseTo(3500 + index * 500, 7);
      expect(notes[0]!.duration).toBeCloseTo(250, 7);
    }
  }
});

it('多 Take 选择含糊或未知标志不能按第一版本静默导入', () => {
  const native = readFileSync(new URL('./fixtures/reaper-native-takes-6.05.rpp', import.meta.url), 'utf8');
  expect(() => importLightingReaper(native.replace('TAKE SEL', 'TAKE UNKNOWN'))).toThrow('Take 标志');
  expect(() => importLightingReaper(native.replace('ALLTAKES 0', 'ALLTAKES 2'))).toThrow('播放状态');
  expect(() => importLightingReaper(native.replace('TAKE SEL', 'TAKE SEL\nTAKE SEL'))).toThrow('多个启用 Take');
});

it('原生 SysEx、选中音符和静音音符保留字节、绝对顺序及静音状态', () => {
  const result = importLightingReaper(readFileSync(new URL('./fixtures/reaper-native-messages-6.05.rpp', import.meta.url), 'utf8'));
  expect(result.warnings).toEqual([]);
  const track = result.document.tracks.find((entry) => entry.name === 'native-message-order')!;
  expect(track.clips).toHaveLength(2);
  const active = track.clips.find((clip) => !clip.muted)!;
  const muted = track.clips.find((clip) => clip.muted)!;
  const notes = active.events.filter((event) => event.kind === 'note');
  expect(notes.map((note) => note.note)).toEqual([60, 67]);
  expect(notes[0]!.duration).toBeCloseTo(828.427124746190, 7);
  expect(notes[1]!.at).toBeCloseTo(2000, 7);
  expect(notes[1]!.duration).toBeCloseTo(242.640687119285, 7);
  const messages = active.events.filter((event) => event.kind === 'raw');
  expect(messages.map((message) => message.bytes)).toEqual([
    [0xf0, 0x7f, 0x7f, 2, 1, 1, 0x31, 0xf7], [0xf0, 0x7d, 1, 2, 3, 0xf7], [0xf0, 0x7d, 9, 8, 0xf7]
  ]);
  [449.489742783178, 1162.277660168379, 2472.135954999580].forEach((ms, index) => expect(messages[index]!.at).toBeCloseTo(ms, 7));
  expect(active.events.find((event) => event.kind === 'cc' && event.controller === 7)?.at).toBeCloseTo(828.427124746190, 7);
  expect(muted.events).toHaveLength(1);
  expect(muted.events[0]).toMatchObject({ kind: 'note', note: 65, velocity: 90 });
  expect(muted.events[0]!.at).toBeCloseTo(1464.101615137754, 7);
  const packets = compileLightingPackets({ ...result.document, tracks: [{ ...track, muted: false, portProfileId: 'test-output' }] });
  expect(packets.filter((packet) => packet.phase === 'on').map((packet) => packet.bytes[1])).toEqual([60, 67]);
  expect(packets.filter((packet) => packet.bytes[0] === 0xf0).map((packet) => packet.bytes)).toEqual(messages.map((message) => message.bytes));
});

it('损坏的原生 SysEx 扩展块不能部分导入', () => {
  const native = readFileSync(new URL('./fixtures/reaper-native-messages-6.05.rpp', import.meta.url), 'utf8');
  for (const invalid of ['?', '8H8=', 'AH0BAgP3', '8P8BAgP3']) expect(() => importLightingReaper(native.replace('8H0BAgP3', invalid))).toThrow('SysEx');
  expect(() => importLightingReaper(native.replace('<x 480 0', '<x 480 1'))).toThrow('标志');
});

it.each(['ramp', 'loop'])('原生 REAPER %s 工程的偏移、倍速、循环和零点边界保留实际音符起止', (fixture) => {
  const expected = z.object({ reaperVersion: z.string(), tracks: z.array(z.object({ name: z.string(), notes: z.array(z.object({ note: z.number(), startMs: z.number(), endMs: z.number() })) })) }).parse(JSON.parse(readFileSync(new URL(`./fixtures/reaper-native-${fixture}-6.05.expected.json`, import.meta.url), 'utf8')));
  const result = importLightingReaper(readFileSync(new URL(`./fixtures/reaper-native-${fixture}-6.05.rpp`, import.meta.url), 'utf8'));
  expect(expected.reaperVersion).toBe('6.05/x64');
  expect(result.warnings).toEqual([]);
  expect(expected.tracks).toHaveLength(6);
  for (const reference of expected.tracks) {
    const track = result.document.tracks.find((entry) => entry.name === reference.name)!;
    expect(track, reference.name).toBeDefined();
    expect(track.muted).toBe(true);
    const clip = track.clips[0]!;
    const notes = clip.events.filter((event) => event.kind === 'note');
    expect(notes).toHaveLength(reference.notes.length);
    reference.notes.forEach((note, index) => {
      expect(notes[index]!.note).toBe(note.note);
      expect(clip.start + notes[index]!.at, `${reference.name} start`).toBeCloseTo(Math.max(clip.start, note.startMs), 7);
      expect(clip.start + notes[index]!.at + notes[index]!.duration, `${reference.name} end`).toBeCloseTo(Math.min(clip.start + clip.duration, note.endMs), 7);
    });
  }
});

it('原生 REAPER 6.05 保存样例保留音符、静音独奏、3/4 拍与重叠区域', () => {
  const rpp = readFileSync(new URL('./fixtures/reaper-native-6.05.rpp', import.meta.url), 'utf8');
  const result = importLightingReaper(rpp);
  expect(result.warnings).toEqual([]);
  expect(result.document.tempos).toEqual([{ beat: 0, bpm: 120, numerator: 3, denominator: 4, transition: 'hold' }]);
  expect(result.document.tracks).toHaveLength(1);
  expect(result.document.tracks[0]).toMatchObject({ name: 'TBLINK muted solo sample', muted: true, solo: true, clips: [{ start: 0, duration: 8000, events: [expect.objectContaining({ kind: 'note', at: 1000, duration: 1000, note: 60, velocity: 100 })] }] });
  expect(result.document.markers.map(({ name, startMs, endMs }) => ({ name, startMs, endMs }))).toEqual([
    { name: 'Point one', startMs: 1000, endMs: null },
    { name: 'Region one', startMs: 2000, endMs: 5000 },
    { name: 'Region overlap', startMs: 3000, endMs: 6000 }
  ]);
});

const source = `<REAPER_PROJECT 0.1 6.05 1
TEMPO 120
MARKER 1 2 "副歌" 0
<TRACK
NAME "灯光 MIDI"
<ITEM
POSITION 2
LENGTH 4
NAME "片段一"
<SOURCE MIDI
HASDATA 1 960 QN
E 0 90 3c 64
E 1920 80 3c 00
>
>
>
>`;
it('导入 REAPER 内嵌 MIDI 保持音乐绝对位置、音符长度与标记', () => {
  const { document, warnings } = importLightingReaper(source);
  expect(warnings).toEqual([]);
  expect(document.tracks[0]?.clips[0]).toMatchObject({ name: '片段一', start: 2000, duration: 4000, events: [expect.objectContaining({ kind: 'note', at: 0, duration: 1000, note: 60, velocity: 100 })] });
  expect(document.markers[0]).toMatchObject({ name: '副歌', startMs: 2000 });
});
it('REAPER 渐变包络保留拍号，并从片段实际歌曲位置换算音符', () => {
  const rpp = source.replace('TEMPO 120', 'TEMPO 60 4 4\n<TEMPOENVEX\nACT 1 -1\nPT 0 60 0\nPT 4 180 1 524295\n>');
  const result = importLightingReaper(rpp);
  expect(result.warnings).toEqual([]);
  expect(result.document.tempos).toEqual([{ beat: 0, bpm: 60, numerator: 4, denominator: 4, transition: 'linear' }, { beat: 8, bpm: 180, numerator: 7, denominator: 8, transition: 'hold' }]);
  const note = result.document.tracks[0]!.clips[0]!.events[0]!;
  expect(note.kind).toBe('note');
  if (note.kind !== 'note') throw new Error('Missing note');
  expect(note.duration).toBeCloseTo((Math.sqrt(60 ** 2 + 3600 * 5) - 60) / 0.03 - 2000, 8);
});
it('循环 MIDI 在阶跃变速后按节拍重复，末次音符裁到片段结束', () => {
  const rpp = source.replace('TEMPO 120', 'TEMPO 120\n<TEMPOENVEX\nPT 0 120 1\nPT 2 60 1\n>').replace('POSITION 2', 'POSITION 1\nLOOP 1');
  const result = importLightingReaper(rpp);
  expect(result.document.tracks[0]!.clips[0]!.events).toEqual([
    expect.objectContaining({ kind: 'note', at: 0, duration: 1000 }),
    expect.objectContaining({ kind: 'note', at: 1000, duration: 2000 }),
    expect.objectContaining({ kind: 'note', at: 3000, duration: 1000 })
  ]);
});
it('短于一拍的 MIDI 循环保留素材实际长度', () => {
  const rpp = source.replace('POSITION 2', 'POSITION 2\nLOOP 1').replace('E 1920 80 3c 00', 'E 240 80 3c 00\nE 240 b0 7b 00');
  const notes = importLightingReaper(rpp).document.tracks[0]!.clips[0]!.events.filter((event) => event.kind === 'note');
  expect(notes.map((event) => event.at)).toEqual(Array.from({ length: 16 }, (_, index) => index * 250));
  expect(notes.every((event) => event.duration === 125)).toBe(true);
});
it('关闭的变速包络及明确忽略工程 BPM 的 MIDI 使用各自固定速度', () => {
  const rpp = source.replace('TEMPO 120', 'TEMPO 120\n<TEMPOENVEX\nACT 0\nPT 0 60 0\nPT 4 180 1\n>');
  expect(importLightingReaper(rpp).document.tempos).toEqual([{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }]);
  const ignored = importLightingReaper(rpp.replace('ACT 0', 'ACT 1').replace('HASDATA 1 960 QN', 'HASDATA 1 960 QN\nIGNTEMPO 1 90 4 4'));
  const note = ignored.document.tracks[0]!.clips[0]!.events[0]!;
  if (note.kind !== 'note') throw new Error('Missing note');
  expect(note.duration).toBeCloseTo(4000 / 3, 8);
});
it('畸形、重复或未知形状的 REAPER 变速不能按基础 BPM 静默导入', () => {
  for (const rows of ['PT 0 120 5', 'PT 0 120 1\nPT 0 60 1', 'PT 2 120 1\nPT 1 60 1', 'PT 0 120 1 196615', 'PT 0 0 1']) {
    expect(() => importLightingReaper(source.replace('TEMPO 120', `TEMPO 120\n<TEMPOENVEX\n${rows}\n>`))).toThrow();
  }
});
it('缺失外部 MIDI 和无法理解的 SysEx 不静默丢弃', () => {
  expect(() => importLightingReaper(source.replace('HASDATA 1 960 QN', 'FILE "missing.mid"'))).toThrow('missing.mid');
  expect(() => importLightingReaper(source.replace('E 0 90 3c 64', 'E 0 f0 7f f7'))).toThrow('还不支持');
});
it('外部 MIDI 优先按工程相对路径匹配，同名文件互不覆盖', () => {
  const midi = (noteNumber: number) => new Uint8Array(writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 960 }, tracks: [[
    { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber, velocity: 100 },
    { deltaTime: 960, type: 'noteOff', channel: 0, noteNumber, velocity: 0 },
    { deltaTime: 0, type: 'endOfTrack' }
  ]] }));
  const files = new Map([['D:\\Show\\Left\\same.mid', midi(60)], ['d:/show/right/SAME.MID', midi(72)]]);
  const rpp = (reference: string) => source.replace('HASDATA 1 960 QN', `FILE "${reference}"`);
  for (const reference of ['../right/same.mid', '..\\RIGHT\\same.mid', 'd:/show/right/./SAME.MID']) {
    const result = importLightingReaper(rpp(reference), files, 'D:/Show/Left/show.rpp');
    expect(result.document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ kind: 'note', note: 72 });
  }
  expect(importLightingReaper(rpp('same.mid'), files, 'D:/Show/Left/show.rpp').document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ note: 60 });
  expect(() => importLightingReaper(rpp('lost/same.mid'), files)).toThrow('同名文件');
  // Relocated projects can still use one uniquely named selected file.
  expect(importLightingReaper(rpp('old/location/same.mid'), new Map([['D:/Moved/SAME.MID', midi(72)]])).document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ note: 72 });
  expect(() => importLightingReaper(rpp('same.mid'), new Map([['D:/Show/same.mid', midi(60)], ['d:\\show\\SAME.MID', midi(72)]]))).toThrow('重复选择');
});
it('内嵌 MIDI 的非零释放力度随音符位置转换保留', () => {
  const result = importLightingReaper(source.replace('80 3c 00', '80 3c 47'));
  expect(result.warnings).toEqual([]);
  expect(result.document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ kind: 'note', releaseVelocity: 71, duration: 1000 });
});
it('畸形工程和无效速度明确拒绝', () => {
  expect(() => importLightingReaper(source.slice(0, -1))).toThrow('不完整');
  expect(() => importLightingReaper(source.replace('POSITION 2', 'POSITION 2\nPLAYRATE 0'))).toThrow('速度');
});
it('内嵌按键压力和通道压力保持数据与增量时间', () => {
  const result = importLightingReaper(source.replace('E 1920 80 3c 00', 'E 480 a0 3c 45\nE 480 d0 32\nE 960 80 3c 00'));
  expect(result.warnings).toEqual([]);
  expect(result.document.tracks[0]?.clips[0]?.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'raw', at: 250, bytes: [0xa0, 60, 69] }),
    expect.objectContaining({ kind: 'raw', at: 500, bytes: [0xd0, 50] }),
    expect.objectContaining({ kind: 'note', at: 0, duration: 1000 })
  ]));
});
it('畸形 MIDI 数据不能被写文件库补零或截断后静默导入', () => {
  for (const row of ['E 0 a0 3c', 'E 0 d0 80', 'E 0 a0 3c 10junk', 'E 0.5 d0 20', 'E 0 d0 20 10']) {
    expect(() => importLightingReaper(source.replace('E 0 90 3c 64', row))).toThrow(/MIDI/);
  }
  expect(() => importLightingReaper(source.replace('HASDATA 1 960 QN', 'HASDATA 1 0 QN'))).toThrow('节拍精度');
});
it('重叠区域按独立编号配对，点标记可使用同一编号', () => {
  const result = importLightingReaper(source.replace('MARKER 1 2 "副歌" 0', 'MARKER 1 1 "起点" 0\nMARKER 1 2 "副歌" 9 0 1 B\nMARKER 2 3 "重叠" 1\nMARKER 1 5 "" 9\nMARKER 2 6 "" 1'));
  expect(result.warnings).toEqual([]);
  expect(result.document.markers).toEqual([
    expect.objectContaining({ name: '起点', startMs: 1000, endMs: null }),
    expect.objectContaining({ name: '副歌', startMs: 2000, endMs: 5000 }),
    expect.objectContaining({ name: '重叠', startMs: 3000, endMs: 6000 })
  ]);
  expect(() => importLightingReaper(source.replace('MARKER 1 2 "副歌" 0', 'MARKER 1 2 "副歌" 1'))).toThrow('缺少端点');
});
it('轨道静音、两种独奏和锁定状态不再丢失', () => {
  for (const solo of [1, 2]) {
    const result = importLightingReaper(source.replace('NAME "灯光 MIDI"', `NAME "灯光 MIDI"\nMUTESOLO 1 ${solo} 0\nLOCK 1`));
    expect(result.warnings).toEqual([]);
    expect(result.document.tracks[0]).toMatchObject({ muted: true, solo: true, locked: true });
  }
});
it('基础拍号与 BPM 保留，八分音符拍号不改变 MIDI 四分音符计时', () => {
  const result = importLightingReaper(source.replace('TEMPO 120', 'TEMPO 90 7 8'));
  expect(result.warnings).toEqual([]);
  expect(result.document.tempos).toEqual([{ beat: 0, bpm: 90, numerator: 7, denominator: 8 }]);
  const event = result.document.tracks[0]?.clips[0]?.events[0];
  expect(event?.kind).toBe('note');
  if (event?.kind !== 'note') throw new Error('Missing note');
  expect(event.duration).toBeCloseTo(4000 / 3, 8);
  expect(importLightingReaper(source.replace('TEMPO 120', 'TEMPO 120 3 4')).document.tempos[0]?.numerator).toBe(3);
  for (const invalid of ['TEMPO 120 3', 'TEMPO 120 0 4', 'TEMPO 120 7 3']) {
    expect(() => importLightingReaper(source.replace('TEMPO 120', invalid))).toThrow();
  }
});
