import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2ObjectDirectory } from '@tb/schema';
import { applyMa2AutoBindingsCommand, ma2AutoBindEvents, setLightingCommand } from '@tb/core/link';
import { prepareMa2AutoBindings } from './ma2-auto-bind-service';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from './ma2-event-write';
import type { Ma2Operation } from './ma2-onpc-bridge';

const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const executor = await readFile(new URL('./fixtures/ma2-executor-3.3.xml', import.meta.url), 'utf8');
function fixture() {
  const document = convertMa2Timecode(xml, [sequence], 9902).document;
  for (const event of document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))) if (event.kind === 'ma2') event.executor = '';
  const directory: Ma2ObjectDirectory = { show: 'Dedicated test', version: '3.3.4', generation: 'session', entries: [] };
  let created = '';
  const bridge = { request: vi.fn((op: Ma2Operation, target: number, _body?: string, desired?: string) => {
    switch (op) {
      case 'LIST': return Promise.resolve(JSON.stringify(directory));
      case 'PING': return Promise.resolve('3.3.4');
      case 'CREATE': created = desired!; return Promise.resolve(created);
      case 'ASSIGNSEQ': return Promise.resolve(JSON.stringify({ sequence: target, executor: '999.101' }));
      case 'EXECUTOR': return Promise.resolve(executor.replace('<Exec ', '<Exec tblink_executor_name="Test sequence" '));
      default: throw new Error(`Unexpected ${op}`);
    }
  }) };
  const request = { dataDirectory: 'D:/ma', projectId: 'test-project', itemId: 'song', document, expectedSource: { show: directory.show, version: directory.version, generation: directory.generation } };
  return { document, directory, bridge, request, created: () => created };
}
it('序列池 Cue 从无绑定开始自动创建时间线、去重关联，保留小数编号并写回', async () => {
  const f = fixture();
  const plan = await prepareMa2AutoBindings(f.bridge, f.request, () => false);
  expect(f.bridge.request.mock.calls.filter(([op]) => op === 'ASSIGNSEQ')).toHaveLength(1);
  const project = createEmptyLinkProject('自动同步'); project.schemaVersion = 2;
  project.rundown.push({ id: 'song', title: 'song', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting: f.document });
  const resolved = applyMa2AutoBindingsCommand('song', f.document, plan.plan).execute(project).rundown[0]!.lighting!;
  expect(ma2AutoBindEvents(resolved)).toEqual([]);
  expect(resolved.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toMatchObject(f.document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).map(event => ({ ...event, executor: '999.101' })));
  const preview = convertMa2Timecode(f.created(), [], plan.plan.newBinding!.timecode);
  const write = prepareMa2MergedEvents(resolved, plan.plan.bindingId, preview, new Map(), new Map(), [sequence]);
  const confirmed = confirmMa2MergedEvents(write, write.desiredXml, [sequence]);
  expect(confirmed.mappings).toHaveLength(2);
  expect(confirmed.document.tracks[0]!.clips[0]!.events).toMatchObject([{ cue: '1.250', executor: '999.101' }, { cue: '7.500', executor: '999.101' }]);
});
it('Show 不符和播放中不会创建或分配对象', async () => {
  const f = fixture();
  await expect(prepareMa2AutoBindings(f.bridge, f.request, () => true)).rejects.toThrow('播放中');
  expect(f.bridge.request).not.toHaveBeenCalled();
  f.request.expectedSource.show = 'Other';
  await expect(prepareMa2AutoBindings(f.bridge, f.request, () => false)).rejects.toThrow('Show');
  expect(f.bridge.request.mock.calls.map(([op]) => op)).toEqual(['LIST']);
});
it('多个执行目标拆分后组合与节拍锚点不变，关联不会增加撤销步骤', async () => {
  const f = fixture();
  const first = f.document.tracks[0]!.clips[0]!.events[0]!;
  const second = f.document.tracks[0]!.clips[0]!.events[1]!;
  if (first.kind !== 'ma2' || second.kind !== 'ma2') throw new Error('fixture');
  first.effectGroupId = second.effectGroupId = 'combination';
  second.executor = '99.219';
  const project = createEmptyLinkProject('history'); project.schemaVersion = 2;
  const empty = structuredClone(f.document); empty.tracks = [];
  project.rundown.push({ id: 'song', title: 'song', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting: empty });
  const edit = setLightingCommand('song', f.document);
  const edited = edit.execute(project);
  const prepared = await prepareMa2AutoBindings(f.bridge, f.request, () => false);
  const association = applyMa2AutoBindingsCommand('song', f.document, prepared.plan);
  expect(association.historyRebaseKey).toBeTruthy();
  const result = association.execute(edited).rundown[0]!.lighting!;
  expect(result.tracks).toHaveLength(2);
  expect(result.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).map(event => event.effectGroupId)).toEqual(['combination', 'combination']);
  const before = association.rebaseHistory!(project);
  const undone = association.rebaseHistory!(edit.undo(before));
  expect(undone.rundown[0]!.lighting!.tracks).toHaveLength(0);
  expect(association.rebaseHistory!(edit.execute(undone)).rundown[0]!.lighting!.tracks).toEqual(result.tracks);
});
it('删除或更换目的轨道通过原位置删除和新位置添加，回读保持事件身份', () => {
  const preview = convertMa2Timecode(xml, [sequence], 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'binding', timecode: 9902, name: preview.name, sourceXml: xml, readAt: preview.readAt, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings }];
  const moving = document.tracks[0]!.clips[0]!.events.pop()!;
  if (moving.kind !== 'ma2') throw new Error('fixture'); moving.executor = '999.101';
  document.tracks.push({ ...structuredClone(document.tracks[0]!), id: 'destination', clips: [{ ...structuredClone(document.tracks[0]!.clips[0]!), id: 'destination-clip', events: [moving] }] });
  document.ma2Bindings[0]!.pendingTracks = [{ trackId: 'destination', executor: '999.101', executorName: 'Other executor' }];
  const write = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
  const confirmed = confirmMa2MergedEvents(write, write.desiredXml, [sequence]);
  expect(confirmed.document.tracks[1]!.clips[0]!.events[0]).toMatchObject({ id: moving.id, executor: '999.101', cue: moving.cue });
});
