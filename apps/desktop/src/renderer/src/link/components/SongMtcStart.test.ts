import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type Ma2Catalog } from '@tb/schema';
import { reconcileMa2ReadState, setItemPlaybackCommand } from '@tb/core/link';
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

// 2026-11-11 field report: drop.mp4 copied into a second playlist (two rundown items) warned that it overlapped
// 「drop.mp4」, and the warning seemed to stay after the start was changed.
function playlists() {
  const value = createEmptyLinkProject('两个播放列表'); value.timebase.frameRate = '30';
  value.playlists = [{ id: 'warm', name: '暖场' }, { id: 'show', name: '正式演出' }];
  const song = (id: string, title: string, playlistId: string, sha: string, startMs: number) => ({
    id, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], playlistId,
    referenceAudio: { assetId: `${id}-asset`, relativePath: `${id}.wav`, sha256: sha.repeat(64), durationMs: 120_000 },
    playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: startMs, shortcut: '' } });
  value.rundown = [song('drop', 'drop.mp4', 'warm', 'a', 18_000_000), song('copy', 'drop.mp4', 'show', 'a', 18_000_000)];
  return value;
}
const detail = (value: ReturnType<typeof playlists>, id: string): string => songMtcView(value, value.rundown.find(item => item.id === id)!).detail;

it('同一段音频从同一个起点开始，是控台上的同一首歌，放在两个播放列表里不算重叠', () => {
  const value = playlists();
  expect(detail(value, 'drop')).not.toContain('重叠');
  expect(detail(value, 'copy')).not.toContain('重叠');
  // A different file from the same start is a real overlap.
  const other = structuredClone(value); other.rundown[1]!.referenceAudio!.sha256 = 'b'.repeat(64);
  expect(detail(other, 'drop')).toContain('和播放列表「正式演出」里的「drop.mp4」的 MTC 范围重叠');
  // The same audio from a start inside the song is a real overlap too.
  const later = structuredClone(value); later.rundown[1]!.playback!.mtcOffsetMs = 18_060_000;
  expect(detail(later, 'copy')).toContain('和播放列表「暖场」里的「drop.mp4」的 MTC 范围重叠');
});

it('重叠的歌和这首同名或在别的播放列表时，写出它在哪个播放列表；同一个列表里不同名的只写歌名', () => {
  const value = playlists();
  const first = value.rundown[0]!;
  value.rundown.push({ ...structuredClone(first), id: 'jia', title: '甲', referenceAudio: { ...first.referenceAudio!, sha256: 'c'.repeat(64) }, playback: { ...first.playback!, mtcOffsetMs: 18_030_000 } });
  value.rundown.push({ ...structuredClone(first), id: 'loose', title: '乙', playlistId: null, referenceAudio: { ...first.referenceAudio!, sha256: 'd'.repeat(64) }, playback: { ...first.playback!, mtcOffsetMs: 18_090_000 } });
  expect(detail(value, 'drop')).toContain('和「甲」、未分组里的「乙」的 MTC 范围重叠');
  expect(detail(value, 'copy')).toContain('和播放列表「暖场」里的「甲」、未分组里的「乙」的 MTC 范围重叠');
  expect(detail(value, 'jia')).toContain('和「drop.mp4」、播放列表「正式演出」里的「drop.mp4」、未分组里的「乙」的 MTC 范围重叠');
});

it('改了任意一首的起点，两首歌的重叠提示都跟着重新算', () => {
  const value = playlists(); value.rundown[1]!.referenceAudio!.sha256 = 'b'.repeat(64);
  expect(detail(value, 'drop')).toContain('重叠'); expect(detail(value, 'copy')).toContain('重叠');
  const playback = value.rundown[1]!.playback!;
  const movedCopy = setItemPlaybackCommand('copy', { ...playback, mtcOffsetMs: 18_300_000 }).execute(parseLinkProject(value));
  expect(detail(movedCopy, 'drop')).not.toContain('重叠'); expect(detail(movedCopy, 'copy')).not.toContain('重叠');
  const back = setItemPlaybackCommand('drop', { ...playback, mtcOffsetMs: 18_250_000 }).execute(movedCopy);
  expect(detail(back, 'drop')).toContain('重叠'); expect(detail(back, 'copy')).toContain('重叠');
  // The older project keeps its own answer: the per-project cache never mixes versions.
  expect(detail(movedCopy, 'copy')).not.toContain('重叠');
});
