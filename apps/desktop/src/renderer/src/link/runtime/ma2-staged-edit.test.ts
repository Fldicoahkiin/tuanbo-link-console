import { readFile } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog } from '@tb/schema';
import { importMa2TimecodeCommand, setLightingCommand } from '@tb/core/link';
import { convertMa2Snapshot, convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { Ma2AutoSync, type Ma2AutoSyncDependencies } from './ma2-auto-sync';
import { ma2PendingChanges, ma2UnboundTracks } from './ma2-pending-changes';
import { useDocumentStore } from '../stores/document-store';
import { lightingEditHandler } from '../components/lighting-edit-handler';

const xml = await readFile(new URL('../../../../main/link/fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('../../../../main/link/fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const sequenceObject = sequence.match(/<Sequ\s[\s\S]*<\/Sequ>/)![0];
const snapshot = (value: string): string => value.replace('</MA>', `${sequenceObject}</MA>`);
beforeEach(() => {
  const project = createEmptyLinkProject('安全暂存');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  useDocumentStore.getState().setProject(importMa2TimecodeCommand('song', convertMa2Timecode(xml, [sequence], 9902)).execute(project), null);
});

function setup() {
  let playing = true;
  let native = xml;
  const bridge = {
    request: vi.fn(() => Promise.resolve(snapshot(native))),
    exchange: vi.fn((_operation: string, _target: number, _expected: string, desired: string) => {
      native = desired;
      return Promise.resolve({ response: native, requestId: 'a'.repeat(32) });
    })
  };
  const service = new Ma2ApplyService(bridge, () => playing);
  const catalog: Ma2Catalog = { directory: { show: 'Test', generation: 'session', version: '3.3.4', entries: [] }, readAt: new Date().toISOString(), entries: [] };
  const dependencies: Ma2AutoSyncDependencies = {
    rename: () => Promise.reject(new Error('此测试不应改名')),
    prepare: vi.fn(() => Promise.reject(new Error('此测试不应创建关联'))),
    archive: vi.fn(() => Promise.resolve('saved.tblink')),
    state: () => ({ ...useDocumentStore.getState(), playing }),
    catalog: vi.fn(() => Promise.resolve(catalog)),
    read: vi.fn(() => Promise.resolve(convertMa2Snapshot(snapshot(native), 9902))),
    compare: vi.fn<Ma2AutoSyncDependencies['compare']>(request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map()))),
    apply: vi.fn<Ma2AutoSyncDependencies['apply']>(request => service.apply(request)),
    execute: vi.fn<Ma2AutoSyncDependencies['execute']>((id, command) => useDocumentStore.getState().executeForDocument(id, command)),
    changed: vi.fn()
  };
  const runner = new Ma2AutoSync(dependencies);
  playing = false; runner.start({ dataDirectory: 'test' }, catalog); playing = true;
  const edit = (at: number) => {
    const project = useDocumentStore.getState().project!;
    const document = structuredClone(project.rundown[0]!.lighting!);
    document.tracks[0]!.clips[0]!.events[0]!.at = at;
    const notify = vi.fn();
    lightingEditHandler({ itemId: 'song', project, notify })(document, '修改灯光位置');
    expect(notify).not.toHaveBeenCalled();
  };
  return { runner, dependencies, bridge, edit, stop: () => { playing = false; }, play: () => { playing = true; }, remote: (value: string) => { native = value; } };
}
const pending = () => ma2PendingChanges(useDocumentStore.getState().project);
const position = () => useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at;

it('播放中每次 Cue 编辑走命令，撤销重做即时更新待提交列表；多个周期无任何控台请求', async () => {
  const test = setup(); test.edit(1000); test.edit(1200);
  expect(useDocumentStore.getState().past).toHaveLength(2);
  expect(useDocumentStore.getState().past.at(-1)?.command.scope).toBe('lighting');
  expect(pending()[0]?.changes).toHaveLength(1);
  expect(pending()[0]?.changes[0]?.after?.properties.time).toBe('1200');
  useDocumentStore.getState().undo(); expect(position()).toBe(1000);
  useDocumentStore.getState().undo(); expect(pending()).toEqual([]);
  useDocumentStore.getState().redo(); expect(pending()[0]?.changes[0]?.after?.properties.time).toBe('1000');
  await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.catalog).not.toHaveBeenCalled(); expect(test.dependencies.read).not.toHaveBeenCalled();
  expect(test.dependencies.apply).not.toHaveBeenCalled(); expect(test.bridge.exchange).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('staged', expect.any(String));
});

