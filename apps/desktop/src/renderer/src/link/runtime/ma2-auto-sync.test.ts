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
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('verified', expect.any(String));
});
it('写入不确定时锁住后续周期，不自动重试', async () => {
  const test = setup(); test.edit(); await test.runner.tick(); await test.runner.tick();
  expect(test.dependencies.apply).toHaveBeenCalledTimes(1);
  expect(test.dependencies.changed).toHaveBeenLastCalledWith('blocked', expect.stringContaining('backup.xml'));
});
it('播放期间不读取或写入', async () => {
  const test = setup(); test.edit(); test.play(); await test.runner.tick();
  expect(test.dependencies.read).not.toHaveBeenCalled(); expect(test.dependencies.apply).not.toHaveBeenCalled();
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
  const test = setup(); test.catalog.directory.show = 'Other'; await test.runner.tick(); await test.runner.tick();
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
  const connection = { dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '' };
  const bridge = new Ma2OnpcBridge(connection.dataDirectory, () => false);
  const original = await bridge.request('READ', 9902);
  expect(inspectMa2TimecodeXml(original).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const service = new Ma2ApplyService(bridge, () => false);
  const preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
  let project = createEmptyLinkProject('自动同步真实验收');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  project = importMa2TimecodeCommand('song', preview).execute(project);
  const changed = vi.fn();
  const runner = new Ma2AutoSync({ state: () => ({ project, documentId: 1, playing: false }), catalog: () => readMa2Catalog(bridge, () => false),
    read: async request => convertMa2Snapshot(await bridge.request('SNAPSHOT', request.target), request.target, [], request.timeOriginMs),
    compare: request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map())), apply: request => service.apply(request),
    execute: (_id, command) => { project = command.execute(project); }, changed });
  try {
    runner.start(connection, await readMa2Catalog(bridge, () => false));
    project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at = 1200;
    await runner.tick(); expect(changed).toHaveBeenLastCalledWith('verified', expect.any(String));
    const updated = await bridge.request('READ', 9902);
    const report = inspectMa2TimecodeXml(updated);
    expect(report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.attributes.time).toBe('36');
    const remote = patchMa2EventTimes(updated, report.sha256, [{ path: report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.path, rawTime: '39' }]);
    await bridge.exchange('APPLY', 9902, updated, remote);
    await runner.tick(); expect(changed).toHaveBeenLastCalledWith('verified', expect.any(String));
    expect(project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at).toBe(1300);
  } finally {
    runner.stop(); const current = await bridge.request('READ', 9902);
    if (!sameMa2XmlObjects(current, original)) await bridge.exchange('APPLY', 9902, current, original);
    expect(sameMa2XmlObjects(await bridge.request('READ', 9902), original)).toBe(true);
  }
}, 120000);
