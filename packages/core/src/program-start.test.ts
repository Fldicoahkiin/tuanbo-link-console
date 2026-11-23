import { expect, it } from 'vitest';
import { createEmptyLinkProject, linkCueSchema, type LinkProject } from '@tb/schema';
import { programStart } from './program-start';

function project(): LinkProject {
  const value = createEmptyLinkProject('开播');
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 10_000 },
    playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' } }];
  return value;
}
const options = { revision: 1, positionMs: undefined, sampleRate: 48_000 as const, mtcPortName: null, check: true };

it('没有灯光和画面工作的歌：发本曲起始码的时间码，画面只给一秒，没有提示', () => {
  expect(programStart(project(), 'song', options)).toMatchObject({ allowMtc: true, picture: 'optional', warnings: [], snapshot: { offsetMs: 480_000, positionMs: 0 } });
});

it('起始码无效时这首歌照常播放，只是不发时间码，提示写明原因且只写一次', () => {
  const value = project(); value.rundown[0]!.playback!.mtcOffsetMs = 86_395_000;
  const start = programStart(value, 'song', options);
  expect(start.allowMtc).toBe(false);
  expect(start.snapshot.offsetMs).toBe(0);
  expect(start.warnings).toEqual([expect.stringContaining('这次不发时间码')]);
});

it('要画面的歌等画面准备，失败也照常播放；同曲定位不再重复开播前检查', () => {
  const value = project();
  value.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
  expect(programStart(value, 'song', { ...options, positionMs: 3000, check: false })).toMatchObject({ picture: 'wait', allowMtc: true, warnings: [], snapshot: { positionMs: 3000 } });
});

it('间隔不足时保留音频并停用 MTC，达到实测间隔后恢复，向前和向后都检查', () => {
  const value = project(), first = value.rundown[0]!;
  const second = { ...first, id: 'next', title: '乙', playback: { ...first.playback!, mtcOffsetMs: 490_000 } };
  value.rundown.push(second);
  for (const id of ['song', 'next']) expect(programStart(value, id, options)).toMatchObject({ allowMtc: false, warnings: [expect.stringContaining('间隔不足 1 秒')] });
  second.playback.mtcOffsetMs += 1000;
  expect(programStart(value, 'song', options).allowMtc).toBe(true);
  expect(programStart(value, 'song', { ...options, deskRanges: { show: '台', afterRollSeconds: 1, entries: [] } }).allowMtc).toBe(false);
});
it('同槽区间已经交叠时也保护播放，含一首歌完全落入另一条时间线', () => {
  const value = project();
  const first = value.rundown[0]!;
  const second = { ...first, id: 'next', title: '乙', playback: { ...first.playback!, mtcOffsetMs: 489_900 } };
  value.rundown.push(second);
  for (const id of ['next', 'song']) expect(programStart(value, id, options)).toMatchObject({ allowMtc: false, warnings: [expect.stringContaining('时间范围重叠')] });
  second.playback.mtcOffsetMs = first.playback!.mtcOffsetMs;
  expect(programStart(value, 'next', options).allowMtc).toBe(true);
  value.rundown.pop();
  const row = { target: 2, offset: '14400', length: '300', last: '25', name: '甲', slot: 'TC Slot 2', frame: '30 FPS' };
  const deskRanges = { show: '现场', entries: [row, { ...row, target: 3, offset: '14490', length: '30' }] };
  deskRanges.entries[1]!.offset = 'unreadable';
  expect(programStart(value, 'song', { ...options, deskRanges })).toMatchObject({ allowMtc: false, warnings: [expect.stringContaining('Timecode 3 的时间范围没有读清')], snapshot: { itemId: 'song' } });
  deskRanges.entries[1]!.offset = '14400';
  expect(programStart(value, 'song', { ...options, deskRanges })).toMatchObject({ allowMtc: false });
  deskRanges.entries[1]!.offset = '14490';
  expect(programStart(value, 'song', { ...options, deskRanges })).toMatchObject({ allowMtc: false, warnings: [expect.stringContaining('Timecode 2 和 3 的时间范围重叠')] });
});

it('没有音频的歌没有东西可放，明确报错', () => {
  const value = project(); delete value.rundown[0]!.referenceAudio;
  expect(() => programStart(value, 'song', options)).toThrow('节目没有可播放的音频');
});
