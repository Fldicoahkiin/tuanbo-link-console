import { expect, it } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { allocateSongMtcStart, MA2_SONG_TIMECODE_SLOT, nextMtcStartMs } from './mtc-start';

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
