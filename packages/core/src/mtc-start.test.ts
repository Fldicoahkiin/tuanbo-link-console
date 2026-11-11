import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { allocateMissingMtcStarts, allocateSongMtcStart, MA2_SONG_TIMECODE_SLOT, nextMtcStartMs, readSongMtcStart, setAllocatedMtcStartsCommand, songMtcOverlaps, songsNeedingMtcStart } from './mtc-start';

it('没有占用时从 60 秒开始；否则取最晚结束时间加 10 秒后的第一个整秒', () => {
  expect(nextMtcStartMs([], 30_000)).toBe(60_000);
  expect(nextMtcStartMs([{ startMs: 60_000, endMs: 90_000 }], 30_000)).toBe(100_000);
  expect(nextMtcStartMs([{ startMs: 60_000, endMs: 90_400 }, { startMs: 3_600_000, endMs: 3_700_000 }, { startMs: 100_000, endMs: 130_000 }], 30_000)).toBe(3_710_000);
});

it('超出上限或时长无效时报错，不截断', () => {
  expect(() => nextMtcStartMs([{ startMs: 0, endMs: 86_000_000 }], 600_000)).toThrow('超出 24 小时');
  expect(() => nextMtcStartMs([{ startMs: 0, endMs: 53_000_000 }], 1_000_000, 54_000_000)).toThrow('15 小时');
  expect(() => nextMtcStartMs([], 0)).toThrow('时长无效');
});

function project() {
  const value = createEmptyLinkProject('分配起点');
  value.rundown = ['新歌', '旧歌'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 120_000 },
    ...index ? { playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: 300_000, shortcut: '' } } : {} }));
  return value;
}
const show = (target: number, offset: number | string, length: string, last: string, { frame = '30 FPS', slot = MA2_SONG_TIMECODE_SLOT, name = `节目${target}` } = {}) => ({ target, name, offset: String(offset), length, slot, frame, last });

it('新歌排在控台节目和本工程已有歌曲之后；读不到长度时按最后事件加余量保守估计', () => {
  // 旧歌 300–420 s；控台节目 A：从 600 s 起长 6000 帧（200 s）到 800 s。
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(1, 18_000, '6000', '5940')] })).toBe(810_000);
  // 节目 B 没写长度，最后事件在 12000 帧（400 s），从 900 s 起：按 400 s + 30 s 余量算到 1330 s。
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(1, 18_000, '6000', '5940'), show(2, 27_000, '', '12000')] })).toBe(1_340_000);
  // 长度比最后事件短（控台没补长度）：同样以最后事件加余量为准。
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(3, 0, '17', '45')] })).toBe(430_000);
});

it('25 FPS 节目同样按 1/30 秒换算：控台对任何帧率都这样存 offset、长度和事件时间', () => {
  // 600 s 起长 200 s，与 30 FPS 的同样数值占同一段。
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(1, 18_000, '6000', '5940', { frame: '25 FPS' })] })).toBe(810_000);
});

it('其他 TC Slot 上的节目和没有事件的节目不占范围；Intern、Link Selected 等按本 Slot 计', () => {
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(1, 18_000, '6000', '5940', { slot: 'TC Slot 1' }), show(2, 27_000, '6000', '')] })).toBe(430_000);
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(3, 18_000, '6000', '5940', { slot: 'Link Selected' })] })).toBe(810_000);
});

it('本 Slot 上范围读不清的节目报错，列出编号和名称并说明处理办法；别的 Slot 上的不管；这首歌自己的旧起点不算占用', () => {
  expect(() => allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(4, 'x', '100', '30', { name: '开场灯光' })] }))
    .toThrow('控台 TC Slot 2 上这些时间码节目的时间范围读不清，未分配起点：Timecode 4「开场灯光」。请在控台上给它设长度、删除它，或把它换到别的 TC Slot，然后重新同步');
  expect(allocateSongMtcStart(project(), '新歌', { show: 'Show', entries: [show(4, 'x', '100', '30', { slot: 'TC Slot 1' })] })).toBe(430_000);
  const moved = project(); moved.rundown[0]!.playback = { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 3_000_000, shortcut: '' };
  expect(allocateSongMtcStart(moved, '新歌', { show: 'Show', entries: [] })).toBe(430_000);
});