it('停止后经过比较、写前快照与回读才清空待提交，回读更新基线但不增加撤销步骤', async () => {
  const test = setup(); test.edit(1000); await test.runner.tick(); test.stop();
  await test.runner.tick();
  expect(test.dependencies.compare).toHaveBeenCalledOnce();
  expect(test.bridge.request).toHaveBeenCalledTimes(2); expect(test.bridge.exchange).toHaveBeenCalledOnce();
  expect(test.dependencies.execute).toHaveBeenCalledOnce(); expect(pending()).toEqual([]);
  expect(useDocumentStore.getState().past).toHaveLength(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('verified', expect.any(String));
});

it('冲突保留本地暂存，后续停止和周期不会自动重试', async () => {
  const test = setup(); test.edit(1000); test.remote(xml.replace('<Event index="0"', '<Event time="15" index="0"')); test.stop();
  await test.runner.tick(); await test.runner.tick();
  expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(position()).toBe(1000); expect(pending()).toHaveLength(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('冲突'));
  expect(test.dependencies.read).toHaveBeenCalledOnce();
});

it('写前核对发现控台变动则拒绝写入并保留暂存', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.bridge.request.mockResolvedValue(snapshot(xml.replace('<Event index="0"', '<Event time="15" index="0"')));
  await test.runner.tick(); await test.runner.tick();
  expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('预览后已改变'));
});

it('回读失败或内容不一致不会清空暂存或重复写入', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.bridge.request.mockResolvedValue(snapshot(xml));
  await test.runner.tick(); await test.runner.tick();
  expect(test.bridge.exchange).toHaveBeenCalledOnce(); expect(test.dependencies.execute).not.toHaveBeenCalled();
  expect(pending()).toHaveLength(1); expect(position()).toBe(1000);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('可能已写入'));
});

it.each(['读取', '写入', '回读'] as const)('%s异常保留暂存，后续停止不自动重试', async stage => {
  const test = setup(); test.edit(1000); test.stop();
  if (stage === '读取') test.bridge.request.mockRejectedValueOnce(new Error('读取超时'));
  else if (stage === '写入') test.bridge.exchange.mockRejectedValueOnce(new Error('写入超时'));
  else test.bridge.request.mockResolvedValueOnce(snapshot(xml)).mockRejectedValueOnce(new Error('回读超时'));
  await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.apply).toHaveBeenCalledOnce(); expect(test.dependencies.execute).not.toHaveBeenCalled();
  expect(pending()).toHaveLength(1); expect(position()).toBe(1000);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining(`${stage}超时`));
});

it('已确认回读应用后关闭同步不会停留在写入中或误报全部成功', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const execute = test.dependencies.execute;
  test.dependencies.execute = async (id, command) => { await execute(id, command); test.runner.stop(); };
  await test.runner.tick();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('off', expect.any(String));
  expect(pending()).toEqual([]);
});

it('比较期间关闭同步，中断后不发写入且保留暂存', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const compare = test.dependencies.compare;
  test.dependencies.compare = async request => { test.runner.stop(); return compare(request); };
  await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.apply).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('off', expect.any(String));
});

it('读取中恢复播放取消本轮写入，再次停止必须重新读取', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const read = test.dependencies.read;
  test.dependencies.read = async request => { const result = await read(request); test.play(); return result; };
  await test.runner.tick(); expect(test.dependencies.apply).not.toHaveBeenCalled();
  test.dependencies.read = read; test.stop(); await test.runner.tick();
  expect(read).toHaveBeenCalledTimes(2); expect(test.bridge.exchange).toHaveBeenCalledOnce();
});

it('写入期间继续编辑保留最新位置，下一轮继续写入；撤销仍形成反向修改', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args); test.edit(1400); return result;
  });
  await test.runner.tick();
  expect(position()).toBe(1400); expect(pending()).toHaveLength(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('staged', expect.any(String));
  await test.runner.tick();
  expect(position()).toBe(1400); expect(pending()).toEqual([]);
  expect(test.bridge.exchange).toHaveBeenCalledTimes(2);
  useDocumentStore.getState().undo(); expect(position()).toBe(1000);
  await test.runner.tick(); expect(pending()).toEqual([]);
});

