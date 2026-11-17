import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { addMa2SequenceCommand, newMa2TimelineCommand } from './ma2-new-timeline';
import { placeConsoleCue } from './lighting-cue-placement';
import { ma2SongPoints } from './ma2-song-sequence';
import { withMa2Pairings } from './ma2-pairing-state';
const project = () => parseLinkProject({ ...createEmptyLinkProject('新建测试'), rundown: [{ id: 'song', title: '歌曲', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 60000 } }] });
const destination = { name: '开场灯光', timecode: 9200, sequence: 9300, executor: '1000.108' };
it('首次添加整套 Cue 同时预留控台位置，保留编辑时间和点编号，一步可撤销', () => {
  const before = project();
  const lighting = [1300, 2750, 8100].reduce((value, ms, index) => placeConsoleCue(value, { sequence: 10, cue: `${index + 1}.000`, executor: '', name: `第 ${index + 1} 步` }, ms, 60000), createLightingDocument());
  const command = addMa2SequenceCommand('song', lighting, destination);
  const next = withMa2Pairings(command).execute(before);
  expect(next.rundown[0]?.lighting?.timelineDestination).toEqual(destination);
  expect(ma2SongPoints(next.rundown[0]!.lighting!)).toEqual(ma2SongPoints(lighting));
  expect(next.rundown[0]?.playback).toBeUndefined();
  expect(command.undo(before)).toEqual(before);
  expect(before.rundown[0]?.lighting).toBeUndefined();
  const again = addMa2SequenceCommand('song', next.rundown[0]!.lighting!, { ...destination, sequence: 9800 }).execute(next);
  expect(again.rundown[0]?.lighting).toEqual(next.rundown[0]?.lighting);
});
it('整套 Cue 避开工程内已经预留的位置，已指定的目标保持不变', () => {
  const before = newMa2TimelineCommand('song', destination, 120000).execute(project());
  before.rundown.push({ ...before.rundown[0]!, id: 'second', lighting: undefined, playback: undefined });
  const next = addMa2SequenceCommand('second', createLightingDocument(), destination).execute(before);
  expect(next.rundown[1]?.lighting?.timelineDestination).toEqual({ ...destination, sequence: 9301, timecode: 9201, executor: '1000.109' });
  const own = next.rundown[0]!.lighting!;
  expect(addMa2SequenceCommand('song', own, { ...destination, sequence: 9999 }).execute(next).rundown[0]?.lighting).toEqual(own);
});
it('新建保存固定目标和 MTC，空编排可撤销，配对过程不能吞掉新建意图', () => {
  const before = project();
  const command = newMa2TimelineCommand('song', destination, 120000);
  const next = withMa2Pairings(command).execute(before);
  expect(next.rundown[0]?.lighting?.timelineDestination).toEqual(destination);
  expect(next.rundown[0]?.lighting?.tracks).toHaveLength(1);
  expect(next.rundown[0]?.lighting?.tracks[0]?.clips[0]).toMatchObject({ name: destination.name, duration: 60000, events: [] });
  expect(next.rundown[0]?.playback?.mtcOffsetMs).toBe(120000);
  expect(command.undo(before)).toBe(before);
  expect(before.rundown[0]?.lighting).toBeUndefined();
});
it('拒绝同起始码和非法执行器；已预留位置自动顺延', () => {
  const first = newMa2TimelineCommand('song', destination, 120000).execute(project());
  first.rundown.push({ ...first.rundown[0]!, id: 'second', lighting: undefined });
  expect(() => newMa2TimelineCommand('second', { ...destination, timecode: 9400, sequence: 9500, executor: '1000.109' }, 120000).execute(first)).toThrow('起始码');
  expect(newMa2TimelineCommand('second', destination, 180000).execute(first).rundown[1]?.lighting?.timelineDestination).toEqual({ ...destination, timecode: 9201, sequence: 9301, executor: '1000.109' });
  expect(() => newMa2TimelineCommand('song', { ...destination, executor: '1000.241' }, 0)).toThrow();
});
