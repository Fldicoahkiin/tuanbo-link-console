import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2ApplyRequest, type Ma2CompareRequest } from '@tb/schema';
import { importMa2TimecodeCommand, ma2PendingChanges, setLightingCommand } from '@tb/core/link';
import { convertMa2Snapshot, convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { useDocumentStore } from '../stores/document-store';
import { ma2SyncPlaying, useMa2SyncStore } from '../stores/ma2-sync-store';
import { lightingEditHandler } from '../components/lighting-edit-handler';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { markPendingMa2Songs, ma2SongSyncSettings, startMa2SongSync, stopMa2SongSync, tickMa2SongSync } from './ma2-song-sync';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: () => Promise.resolve() } }));

const xml = await readFile(new URL('../../../../main/link/fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('../../../../main/link/fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const sequenceObject = sequence.match(/<Sequ\s[\s\S]*<\/Sequ>/)![0];
const snapshot = (value: string): string => value.replace('</MA>', `${sequenceObject}</MA>`);
const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' };

/** A way-1 song: its lighting was read from the console's Timecode 9902, and the console's materials were read from the same console. */
function load(timecode = xml): void {
  const project = createEmptyLinkProject('安全暂存');
  project.schemaVersion = 2;
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  const bound = importMa2TimecodeCommand('song', convertMa2Timecode(timecode, [sequence], 9902)).execute(project);
  bound.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { show: 'Test', generation: 'session', version: '3.3.4', entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] } };
  useDocumentStore.getState().setProject(bound, 'song.tblink');
}
let unsubscribe = (): void => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'tblink.ma2-connection-method.v1' ? 'network' : null, setItem: () => undefined });
  archive.mockResolvedValue('C:/archive.tblink');
  useMa2RealtimePreference.setState({ enabled: true });
  useMa2SyncStore.setState({ songs: {}, names: { state: 'idle', message: '' }, timelinePlaying: false, previewPlaying: false });
  load();
  // As the app does: an edit marks a confirmed song as waiting for its sync.
  unsubscribe = useDocumentStore.subscribe((state, previous) => { if (state.project !== previous.project) markPendingMa2Songs(); });
});
afterEach(() => { unsubscribe(); vi.unstubAllGlobals(); });

/** The console at Timecode 9902 is `native`; the real apply service writes it, checks it before writing and reads it back. */
function setup(initial = xml) {
  let native = initial;
  const bridge = {
    request: vi.fn(() => Promise.resolve(snapshot(native))),
    exchange: vi.fn((_operation: string, _target: number, _expected: string, desired: string) => {
      native = desired;
      return Promise.resolve({ response: native, requestId: 'a'.repeat(32) });
    })
  };
  const service = new Ma2ApplyService(bridge, () => ma2SyncPlaying());
  const api = {
    getMa2NetworkStatus: vi.fn(() => Promise.resolve({ state: 'connected', settings: { ...network, autoConnect: false } })),
    previewMa2: vi.fn(() => Promise.resolve(convertMa2Snapshot(snapshot(native), 9902))),
    compareMa2: vi.fn((request: Ma2CompareRequest) => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback))),
    applyMa2: vi.fn((request: Ma2ApplyRequest) => service.apply(request))
  };
  vi.stubGlobal('window', { tbLink: api });
  startMa2SongSync('song', '歌曲', ma2SongSyncSettings(useDocumentStore.getState().project!, 'song'));
  useMa2SyncStore.setState({ timelinePlaying: true });
  const edit = (at: number) => {
    const project = useDocumentStore.getState().project!;
    const document = structuredClone(project.rundown[0]!.lighting!);
    document.tracks[0]!.clips[0]!.events[0]!.at = at;
    const notify = vi.fn();
    lightingEditHandler({ itemId: 'song', project, notify })(document, '修改灯光位置');
    expect(notify).not.toHaveBeenCalled();
  };
  return { api, bridge, edit, tick: () => tickMa2SongSync(ma2SyncPlaying()), song: () => useMa2SyncStore.getState().songs.song!,
    stop: () => { useMa2SyncStore.setState({ timelinePlaying: false }); }, play: () => { useMa2SyncStore.setState({ timelinePlaying: true }); },
    remote: (value: string) => { native = value; }, console: () => native };
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
  await test.tick(); await test.tick();
  expect(test.api.getMa2NetworkStatus).not.toHaveBeenCalled(); expect(test.api.previewMa2).not.toHaveBeenCalled();
  expect(test.api.applyMa2).not.toHaveBeenCalled(); expect(test.bridge.exchange).not.toHaveBeenCalled();
  expect(test.song().state).toBe('pending'); expect(test.song().message).toContain('播放中');
});