it('读出每首歌的 MTC 起点：没设为未分配；两首歌的 MTC 范围重叠时互相列出', () => {
  const value = project();
  expect(readSongMtcStart(value.rundown[0]!)).toEqual({ state: 'unset' });
  expect(readSongMtcStart(value.rundown[1]!)).toEqual({ state: 'set', startMs: 300_000 });
  const p1Media = { sourceKey: 'a'.repeat(64), playlistId: 'list', sourceFileName: 'a.wav', playEndAction: 'stop' as const, volume: 100, muted: false, shortcut: '', midiStartTime: '1:2' };
  const invalid = readSongMtcStart({ p1Media });
  expect(invalid.state === 'invalid' && invalid.reason).toContain('1:2');
  expect(songMtcOverlaps(value).size).toBe(0);
  value.rundown[0]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 360_000, shortcut: '' };
  expect(Object.fromEntries([...songMtcOverlaps(value)].map(([id, others]) => [id, others.map(other => other.title)]))).toEqual({ 新歌: ['旧歌'], 旧歌: ['新歌'] });
  // Back to back is not an overlap: 旧歌 ends at 420 s.
  value.rundown[0]!.playback.mtcOffsetMs = 420_000;
  expect(songMtcOverlaps(value).size).toBe(0);
  // The same audio from the same start is one song on the console (the song in two playlists), not an overlap.
  value.rundown[0]!.playback.mtcOffsetMs = 300_000;
  expect(songMtcOverlaps(value).size).toBe(0);
  value.rundown[0]!.referenceAudio!.sha256 = 'b'.repeat(64);
  expect(songMtcOverlaps(value).get('新歌')).toEqual([{ id: '旧歌', title: '旧歌', playlistId: null }]);
});

it('连上控台给正在编灯、还没有 MTC 起点的歌依次分配，一次撤销；没编灯、已放进控台 Cue 或已有起点的歌不动', () => {
  const value = project(); value.schemaVersion = 2;
  const song = (id: string) => ({ ...structuredClone(value.rundown[0]!), id, title: id });
  value.rundown.push(song('第三首'), song('没编灯'), song('已放进 Cue'));
  for (const item of value.rundown) if (item.id !== '没编灯') item.lighting = createLightingDocument();
  value.rundown[4]!.lighting!.ma2Bindings = [{ id: 'binding', name: '控台节目', timecode: 7, readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs: 0 }];
  expect(songsNeedingMtcStart(value)).toEqual(['新歌', '第三首']);
  // 控台节目 600–800 s；旧歌 300–420 s。
  const starts = allocateMissingMtcStarts(value, { show: 'Show', entries: [show(1, 18_000, '6000', '5940')] });
  expect(Object.fromEntries(starts)).toEqual({ 新歌: 810_000, 第三首: 940_000 });
  const command = setAllocatedMtcStartsCommand(starts);
  const next = command.execute(value);
  expect(next.rundown.map(item => item.playback?.mtcOffsetMs)).toEqual([810_000, 300_000, 940_000, undefined, undefined]);
  expect(songsNeedingMtcStart(next)).toEqual([]);
  // Kept through undo: an earlier state of the project gets the same starts; a start set meanwhile is not replaced.
  expect(command.rebaseHistory).toBeDefined();
  const earlier = structuredClone(value); earlier.rundown[2]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 5_000_000, shortcut: '' };
  expect(command.rebaseHistory!(earlier).rundown.map(item => item.playback?.mtcOffsetMs)).toEqual([810_000, 300_000, 5_000_000, undefined, undefined]);
  expect(command.execute(next)).toBe(next);
  expect(() => setAllocatedMtcStartsCommand(new Map())).toThrow('没有需要');
  expect(() => allocateMissingMtcStarts(value, { show: 'Show', entries: [show(2, 'x', '', '10')] })).toThrow('读不清');
});
