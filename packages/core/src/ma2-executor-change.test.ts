import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { applyMa2ExecutorChangeCommand, ma2ExecutorDeletionUses } from './ma2-executor-change';

function sample() {
  const project = createEmptyLinkProject('执行器位置');
  const light = createLightingDocument();
  light.outputMode = 'network';
  light.consoleSong = { endpoint: '192.0.2.1:30000', show: 'Show', layout: null, executor: '1000.101', sequence: 9000, name: '本曲', baselineXml: '<MA/>', points: [{ id: 'a', cue: '1' }] };
  light.tracks = [{ id: 't', kind: 'ma2', name: '灯光', color: '#aabbcc', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [
    { id: 'c', name: '灯光', start: 0, duration: 1000, timeLock: 'time', muted: false, events: [
      { id: 'a', kind: 'ma2', at: 0, action: 'goto', executor: '1000.101', sequence: 9000, cue: '1', label: '本曲' },
      { id: 'b', kind: 'ma2', at: 500, action: 'goto', executor: '1000.102', sequence: 9000, cue: '1', label: '同序列其他格' }
    ] }
  ] }];
  project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-20T00:00:00.000Z', sequences: [], fixtureUsage: [], errors: [] } };
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, cues: [], notes: '', visualLayers: [], referenceMediaClips: [], lighting: light }];
  return project;
}
it('移动更新确切地址、保留同序列其他执行器，并能重基历史', () => {
  const before = sample();
  const command = applyMa2ExecutorChangeCommand('192.0.2.1:30000', 'Show', 9000, '1000.101', '1001.1');
  const moved = command.execute(before).rundown[0]!.lighting!;
  expect(moved.consoleSong).toMatchObject({ executor: '1001.1', assignment: 'assigned' });
  expect(moved.tracks[0]!.clips[0]!.events).toMatchObject([{ executor: '1001.1' }, { executor: '1000.102' }]);
  expect(command.rebaseHistory?.(before).rundown[0]!.lighting?.consoleSong?.executor).toBe('1001.1');
  expect(before.rundown[0]!.lighting?.consoleSong?.executor).toBe('1000.101');
});
it('删分配保留序列及时间线内容，记录解除状态防止后台重新创建', () => {
  const project = sample();
  const after = applyMa2ExecutorChangeCommand('192.0.2.1:30000', 'Show', 9000, '1000.101', null).execute(project);
  expect(after.rundown[0]!.lighting?.consoleSong).toMatchObject({ sequence: 9000, executor: '1000.101', assignment: 'unassigned' });
  expect(after.rundown[0]!.lighting?.tracks[0]?.clips[0]?.events[0]).toMatchObject({ sequence: 9000, cue: '1', executor: '' });
});
it('另一控台或 Show 的位置更新不能改当前工程', () => {
  const project = sample();
  expect(applyMa2ExecutorChangeCommand('other:30000', 'Show', 9000, '1000.101', null).execute(project)).toBe(project);
  expect(applyMa2ExecutorChangeCommand('192.0.2.1:30000', 'Other', 9000, '1000.101', null).execute(project)).toBe(project);
});
it('删除清单明确识别无法转成序列引用的执行器专用动作', () => {
  const project = sample();
  project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.push({ id: 'f', kind: 'ma2-fader', at: 250, executor: '1000.101', fader: 'Master', level: 1, label: '亮度' });
  expect(ma2ExecutorDeletionUses(project, '1000.101')).toEqual(['歌曲：含执行器专用动作，请先重新指定这些动作的目标']);
  expect(ma2ExecutorDeletionUses(project, '1000.102')).toEqual([]);
});
