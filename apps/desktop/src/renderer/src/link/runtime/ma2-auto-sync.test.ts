import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog } from '@tb/schema';
import { importMa2TimecodeCommand } from '@tb/core/link';
import { convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2AutoSync, type Ma2AutoSyncDependencies } from './ma2-auto-sync';
import { Ma2OnpcBridge } from '../../../../main/link/ma2-onpc-bridge';
import { readMa2Catalog } from '../../../../main/link/ma2-catalog';
import { convertMa2Snapshot } from '../../../../main/link/ma2-timecode-conversion';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { inspectMa2TimecodeXml, patchMa2EventTimes, sameMa2XmlObjects } from '../../../../main/link/ma2-timecode-xml';
import { createMa2TimecodeXml } from '../../../../main/link/ma2-create';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from '../../../../main/link/ma2-event-write';

const xml = await readFile(new URL('../../../../main/link/fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('../../../../main/link/fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
function setup() {
  const preview = convertMa2Timecode(xml, [sequence], 9902);
  let project = createEmptyLinkProject('同步测试');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  project = importMa2TimecodeCommand('song', preview).execute(project);
  let playing = false;
  const catalog: Ma2Catalog = { directory: { show: 'Test', generation: 'session', version: '3.3.4', entries: [] }, readAt: new Date().toISOString(), entries: [] };
  const dependencies: Ma2AutoSyncDependencies = {
    rename: () => Promise.reject(new Error('此测试不应改名')),
    prepare: vi.fn(() => Promise.reject(new Error('此测试不应创建关联'))),
    archive: vi.fn(() => Promise.resolve('saved.tblink')),
    state: () => ({ project, documentId: 1, playing }),
    catalog: vi.fn(() => Promise.resolve(catalog)), read: vi.fn(() => Promise.resolve(preview)),
    compare: vi.fn<Ma2AutoSyncDependencies['compare']>(request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map(request.choices)))),
    apply: vi.fn<Ma2AutoSyncDependencies['apply']>(() => Promise.resolve({ status: 'incomplete', stage: 'write', message: '写入结果未知', mayHaveWritten: true, backupFile: 'backup.xml' })),
    execute: vi.fn<Ma2AutoSyncDependencies['execute']>((_id, command) => { project = command.execute(project); }), changed: vi.fn()
  };
  const runner = new Ma2AutoSync(dependencies);
  runner.start({ dataDirectory: 'test' }, catalog);
  const edit = () => { project = structuredClone(project); project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at = 1000; };
  return { runner, dependencies, catalog, edit, play: () => { playing = true; } };
}

