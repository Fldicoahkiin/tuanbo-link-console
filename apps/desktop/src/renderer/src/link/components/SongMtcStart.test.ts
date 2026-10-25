import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { songMtcView } from './SongMtcStart';

function project() {
  const value = createEmptyLinkProject('MTC 起始码'); value.schemaVersion = 2;
  value.rundown = ['甲', '乙'].map(id => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 120_000 } }));
  return value;
}

it('每首歌显示 MTC 起始码；未分配时说明何时分配，重叠和控台节目起点不一致时提示原因', () => {
  const value = project(); value.timebase.frameRate = '30';
  const [first, second] = value.rundown as [typeof value.rundown[number], typeof value.rundown[number]];
  expect(songMtcView(value, first)).toMatchObject({ state: 'unset', text: 'MTC 未分配', detail: expect.stringContaining('开始编灯后') as string });
  first.lighting = createLightingDocument();
  expect(songMtcView(value, first).detail).toContain('连上控台后自动分配');
  expect(songMtcView(value, first, 'MA2 响应超时')).toEqual({ state: 'invalid', text: 'MTC 未分配', detail: '自动分配失败：MA2 响应超时' });
  first.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 810_000, shortcut: '' };
  expect(songMtcView(value, first)).toEqual({ state: 'set', text: 'MTC 00:13:30:00', detail: '本曲从 00:13:30:00 开始发送时间码' });
  first.lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: 'Show', sequence: 9000, name: '甲', executor: '1000.101', layout: null, baselineXml: '<x/>', points: [], timecode: { number: 9000, offset: 810 * 30, slot: 'TC Slot 2', revision: 'b'.repeat(64) } };
  expect(songMtcView(value, first).detail).toContain('控台 Timecode 9000（TC Slot 2）从同一起点跑灯');
  first.lighting.consoleSong.timecode!.offset = 600 * 30;
  expect(songMtcView(value, first)).toMatchObject({ state: 'warning', detail: '控台 Timecode 9000 的起点还是 00:10:00:00，下次同步改成 00:13:30:00' });
  // Every edit makes a new project object; the overlap check is cached per object.
  const edited = structuredClone(value);
  edited.rundown[1]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 900_000, shortcut: '' };
  expect(songMtcView(value, second).state).toBe('unset');
  expect(songMtcView(edited, edited.rundown[1]!)).toMatchObject({ state: 'warning', text: 'MTC 00:15:00:00', detail: expect.stringContaining('和「甲」的 MTC 范围重叠') as string });
});
