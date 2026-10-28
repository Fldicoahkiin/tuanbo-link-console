import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2Catalog } from '@tb/schema';
import { reconcileMa2ReadState } from '@tb/core/link';
import { songMtcView } from './SongMtcStart';

function project() {
  const value = createEmptyLinkProject('MTC 起始码'); value.schemaVersion = 2;
  value.rundown = ['甲', '乙'].map(id => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 120_000 } }));
  return value;
}
const show = (target: number, offset: string): Ma2Catalog['entries'][number] => ({ target, name: `节目 ${target}`, eventCount: 1, frameFormat: '30 FPS', offset, slot: 'TC Slot 2',
  events: [{ path: '1', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: null }], error: null, warnings: [] });

it('每首歌显示 MTC 起始码；未分配时说明何时分配，重叠和控台节目起点不一致时提示原因', () => {
  const value = project(); value.timebase.frameRate = '30';
  const [first, second] = value.rundown as [typeof value.rundown[number], typeof value.rundown[number]];
  expect(songMtcView(value, first)).toMatchObject({ state: 'unset', text: 'MTC 未分配', detail: expect.stringContaining('开始编灯后') as string });
  first.lighting = createLightingDocument();
  expect(songMtcView(value, first).detail).toContain('连上控台后自动分配');
  expect(songMtcView(value, first, 'MA2 响应超时')).toEqual({ state: 'invalid', text: 'MTC 未分配', detail: '自动分配失败：MA2 响应超时' });
  first.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 810_000, shortcut: '' };
  expect(songMtcView(value, first)).toEqual({ state: 'set', text: 'MTC 00:13:30:00', detail: '本曲从 00:13:30:00 开始发送时间码；控台上没有从这个起点开始的时间码节目，播放不会跑灯' });
  // Every edit makes a new project object; statuses are cached per object.
  const own = structuredClone(value), ownSong = own.rundown[0]!;
  ownSong.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: 'Show', sequence: 9000, name: '甲', executor: '1000.101', layout: null, baselineXml: '<x/>', points: [], timecode: { number: 9000, offset: 810 * 30, slot: 'TC Slot 2', revision: 'b'.repeat(64) } };
  expect(songMtcView(own, ownSong)).toEqual({ state: 'matched', text: 'MTC 00:13:30:00 · Timecode 9000', detail: '本曲从 00:13:30:00 开始发送时间码；控台 Timecode 9000 从同一起点跑灯' });
  const moved = structuredClone(own); moved.rundown[0]!.lighting!.consoleSong!.timecode!.offset = 600 * 30;
  expect(songMtcView(moved, moved.rundown[0]!)).toMatchObject({ state: 'warning', detail: expect.stringContaining('控台 Timecode 9000 的起点还是 00:10:00:00，下次同步改成 00:13:30:00') as string });
  // Every edit makes a new project object; the overlap check is cached per object.
  const edited = structuredClone(value);
  edited.rundown[1]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 900_000, shortcut: '' };
  expect(songMtcView(value, second).state).toBe('unset');
  expect(songMtcView(edited, edited.rundown[1]!)).toMatchObject({ state: 'warning', text: 'MTC 00:15:00:00', detail: expect.stringContaining('和「甲」的 MTC 范围重叠') as string });
});

it('控台上有从同一起点开始的节目就是绿色（对上），没有就是灰色；两个节目起点相同时提示，不猜', () => {
  const value = project(); value.timebase.frameRate = '30';
  value.rundown[0]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' };
  value.rundown[1]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 700_000, shortcut: '' };
  const catalog: Ma2Catalog = { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-28T00:00:00.000Z', entries: [show(2, '14400')] };
  value.ma2ReadState = reconcileMa2ReadState(value, 'console', catalog);
  expect(songMtcView(value, value.rundown[0]!)).toEqual({ state: 'matched', text: 'MTC 00:08:00:00 · Timecode 2', detail: '本曲从 00:08:00:00 开始发送时间码；控台 Timecode 2 从同一起点跑灯' });
  expect(songMtcView(value, value.rundown[1]!).state).toBe('set');
  const twice = structuredClone(value); twice.ma2ReadState = reconcileMa2ReadState(twice, 'console', { ...catalog, entries: [show(2, '14400'), show(5, '14400')] });
  expect(songMtcView(twice, twice.rundown[0]!)).toMatchObject({ state: 'warning', detail: expect.stringContaining('Timecode 2、5 的起点都是 00:08:00:00') as string });
});