it('未修改的周期不写控台，也不制造撤销历史', async () => {
  const test = setup(); await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.apply).not.toHaveBeenCalled(); expect(test.dependencies.execute).not.toHaveBeenCalled();
  expect(test.dependencies.catalog).not.toHaveBeenCalled(); expect(test.dependencies.read).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('waiting', expect.any(String));
});
it('无任何绑定的序列池 Cue 自动准备并写回，首次同步后不重复创建', async () => {
  const test = setup();
  const document = test.dependencies.state().project!.rundown[0]!.lighting!;
  delete document.ma2Bindings;
  document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).forEach(event => { if (event.kind === 'ma2') event.executor = ''; });
  let preview = convertMa2Timecode(createMa2TimecodeXml(9999, 'Managed', '3.3.4'), [], 9999);
  test.dependencies.prepare = vi.fn(() => Promise.resolve({ directory: test.catalog.directory, plan: { bindingId: 'managed', newBinding: {
    id: 'managed', timecode: 9999, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, baselineTracks: [], mappings: [], trackMappings: [] },
    assignments: [{ sequence: 9901, executor: '999.101', executorName: 'Managed executor', pool: true }] } }));
  test.dependencies.read = vi.fn(() => Promise.resolve(preview));
  test.dependencies.apply = vi.fn<Ma2AutoSyncDependencies['apply']>(request => {
    const prepared = prepareMa2MergedEvents(request.document, request.bindingId, request.readback, new Map(), new Map(), [sequence]);
    preview = confirmMa2MergedEvents(prepared, prepared.desiredXml, [sequence]);
    return Promise.resolve({ status: 'verified' as const, confirmed: preview, backupFile: 'backup.xml' });
  });
  await test.runner.tick();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('verified', expect.any(String));
  expect(preview.mappings).toHaveLength(2);
  await test.runner.tick();
  expect(test.dependencies.prepare).toHaveBeenCalledTimes(1); expect(test.dependencies.apply).toHaveBeenCalledTimes(1);
  expect(test.dependencies.archive).toHaveBeenCalledTimes(1);
});
it('bound 模式保留已有时间线同步，不为未绑定歌曲创建隐式 Timecode', async () => {
  const test = setup();
  delete test.dependencies.state().project!.rundown[0]!.lighting!.ma2Bindings;
  test.runner.start({ dataDirectory: 'test' }, test.catalog, 'bound');
  await test.runner.tick(); await test.runner.tick(true);
  expect(test.dependencies.prepare).not.toHaveBeenCalled();
  expect(test.dependencies.apply).not.toHaveBeenCalled();
});
it('自动准备在途时关闭开关，保留已确认关联但不继续写 Cue', async () => {
  const test = setup();
  const document = test.dependencies.state().project!.rundown[0]!.lighting!;
  const binding = document.ma2Bindings![0]!;
  document.tracks[0]!.clips[0]!.events.forEach(event => { if (event.kind === 'ma2') event.executor = ''; });
  let finish: ((value: Awaited<ReturnType<Ma2AutoSyncDependencies['prepare']>>) => void) | undefined;
  test.dependencies.prepare = vi.fn<Ma2AutoSyncDependencies['prepare']>(() => new Promise(resolve => { finish = resolve; }));
  const task = test.runner.tick();
  await vi.waitFor(() => expect(test.dependencies.prepare).toHaveBeenCalledOnce());
  test.runner.stop();
  finish!({ directory: test.catalog.directory, plan: { bindingId: binding.id, assignments: [{ sequence: 9901, executor: '99.219', executorName: 'Existing', pool: true }] } });
  await task;
  expect(test.dependencies.apply).not.toHaveBeenCalled();
  expect(test.dependencies.execute).toHaveBeenCalledOnce();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('off', expect.any(String));
});
it('写入不确定时锁住后续周期，不自动重试', async () => {
  const test = setup(); test.edit(); await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.apply).toHaveBeenCalledTimes(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('backup.xml'));
});
it('写入失败后重新启用，同一份本地内容不再重复存档；再编辑才存新档', async () => {
  const test = setup(); test.edit(); await test.runner.tick();
  test.runner.start({ dataDirectory: 'test' }, test.catalog); await test.runner.tick();
  expect(test.dependencies.apply).toHaveBeenCalledTimes(2); expect(test.dependencies.archive).toHaveBeenCalledTimes(1);
  test.edit(); test.runner.start({ dataDirectory: 'test' }, test.catalog); await test.runner.tick();
  expect(test.dependencies.archive).toHaveBeenCalledTimes(2);
});
it('播放期间不读取或写入', async () => {
  const test = setup(); test.edit(); test.play(); await test.runner.tick();
  expect(test.dependencies.read).not.toHaveBeenCalled(); expect(test.dependencies.apply).not.toHaveBeenCalled();
});
it('播放中连接可建立编辑会话，但等待停止后才写回', async () => {
  const test = setup(); test.play(); test.edit();
  expect(() => test.runner.start({ dataDirectory: 'test' }, test.catalog)).not.toThrow();
  await test.runner.tick();
  expect(test.dependencies.catalog).not.toHaveBeenCalled(); expect(test.dependencies.apply).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('staged', expect.any(String));
});
it('歌曲配对失效后禁止将本地拖动写回控台', async () => {
  const test = setup(); test.edit();
  const project = test.dependencies.state().project!;
  project.ma2ReadState = { source: 'test', catalog: test.catalog, pairs: {}, pairings: { '9902': { itemId: 'song', status: 'stale', evidence: '', reason: '起点已变化' } }, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' };
  await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.catalog).not.toHaveBeenCalled(); expect(test.dependencies.apply).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('配对已失效'));
});
it('音源或长度变化的既有绑定起点未变时，仍先核对三方基线再同步', async () => {
  const test = setup(); test.edit();
  const project = test.dependencies.state().project!;
  project.rundown[0]!.referenceAudio = { assetId: 'audio', relativePath: 'audio.wav', sha256: 'a'.repeat(64), durationMs: 33000 };
  project.rundown[0]!.playback = { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' };
  project.ma2ReadState = { source: 'test', catalog: test.catalog, pairs: {}, pairings: { '9902': { itemId: 'song', status: 'stale', evidence: '', reason: '音源已变化' } }, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' };
  await test.runner.tick();
  expect(test.dependencies.read).toHaveBeenCalledOnce(); expect(test.dependencies.compare).toHaveBeenCalledOnce(); expect(test.dependencies.apply).toHaveBeenCalledOnce();
  test.dependencies.read = vi.fn(); test.dependencies.apply = vi.fn();
  project.rundown[0]!.playback.mtcOffsetMs = 3600000;
  test.runner.start({ dataDirectory: 'test' }, test.catalog); await test.runner.tick();
  expect(test.dependencies.read).not.toHaveBeenCalled(); expect(test.dependencies.apply).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('配对已失效'));
});
it('关闭自动同步不能提前释放已经发送的写入锁', async () => {
  const test = setup(); test.edit();
  let rejectWrite: ((reason: Error) => void) | undefined;
  test.dependencies.apply = vi.fn<Ma2AutoSyncDependencies['apply']>(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
  const operation = test.runner.tick();
  await vi.waitFor(() => expect(test.dependencies.apply).toHaveBeenCalledOnce());
  test.runner.stop(); expect(test.dependencies.changed).toHaveBeenLastCalledWith('writing', expect.any(String));
  if (!rejectWrite) throw new Error('写入尚未开始');
  rejectWrite(new Error('写入超时')); await operation;
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', '写入超时');
  await test.runner.tick(); expect(test.dependencies.apply).toHaveBeenCalledOnce();
});
it('换 Show 后停止，后续周期不继续读写', async () => {
  const test = setup(); test.edit(); test.catalog.directory.show = 'Other'; await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.catalog).toHaveBeenCalledTimes(1); expect(test.dependencies.read).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('Show'));
});
it('双方冲突先阻断，不发送写入', async () => {
  const test = setup(); test.edit();
  const remote = convertMa2Timecode(xml.replace('<Event index="0"', '<Event time="15" index="0"'), [sequence], 9902);
  test.dependencies.read = vi.fn(() => Promise.resolve(remote));
  await test.runner.tick(); expect(test.dependencies.apply).not.toHaveBeenCalled();
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('冲突'));
});

