import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { newMa2TimelineCommand } from './ma2-new-timeline';
import { withMa2Pairings } from './ma2-pairing-state';
const project = () => parseLinkProject({ ...createEmptyLinkProject('新建测试'), rundown: [{ id: 'song', title: '歌曲', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 60000 } }] });
const destination = { name: '开场灯光', timecode: 9200, sequence: 9300, executor: '1000.108' };
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