it('播放中到了定期核对的时间，已确认的歌不读控台，也不变成待同步', async () => {
  const test = setup(); test.stop(); await test.tick();
  expect(test.song().state).toBe('verified');
  const reads = test.api.previewMa2.mock.calls.length;
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, song: { ...state.songs.song!, nextCheckAt: 0 } } }));
  test.play(); await test.tick();
  expect(test.song().state).toBe('verified'); expect(test.api.previewMa2).toHaveBeenCalledTimes(reads);
});

it('停止后经过比较、写前快照与回读才清空待提交，回读更新基线但不增加撤销步骤', async () => {
  const test = setup(); test.edit(1000); await test.tick(); test.stop();
  await test.tick();
  expect(test.api.compareMa2).toHaveBeenCalledOnce();
  expect(test.bridge.request).toHaveBeenCalledTimes(2); expect(test.bridge.exchange).toHaveBeenCalledOnce();
  expect(pending()).toEqual([]);
  expect(useDocumentStore.getState().past).toHaveLength(1);
  expect(test.song()).toMatchObject({ state: 'verified', writing: false, message: 'Timecode 9902 已写入控台并回读确认' });
});

// 2026-11-11 用户：“矛盾的时候采用最新的”，取代 2026-10-26 的“以联动台为准”。播放时改的点，停下后才第一次看到控台上也挪了：控台的更晚。
it('同一项两边都改过：用后改的那一边，同步不停止；这里控台上的改动后看到，用控台的，控台不用再写（2026-11-11）', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000);
  try {
    const test = setup(); test.edit(1000); test.remote(xml.replace('<Event index="0"', '<Event time="15" index="0"')); vi.setSystemTime(1_002_000); test.stop();
    await test.tick(); await test.tick();
    expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(position()).toBe(500); expect(pending()).toEqual([]);
    expect(consoleEvents(test.console())).toEqual(['time="15" command="Goto" pressed="true" step="1"', 'time="45" command="Goto" pressed="true" step="2"']);
    expect(test.song()).toMatchObject({ state: 'verified' }); expect(test.song().message).toContain('按最新的用了控台上的');
  } finally { vi.useRealTimers(); }
});

// A console-recorded show: the first press has its button release, and another action the software does not convert.
const recorded = xml
  .replace('<Event index="1" time="45"', '<Event index="2" time="45"')
  .replace(/(<\/Event>)(\s*<Event index="2")/, '$1<Event index="1" time="10" command="Goto" pressed="false" step="1"><Cue name="Cue 1.25"><No>1</No><No>9901</No><No>1</No></Cue></Event>$2')
  .replace(/(<\/SubTrack>)/, '<Event index="3" time="60" command="Learn" pressed="true"/>$1');
const consoleEvents = (value: string) => [...value.matchAll(/<Event\s([^>]*)>/g)].map(match => match[1]!.replace(/\s*\/$/, '').replace(/\s*index="\d+"/, '').trim());