it('写入中关闭开关仍核对已发出的修改，不再发送下一笔', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args); test.runner.stop(); test.edit(1400); return result;
  });
  await test.runner.tick(); await test.runner.tick();
  expect(position()).toBe(1400); expect(pending()).toHaveLength(1);
  expect(test.bridge.exchange).toHaveBeenCalledOnce();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('off', expect.any(String));
});

it('写入中切换工程不把旧回读应用到新工程', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args);
    useDocumentStore.getState().setProject(createEmptyLinkProject('其他工程'), null); return result;
  });
  await test.runner.tick();
  expect(test.dependencies.execute).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('请手动回读确认'));
});

it('保存重开仍可从基线恢复暂存；新增、删除均显示', () => {
  const test = setup(); test.edit(1000);
  useDocumentStore.getState().setProject(structuredClone(useDocumentStore.getState().project!), null);
  expect(pending()).toHaveLength(1);
  const document = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
  const events = document.tracks[0]!.clips[0]!.events;
  const event = events.shift()!; events.push({ ...event, id: 'added', at: 1100 });
  useDocumentStore.getState().execute(setLightingCommand('song', document));
  expect(pending()[0]?.changes).toHaveLength(2);
  expect(pending()[0]?.changes.some(change => change.before === null)).toBe(true);
  expect(pending()[0]?.changes.some(change => change.after === null)).toBe(true);
});

it('本地 Cue 备注与未绑定轨道不伪装成控台待写入内容', () => {
  const document = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
  const event = document.tracks[0]!.clips[0]!.events[0]!;
  if (event.kind !== 'ma2') throw new Error('缺少 Cue');
  event.label = '本地排练备注';
  document.tracks.push({ ...structuredClone(document.tracks[0]!), id: 'unbound', clips: [] });
  useDocumentStore.getState().execute(setLightingCommand('song', document));
  expect(pending()).toEqual([]);
});

it('控台确认后一次撤销就反向同步，重做仍使用最新基线', async () => {
  const test = setup(); const original = position(); test.edit(1000); test.stop();
  await test.runner.tick(); expect(pending()).toEqual([]);
  useDocumentStore.getState().undo(); expect(position()).toBe(original); expect(pending()).toHaveLength(1);
  await test.runner.tick(); expect(pending()).toEqual([]);
  expect(useDocumentStore.getState().future).toHaveLength(1);
  useDocumentStore.getState().redo(); expect(position()).toBe(1000);
  await test.runner.tick(); expect(pending()).toEqual([]);
  useDocumentStore.getState().undo(); expect(position()).toBe(original);
  await test.runner.tick(); expect(pending()).toEqual([]);
  expect(test.bridge.exchange).toHaveBeenCalledTimes(4);
  expect(test.dependencies.archive).toHaveBeenCalledTimes(4);
});
it('未关联的序列池 Cue 单独列出，空点位不伪装成控台动作', () => {
  const project = structuredClone(useDocumentStore.getState().project!);
  const document = project.rundown[0]!.lighting!;
  const track = structuredClone(document.tracks[0]!); track.id = 'unbound';
  track.clips = track.clips.map(clip => ({ ...clip, id: `unbound-${clip.id}`, events: clip.events.map(event => event.kind === 'ma2' ? { ...event, executor: '' } : event) }));
  document.tracks.push(track);
  const unbound = ma2UnboundTracks(project);
  expect(unbound).toHaveLength(1);
  expect(unbound[0]).toMatchObject({ trackId: 'unbound', count: 2 });
  expect(unbound[0]?.reason).toContain('自动准备控台执行位置');
  track.clips[0]!.events = [{ id: 'empty', kind: 'empty-cue', label: '空点位', at: 0 }];
  expect(ma2UnboundTracks(project)).toEqual([]);
});

it('写入中撤销不会被旧回读覆盖，下一笔写回撤销后的内容', async () => {
  const test = setup(); const original = position(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args); useDocumentStore.getState().undo(); return result;
  });
  await test.runner.tick(); expect(position()).toBe(original); expect(pending()).toHaveLength(1);
  await test.runner.tick(); expect(position()).toBe(original); expect(pending()).toEqual([]);
  expect(useDocumentStore.getState().future).toHaveLength(1);
  await test.runner.tick(); expect(test.dependencies.changed).toHaveBeenLastCalledWith('verified', expect.stringContaining('回读确认'));
});
it('存档失败阻止写入，并保留本地修改且不重试', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.dependencies.archive = vi.fn(() => Promise.reject(new Error('磁盘无法保存存档')));
  await test.runner.tick(); await test.runner.tick();
  expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('存档'));
});