it.skipIf(!process.env.MA2_ONPC_AUTO_SYNC_ACCEPTANCE)('真实 onPC 自动写回及反向修改进入工程，最后恢复测试对象', async () => {
  const target = process.env.MA2_ONPC_AUTO_SYNC_TARGET === '9907' ? 9907 : 9902;
  const connection = { dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '' };
  const bridge = new Ma2OnpcBridge(connection.dataDirectory, () => false);
  const original = await bridge.request('READ', target);
  expect(inspectMa2TimecodeXml(original).timecodes[0]?.attributes.name).toBe(target === 9907 ? '100步灯光测试' : 'TBLINK_FRACTIONAL_TIMECODE');
  const service = new Ma2ApplyService(bridge, () => false);
  const preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', target), target);
  let project = createEmptyLinkProject('自动同步真实验收');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  project = importMa2TimecodeCommand('song', preview).execute(project);
  const changed = vi.fn();
  const runner = new Ma2AutoSync({ rename: () => Promise.reject(new Error('此测试不应改名')), prepare: () => Promise.reject(new Error('此测试不应创建关联')), state: () => ({ project, documentId: 1, playing: false }), catalog: () => readMa2Catalog(bridge, () => false, undefined, undefined, undefined, { targets: [] }),
    archive: () => Promise.resolve('test-harness'),
    read: async request => convertMa2Snapshot(await bridge.request('SNAPSHOT', request.target), request.target, [], request.timeOriginMs),
    compare: request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map())), apply: request => service.apply(request),
    execute: (_id, command) => { project = command.execute(project); }, changed });
  try {
    runner.start(connection, await readMa2Catalog(bridge, () => false, undefined, undefined, undefined, { targets: [] }));
    project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at = 1200;
    await runner.tick(true); expect(changed).toHaveBeenLastCalledWith('verified', expect.any(String));
    const updated = await bridge.request('READ', target);
    const report = inspectMa2TimecodeXml(updated);
    expect(report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.attributes.time).toBe('36');
    const remote = patchMa2EventTimes(updated, report.sha256, [{ path: report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.path, rawTime: '39' }]);
    await bridge.exchange('APPLY', target, updated, remote);
    await runner.tick(true); expect(changed).toHaveBeenLastCalledWith('verified', expect.any(String));
    expect(project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at).toBe(1300);
  } finally {
    runner.stop(); const current = await bridge.request('READ', target);
    if (!sameMa2XmlObjects(current, original)) await bridge.exchange('APPLY', target, current, original);
    expect(sameMa2XmlObjects(await bridge.request('READ', target), original)).toBe(true);
  }
}, 300000);