it('控台录的时间线：软件改 Cue 时间写回同一条时间线，按键松开跟着按下走，不认识的动作原样保留（2026-10-26）', async () => {
  expect(consoleEvents(recorded)).toHaveLength(4);
  load(recorded);
  expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.ma2Bindings![0]!.nativeEvents).toHaveLength(2);
  const test = setup(recorded); test.edit(1000); test.stop();
  await test.tick();
  expect(test.bridge.exchange).toHaveBeenCalledOnce(); expect(pending()).toEqual([]);
  expect(test.song().state).toBe('verified');
  expect(consoleEvents(test.console())).toEqual([
    'command="Goto" pressed="true" step="1" time="30"', 'time="40" command="Goto" pressed="false" step="1"',
    'time="45" command="Goto" pressed="true" step="2"', 'time="60" command="Learn" pressed="true"']);
  const binding = useDocumentStore.getState().project!.rundown[0]!.lighting!.ma2Bindings![0]!;
  expect(binding.nativeEvents).toHaveLength(2); expect(binding.sourceXml).toContain('command="Learn"');
  // Deleting the press in the software takes its release along; the other console action stays.
  const current = useDocumentStore.getState().project!;
  const document = structuredClone(current.rundown[0]!.lighting!);
  document.tracks[0]!.clips[0]!.events.splice(0, 1);
  lightingEditHandler({ itemId: 'song', project: current, notify: vi.fn() })(document, '删除灯光点');
  await test.tick();
  expect(test.bridge.exchange).toHaveBeenCalledTimes(2); expect(pending()).toEqual([]);
  expect(consoleEvents(test.console())).toEqual(['time="45" command="Goto" pressed="true" step="2"', 'time="60" command="Learn" pressed="true"']);
});

// 2026-11-11：读完到写入之间控台上又改了，和方式 2 的“控台同时在改”一样只是等一下再读，不当成失败停下（同步规则“写入中控台被改”）。
it('写前核对发现控台变动则拒绝写入并保留暂存；隔 2 秒重新读取，控台一直在改才停下', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const test = setup(); test.edit(1000); test.stop();
    test.bridge.request.mockResolvedValue(snapshot(xml.replace('<Event index="0"', '<Event time="15" index="0"')));
    await test.tick(); await test.tick();
    expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
    expect(test.api.applyMa2).toHaveBeenCalledOnce();
    expect(test.song()).toMatchObject({ state: 'pending', message: '控台上刚改过这首歌的灯光，这次没有写入；稍后重新读取控台再同步' });
    for (let attempt = 0; attempt < 5; attempt += 1) { vi.setSystemTime(Date.now() + 2001); await test.tick(); }
    expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(test.api.applyMa2).toHaveBeenCalledTimes(6);
    expect(test.song().state).toBe('blocked'); expect(test.song().message).toContain('预览之后控台的');
    expect(test.song().message).toContain('刷新同步');
  } finally { vi.useRealTimers(); }
});

it('回读失败或内容不一致不会清空暂存或重复写入', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.bridge.request.mockResolvedValue(snapshot(xml));
  await test.tick(); await test.tick();
  expect(test.bridge.exchange).toHaveBeenCalledOnce(); expect(useDocumentStore.getState().past).toHaveLength(1);
  expect(pending()).toHaveLength(1); expect(position()).toBe(1000);
  expect(test.song().state).toBe('blocked'); expect(test.song().message).toContain('可能已经写入');
});

it.each(['读取', '写入', '回读'] as const)('%s异常保留暂存，后续停止不自动重试', async stage => {
  const test = setup(); test.edit(1000); test.stop();
  if (stage === '读取') test.bridge.request.mockRejectedValueOnce(new Error('读取超时'));
  else if (stage === '写入') test.bridge.exchange.mockRejectedValueOnce(new Error('写入超时'));
  else test.bridge.request.mockResolvedValueOnce(snapshot(xml)).mockRejectedValueOnce(new Error('回读超时'));
  await test.tick(); await test.tick();
  expect(test.api.applyMa2).toHaveBeenCalledOnce(); expect(useDocumentStore.getState().past).toHaveLength(1);
  expect(pending()).toHaveLength(1); expect(position()).toBe(1000);
  expect(test.song().state).toBe('blocked'); expect(test.song().message).toContain(`${stage}超时`);
});

it('已确认的写入在回读应用前暂停同步：回读照样进工程，不停在写入中、不冒充仍在同步', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.api.applyMa2.mockImplementationOnce(async request => { const result = await new Ma2ApplyService(test.bridge, () => false).apply(request); stopMa2SongSync('song'); return result; });
  await test.tick();
  expect(pending()).toEqual([]);
  expect(test.song()).toMatchObject({ state: 'paused', writing: false });
});

it('比较期间暂停同步，中断后不发写入且保留暂存', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.api.compareMa2.mockImplementationOnce(request => { stopMa2SongSync('song'); return Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback)); });
  await test.tick(); await test.tick();
  expect(test.api.applyMa2).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
  expect(test.song().state).toBe('paused');
});

it('读取中恢复播放取消本轮写入，再次停止必须重新读取', async () => {
  const test = setup(); test.edit(1000); test.stop();
  test.api.previewMa2.mockImplementationOnce(() => { test.play(); return Promise.resolve(convertMa2Snapshot(snapshot(test.console()), 9902)); });
  await test.tick(); expect(test.api.applyMa2).not.toHaveBeenCalled();
  expect(test.song().state).toBe('pending'); expect(test.song().consecutiveFailures ?? 0).toBe(0);
  test.stop(); await test.tick();
  expect(test.api.previewMa2).toHaveBeenCalledTimes(2); expect(test.bridge.exchange).toHaveBeenCalledOnce();
});

it('写入期间继续编辑保留最新位置，下一轮继续写入；撤销仍形成反向修改', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args); test.edit(1400); return result;
  });
  await test.tick();
  expect(position()).toBe(1400); expect(pending()).toHaveLength(1);
  expect(test.song().state).toBe('pending');
  await test.tick();
  expect(position()).toBe(1400); expect(pending()).toEqual([]);
  expect(test.bridge.exchange).toHaveBeenCalledTimes(2);
  useDocumentStore.getState().undo(); expect(position()).toBe(1000);
  await test.tick(); expect(pending()).toEqual([]);
});

it('写入中暂停同步仍核对已发出的修改，不再发送下一笔', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args); stopMa2SongSync('song'); test.edit(1400); return result;
  });
  await test.tick(); await test.tick();
  expect(position()).toBe(1400); expect(pending()).toHaveLength(1);
  expect(test.bridge.exchange).toHaveBeenCalledOnce();
  expect(test.song().state).toBe('paused');
});

it('写入中切换工程不把旧回读应用到新工程', async () => {
  const test = setup(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args);
    useDocumentStore.getState().setProject(createEmptyLinkProject('其他工程'), null); return result;
  });
  await test.tick();
  expect(useDocumentStore.getState().project?.rundown).toEqual([]);
  expect(test.song().state).toBe('blocked'); expect(test.song().message).toContain('回到原来的工程');
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

it('控台确认后一次撤销就反向同步，重做仍使用最新基线；一分钟内的连续写入只存一次同步前存档', async () => {
  const test = setup(); const original = position(); test.edit(1000); test.stop();
  await test.tick(); expect(pending()).toEqual([]);
  useDocumentStore.getState().undo(); expect(position()).toBe(original); expect(pending()).toHaveLength(1);
  await test.tick(); expect(pending()).toEqual([]);
  expect(useDocumentStore.getState().future).toHaveLength(1);
  useDocumentStore.getState().redo(); expect(position()).toBe(1000);
  await test.tick(); expect(pending()).toEqual([]);
  useDocumentStore.getState().undo(); expect(position()).toBe(original);
  await test.tick(); expect(pending()).toEqual([]);
  expect(test.bridge.exchange).toHaveBeenCalledTimes(4);
  expect(archive).toHaveBeenCalledOnce();
});

it('写入中撤销不会被旧回读覆盖，下一笔写回撤销后的内容', async () => {
  const test = setup(); const original = position(); test.edit(1000); test.stop();
  const exchange = test.bridge.exchange.getMockImplementation()!;
  test.bridge.exchange.mockImplementationOnce(async (...args) => {
    const result = await exchange(...args); useDocumentStore.getState().undo(); return result;
  });
  await test.tick(); expect(position()).toBe(original); expect(pending()).toHaveLength(1);
  await test.tick(); expect(position()).toBe(original); expect(pending()).toEqual([]);
  expect(useDocumentStore.getState().future).toHaveLength(1);
  await test.tick(); expect(test.song().state).toBe('verified'); expect(test.song().message).toContain('回读确认');
});

it('存档失败阻止写入，并保留本地修改且不重试', async () => {
  const test = setup(); test.edit(1000); test.stop();
  archive.mockRejectedValue(new Error('磁盘无法保存存档'));
  await test.tick(); await test.tick();
  expect(test.bridge.exchange).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
  expect(test.song().state).toBe('blocked'); expect(test.song().message).toContain('存档');
});
