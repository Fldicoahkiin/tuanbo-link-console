import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2SongBinding, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
import { legacyMa2Renames, ma2SongPoints, pendingMa2Renames, renameConsoleCueCommand, setLightingCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { useMa2SongSyncStore, startMa2SongSync, stopMa2SongSync, tickMa2SongSync, ma2SongSyncSettings, resolveMa2SongConflict } from './ma2-song-sync';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { prepareMa2RealtimeSession, pauseMa2RealtimeSession, retryMa2RealtimeSession, pendingSongSummary } from './ma2-realtime-session';
import { convertMa2LegacyNames, legacyMa2ConsoleNames } from './ma2-legacy-names';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { recordLog } = vi.hoisted(() => ({ recordLog: vi.fn(() => Promise.resolve()) }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog, saveProject: vi.fn(() => Promise.resolve('song.tblink')) } }));
const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));
const source = { show: 'Show', generation: 'session', version: '3.7.0.5' };
const status = vi.fn(), catalog = vi.fn(), metadata = vi.fn(), cancel = vi.fn(), sync = vi.fn(), check = vi.fn(), rename = vi.fn();
const storage = new Map<string, string>();
function project() {
  const value = createEmptyLinkProject('自动同步');
  value.schemaVersion = 2;
  value.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { ...source, entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] } };
  value.rundown = ['first', 'second'].map(id => {
    const lighting = createLightingDocument(); lighting.outputMode = 'network';
    lighting.tracks = [{ id: `track-${id}`, name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: `clip-${id}`, name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: `point-${id}`, kind: 'empty-cue', at: 0, label: '开场', runMode: 'independent' }] }] }];
    return { id, title: id, enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting };
  });
  return value;
}
beforeEach(() => {
  vi.clearAllMocks(); storage.clear(); storage.set('tblink.ma2-connection-method.v1', 'network');
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog: catalog, readMa2EffectLibrary: metadata, cancelMa2Read: cancel, syncMa2Song: sync, checkMa2Song: check, renameMa2Object: rename } });
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  catalog.mockResolvedValue({ directory: { ...source, entries: [] }, readAt: new Date().toISOString(), entries: [] });
  metadata.mockResolvedValue(project().ma2MaterialLibrary!.library);
  cancel.mockResolvedValue(undefined);
  archive.mockResolvedValue('C:/archive.tblink');
  useMa2SongSyncStore.setState({ songs: {} });
  useMa2AutoSyncStore.setState({ request: null, status: 'off', message: '', timelinePlaying: false, previewPlaying: false });
  useMa2RealtimePreference.setState({ enabled: true });
  useDocumentStore.getState().setProject(project(), 'song.tblink');
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('默认开启后整曲进入歌曲序列同步，不再调用隐式 Timecode 9999 创建', async () => {
  await prepareMa2RealtimeSession();
  expect(Object.keys(useMa2SongSyncStore.getState().songs)).toEqual(['first', 'second']);
  expect(useMa2SongSyncStore.getState().songs.first?.settings.executorPage).toBe(1000);
  expect(useMa2AutoSyncStore.getState().request).toBeNull();
  expect(catalog).not.toHaveBeenCalled();
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, targets: [] });
  expect(pendingSongSummary(useDocumentStore.getState().project)).toHaveLength(2);
});
it('同一工程已有歌曲绑定仍自动接纳新歌，原绑定页不受默认页影响', async () => {
  const value = project();
  const binding: Ma2SongBinding = { endpoint: '192.0.2.1:30000', show: 'Show', sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  value.rundown[0]!.lighting!.consoleSong = binding;
  useDocumentStore.getState().setProject(value, 'song.tblink');
  await prepareMa2RealtimeSession();
  expect(useMa2SongSyncStore.getState().songs.first?.settings.executorPage).toBe(1234);
  expect(useMa2SongSyncStore.getState().songs.second?.settings.executorPage).toBe(1000);
});
it('已绑定歌曲清空仍进入原位置核对；确认前保留清单，选择后回读 0 步', async () => {
  const value = project();
  const lighting = value.rundown[0]!.lighting!;
  lighting.tracks[0]!.clips[0]!.events = [];
  lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  sync.mockImplementation((request: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> => {
    const cleared = request.conflictResolutions?.[0]?.choice === 'local';
    return Promise.resolve({ binding: { ...request.binding!, points: cleared ? [] : request.binding!.points }, layout: null, removed: [], backupFile: '', changed: Boolean(cleared),
      conflicts: cleared ? [] : [{ key: 'point-first:cue-deletion', field: 'cue-deletion', pointId: 'point-first', cue: '1.000', baseline: '开场', local: '软件已移除', console: '开场', token: '0'.repeat(64) }],
      library: { directory: { ...source, entries: [{ target: 9000, name: 'first' }] }, readAt: new Date().toISOString(), sequences: [{ sequence: 9000, name: 'first', cues: cleared ? [] : [{ index: 1, number: '1.000', name: '开场' }] }], fixtureUsage: [], errors: [] } });
  });
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync(false);
  expect(sync.mock.calls[0]?.[0]).toMatchObject({ points: [], binding: { sequence: 9000, executor: '1234.101' } });
  expect(useMa2SongSyncStore.getState().songs.first).toMatchObject({ state: 'blocked', conflicts: [{ field: 'cue-deletion' }] });
  expect(useDocumentStore.getState().project?.rundown[0]?.lighting?.consoleSong?.points).toHaveLength(1);
  resolveMa2SongConflict('first', 'point-first:cue-deletion', 'local');
  await tickMa2SongSync(false);
  expect(useDocumentStore.getState().project?.rundown[0]?.lighting?.consoleSong).toMatchObject({ sequence: 9000, executor: '1234.101', points: [] });
  expect(useMa2SongSyncStore.getState().songs.first?.state).toBe('verified');
});
it('有冲突的歌曲每秒复查时保持待核对和原提示，不进入同步中、不重复存档', async () => {
  vi.useFakeTimers();
  const value = project();
  const lighting = value.rundown[0]!.lighting!;
  lighting.tracks[0]!.clips[0]!.events = [];
  lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  sync.mockImplementation((request: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> => Promise.resolve({ binding: request.binding!, layout: null, removed: [], backupFile: '', changed: false,
    conflicts: [{ key: 'point-first:cue-deletion', field: 'cue-deletion', pointId: 'point-first', cue: '1.000', baseline: '开场', local: '软件已移除', console: '开场', token: '0'.repeat(64) }],
    library: { directory: { ...source, entries: [{ target: 9000, name: 'first' }] }, readAt: new Date().toISOString(), sequences: [{ sequence: 9000, name: 'first', cues: [{ index: 1, number: '1.000', name: '开场' }] }], fixtureUsage: [], errors: [] } }));
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync(false);
  const blocked = useMa2SongSyncStore.getState().songs.first!;
  expect(blocked).toMatchObject({ state: 'blocked' });
  const during: string[] = [];
  check.mockImplementation(() => { during.push(useMa2SongSyncStore.getState().songs.first!.state); return Promise.resolve(false); });
  vi.advanceTimersByTime(1001);
  await tickMa2SongSync(false);
  expect(check).toHaveBeenCalledTimes(1); expect(during).toEqual(['blocked']);
  expect(useMa2SongSyncStore.getState().songs.first).toMatchObject({ state: 'blocked', message: blocked.message });
  expect(sync).toHaveBeenCalledTimes(1); expect(archive).toHaveBeenCalledTimes(1);
});
it('同步失败退避重试时同一份本地内容只存档一次，编辑后才存新档', async () => {
  vi.useFakeTimers();
  sync.mockRejectedValue(new Error('MA2 响应超时；操作未确认，不会自动重试'));
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync(false);
  vi.advanceTimersByTime(30001); await tickMa2SongSync(false);
  vi.advanceTimersByTime(30001); await tickMa2SongSync(false);
  expect(sync).toHaveBeenCalledTimes(3); expect(archive).toHaveBeenCalledTimes(1);
  const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
  const event = lighting.tracks[0]!.clips[0]!.events[0]!;
  if (event.kind !== 'empty-cue') throw new Error('fixture 应为空 Cue');
  event.label = '开场改';
  useDocumentStore.getState().execute(setLightingCommand('first', lighting));
  vi.advanceTimersByTime(30001); await tickMa2SongSync(false);
  expect(sync).toHaveBeenCalledTimes(4);
  expect(archive).toHaveBeenCalledTimes(2);
});
it('有本地修改的歌先同步，已确认歌曲的周期复查排在后面', async () => {
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  await prepareMa2RealtimeSession();
  const lighting = value.rundown[0]!.lighting!;
  const first = useMa2SongSyncStore.getState().songs.first!;
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, first: { ...first, state: 'verified', acknowledged: JSON.stringify([ma2SongPoints(lighting), 'first']), remoteRevision: 'a'.repeat(64) } } }));
  const order: string[] = [];
  check.mockImplementation(() => { order.push('check:first'); return Promise.resolve(false); });
  sync.mockImplementation((request: Ma2SongSyncRequest) => { order.push(`sync:${request.itemId}`); return Promise.reject(new Error('测试不写入')); });
  await tickMa2SongSync(false);
  expect(order).toEqual(['sync:second', 'check:first']);
});
it('复查发现控台变化后转入同步，期间显示同步中', async () => {
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  const lighting = value.rundown[0]!.lighting!;
  const first = useMa2SongSyncStore.getState().songs.first!;
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, first: { ...first, state: 'verified', acknowledged: JSON.stringify([ma2SongPoints(lighting), 'first']), remoteRevision: 'a'.repeat(64) } } }));
  check.mockResolvedValue(true);
  const during: string[] = [];
  sync.mockImplementation(() => { during.push(useMa2SongSyncStore.getState().songs.first!.state); return Promise.reject(new Error('测试不写入')); });
  await tickMa2SongSync(false);
  expect(during).toEqual(['syncing']);
});
it('中文歌名同步后工程里仍是中文，下一轮只复查不重写；控台上改过的歌名才回读', async () => {
  vi.useFakeTimers();
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: '联动歌曲', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  const respond = (name: string) => sync.mockImplementation((request: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> => Promise.resolve({ binding: { ...request.binding!, name, baselineXml: `<baseline-${name}/>` }, layout: null, removed: [], backupFile: '', changed: true, conflicts: [],
    library: { directory: { ...source, entries: [{ target: 9000, name }] }, readAt: new Date().toISOString(), sequences: [{ sequence: 9000, name, cues: [{ index: 1, number: '1.000', name: 'KaiChang' }] }], fixtureUsage: [], errors: [] } }));
  respond('LianDongGeQu');
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync(false);
  const song = () => useDocumentStore.getState().project!.rundown[0]!.lighting!;
  expect(song().consoleSong?.name).toBe('联动歌曲');
  expect(ma2SongPoints(song()).map(point => point.name)).toEqual(['开场']);
  check.mockResolvedValue(false);
  vi.advanceTimersByTime(1001); await tickMa2SongSync(false);
  expect(sync).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
  respond('Renamed On Console'); check.mockResolvedValue(true);
  vi.advanceTimersByTime(1001); await tickMa2SongSync(false);
  expect(song().consoleSong?.name).toBe('Renamed On Console');
});
function legacyProject() {
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: '联动歌曲', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  value.ma2MaterialLibrary!.library!.sequences = [{ sequence: 9000, name: '联动歌曲', cues: [{ index: 1, number: '1.000', name: '开场' }] }, { sequence: 2, name: 'Pool', cues: [{ index: 1, number: '1.100', name: 'Front' }] }];
  return value;
}
it('统计控台上以前写入的中文歌名和 Cue 名；已是拼音或控台改过的不计', () => {
  const value = legacyProject();
  expect(legacyMa2ConsoleNames(value)).toMatchObject({ songs: ['first'], count: 2 });
  value.ma2MaterialLibrary!.library!.sequences[0]!.cues[0]!.name = 'KaiChang';
  expect(legacyMa2ConsoleNames(value)).toMatchObject({ songs: ['first'], count: 1 });
  value.ma2MaterialLibrary!.library!.sequences[0]!.name = 'Console Song';
  expect(legacyMa2ConsoleNames(value).count).toBe(0);
});
it('只有点击转换后，歌曲下一次同步才带上改写标志；完成后清除，不再改写', async () => {
  useDocumentStore.getState().setProject(legacyProject(), 'song.tblink');
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  sync.mockRejectedValue(new Error('测试不写入'));
  expect(useMa2SongSyncStore.getState().songs.first?.rewriteLegacyNames).toBeUndefined();
  expect(await convertMa2LegacyNames(useDocumentStore.getState().documentId)).toBe(2);
  expect(rename).not.toHaveBeenCalled();
  await tickMa2SongSync(false);
  expect(sync.mock.calls.at(-1)?.[0]).toMatchObject({ itemId: 'first', rewriteLegacyNames: true });
});
it('以前以中文确认的改名不自动写，点击转换后逐条写入拼音并确认', async () => {
  let value = legacyProject();
  value = renameConsoleCueCommand({ sequence: 2, cue: '1.100', kind: 'single' }, '面光', { endpoint: '192.0.2.1:30000', show: source.show }).execute(value);
  const library = value.ma2MaterialLibrary!.userLibrary!;
  value.ma2MaterialLibrary = { ...value.ma2MaterialLibrary!, userLibrary: { ...library, consoleRenames: library.consoleRenames!.map(record => ({ ...record, confirmedName: '面光' })) } };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  expect(pendingMa2Renames(value)).toEqual([]); expect(legacyMa2Renames(value)).toHaveLength(1);
  rename.mockImplementation((request: { change: { sequence: number; cue: string; kind: string } }) => Promise.resolve({ sequence: request.change.sequence, cue: request.change.cue, kind: request.change.kind, show: source.show, generation: source.generation, name: 'MianGuang', backupFile: `tblink_label_${'a'.repeat(32)}.xml` }));
  useMa2RealtimePreference.setState({ enabled: false });
  await expect(convertMa2LegacyNames(useDocumentStore.getState().documentId)).rejects.toThrow('请先开启实时同步');
  useMa2RealtimePreference.setState({ enabled: true });
  expect(await convertMa2LegacyNames(useDocumentStore.getState().documentId)).toBe(3);
  expect(rename).toHaveBeenCalledOnce(); expect(rename.mock.calls[0]?.[0]).toMatchObject({ change: { name: '面光', confirmedName: '面光' } });
  expect(legacyMa2Renames(useDocumentStore.getState().project)).toEqual([]);
  expect(archive).toHaveBeenCalledOnce();
});
it('未保存、未连接时等待，不弹保存窗口、不自动重连或创建', async () => {
  useDocumentStore.getState().setProject(project(), null);
  await prepareMa2RealtimeSession(); expect(status).not.toHaveBeenCalled();
  useDocumentStore.getState().setProject(project(), 'song.tblink');
  status.mockResolvedValue({ state: 'disconnected' });
  await prepareMa2RealtimeSession();
  expect(useMa2SongSyncStore.getState().songs).toEqual({});
});
it('播放中不启动目录扫描，不把读取被播放打断误报为同步故障', async () => {
  useMa2AutoSyncStore.setState({ timelinePlaying: true });
  expect(await prepareMa2RealtimeSession()).toBe(false);
  expect(metadata).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  expect(useMa2AutoSyncStore.getState().status).toBe('waiting');
});
it('来源不符保留修改，只检查连接状态；恢复原控台后自动重新核对', async () => {
  vi.useFakeTimers();
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.2', port: 30000 } });
  await prepareMa2RealtimeSession(); await prepareMa2RealtimeSession();
  expect(useMa2AutoSyncStore.getState().status).toBe('blocked');
  expect(useMa2AutoSyncStore.getState().message).toContain('来源不同');
  expect(status).toHaveBeenCalledTimes(2); expect(catalog).not.toHaveBeenCalled(); expect(useMa2SongSyncStore.getState().songs).toEqual({});
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  vi.advanceTimersByTime(1001);
  await prepareMa2RealtimeSession();
  expect(Object.keys(useMa2SongSyncStore.getState().songs)).toEqual(['first', 'second']);
});
it('会话检查偶发失败后，下一次核对成功即解除待核对，不需要手动按钮', async () => {
  vi.useFakeTimers();
  metadata.mockRejectedValueOnce(new Error('控台工程或序列目录发生变化，请重新读取'));
  expect(await prepareMa2RealtimeSession()).toBe(false);
  expect(useMa2AutoSyncStore.getState()).toMatchObject({ status: 'blocked', message: '控台工程或序列目录发生变化，请重新读取' });
  vi.advanceTimersByTime(1001);
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(useMa2AutoSyncStore.getState().status).not.toBe('blocked');
  expect(useMa2AutoSyncStore.getState().message).not.toContain('序列目录发生变化');
});
it('目录核对通过但后续读取持续失败时保持待核对，不来回跳也不重复写日志', async () => {
  vi.useFakeTimers();
  const value = project();
  const preview = { name: 'TC', readAt: new Date().toISOString(), sourceXml: '<MA/>' };
  value.rundown[0]!.lighting!.ma2Bindings = [{ id: 'bound', timecode: 9901, ...preview, baselineTracks: [], mappings: [], trackMappings: [] }];
  useDocumentStore.getState().setProject(value, 'song.tblink');
  catalog.mockRejectedValue(new Error('MA2 响应超时；操作未确认，不会自动重试'));
  const statuses: string[] = [];
  const unsubscribe = useMa2AutoSyncStore.subscribe(state => { if (statuses.at(-1) !== state.status) statuses.push(state.status); });
  try {
    await prepareMa2RealtimeSession();
    for (let attempt = 0; attempt < 3; attempt++) { vi.advanceTimersByTime(1001); await prepareMa2RealtimeSession(); }
  } finally { unsubscribe(); }
  expect(statuses).toEqual(['waiting', 'blocked']);
  expect(recordLog).toHaveBeenCalledTimes(1);
});
it('自动同步自身的阻断不会被会话检查成功清掉', async () => {
  const request = { connection: { dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } }, catalog: { directory: { ...source, entries: [] }, readAt: new Date().toISOString(), entries: [] }, scope: 'bound' as const };
  vi.useFakeTimers();
  await prepareMa2RealtimeSession();
  useMa2AutoSyncStore.setState({ request, status: 'blocked', message: 'Timecode 1 有 1 处冲突' });
  vi.advanceTimersByTime(5001);
  await prepareMa2RealtimeSession();
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(useMa2AutoSyncStore.getState()).toMatchObject({ status: 'blocked', message: 'Timecode 1 有 1 处冲突' });
});
it('桥重启后先核对同一 Show 的新 generation，再续接原歌曲，不反复读整曲', async () => {
  vi.useFakeTimers();
  await prepareMa2RealtimeSession();
  const sessions = Object.fromEntries(Object.entries(useMa2SongSyncStore.getState().songs).map(([key, song]) => [key, song.sessionId]));
  metadata.mockResolvedValue({ ...project().ma2MaterialLibrary!.library, directory: { ...source, generation: 'restarted-bridge', entries: [] } });
  await prepareMa2RealtimeSession();
  expect(metadata).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5001);
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.library?.directory.generation).toBe('restarted-bridge');
  expect(Object.fromEntries(Object.entries(useMa2SongSyncStore.getState().songs).map(([key, song]) => [key, song.sessionId]))).toEqual(sessions);
  expect(catalog).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
});
it('不同 Show 不改素材来源与本地编排，也不将已连接误认成可以同步', async () => {
  metadata.mockResolvedValue({ ...project().ma2MaterialLibrary!.library, directory: { ...source, show: 'another-show', generation: 'other', entries: [] } });
  const before = useDocumentStore.getState();
  expect(await prepareMa2RealtimeSession()).toBe(false);
  expect(useDocumentStore.getState().revision).toBe(before.revision);
  expect(useDocumentStore.getState().project).toBe(before.project);
  expect(useMa2SongSyncStore.getState().songs).toEqual({});
});
it('会话目录回读途中切换为 MIDI，不应用迟到 generation 或创建歌曲队列', async () => {
  let finish: (value: unknown) => void = () => { throw new Error('metadata not started'); };
  metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const promise = prepareMa2RealtimeSession();
  await vi.waitFor(() => expect(metadata).toHaveBeenCalledOnce());
  const before = useDocumentStore.getState();
  storage.set('tblink.ma2-connection-method.v1', 'midi');
  finish({ ...project().ma2MaterialLibrary!.library, directory: { ...source, generation: 'late', entries: [] } });
  expect(await promise).toBe(false);
  expect(useDocumentStore.getState().revision).toBe(before.revision);
  expect(useMa2SongSyncStore.getState().songs).toEqual({});
});
it('暂停持久化并取消在途任务，下一轮不会重新开启', async () => {
  await prepareMa2RealtimeSession();
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, first: { ...state.songs.first!, requestId: 'task-in-flight', state: 'syncing' } } }));
  pauseMa2RealtimeSession(); await prepareMa2RealtimeSession();
  expect(storage.get('tblink.ma2-realtime-enabled.v1')).toBe('false');
  expect(cancel).toHaveBeenCalledExactlyOnceWith('task-in-flight');
  expect(Object.values(useMa2SongSyncStore.getState().songs).every(song => song.state === 'paused')).toBe(true);
});
it('手动发起本曲同步不会被首次会话初始化清掉', async () => {
  const value = useDocumentStore.getState().project!;
  startMa2SongSync('first', '自定义名称', ma2SongSyncSettings(value, 'first'));
  const sessionId = useMa2SongSyncStore.getState().songs.first?.sessionId;
  await prepareMa2RealtimeSession();
  expect(useMa2SongSyncStore.getState().songs.first).toMatchObject({ sessionId, name: '自定义名称' });
});
it('人工重新核对时恢复暂停歌曲，仍在取消中的歌曲不会并发重发', async () => {
  await prepareMa2RealtimeSession(); pauseMa2RealtimeSession();
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, first: { ...state.songs.first!, requestId: 'still-running' } } }));
  retryMa2RealtimeSession();
  await vi.waitFor(() => expect(useMa2SongSyncStore.getState().songs.second?.state).toBe('pending'));
  expect(useMa2SongSyncStore.getState().songs.first?.state).toBe('paused');
  expect(useMa2RealtimePreference.getState().enabled).toBe(true);
});
it('断线后进入等待，保持待同步修改且不尝试写控台', async () => {
  await prepareMa2RealtimeSession();
  status.mockResolvedValue({ state: 'disconnected' });
  await tickMa2SongSync(false);
  expect(Object.values(useMa2SongSyncStore.getState().songs).every(song => song.state === 'pending' && song.waitingForConnection)).toBe(true);
  expect(archive).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
});
it('开始播放中断写入时保留待同步状态，不把歌曲永久锁住', async () => {
  await prepareMa2RealtimeSession();
  stopMa2SongSync('second');
  sync.mockImplementationOnce(() => {
    useMa2AutoSyncStore.setState({ timelinePlaying: true });
    return Promise.reject(new Error('播放已开始，后续步骤未发送'));
  });
  await tickMa2SongSync(false);
  expect(useMa2SongSyncStore.getState().songs.first).toMatchObject({ state: 'pending', requestId: null });
  expect(useMa2SongSyncStore.getState().songs.first?.message).toContain('停止后核对');
});
it('存档期间暂停也会取消尚未发出的同步，不会在暂停后偷偷写入', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  let finish: (value: string) => void = () => { throw new Error('archive not started'); };
  archive.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const tick = tickMa2SongSync(false);
  await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
  stopMa2SongSync('first'); finish('C:/archive.tblink'); await tick;
  expect(sync).not.toHaveBeenCalled(); expect(useMa2SongSyncStore.getState().songs.first?.state).toBe('paused');
});
it('等待连接查询时改为 MIDI，不继续存档或发送网络同步', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  let finish: (value: unknown) => void = () => { throw new Error('status not started'); };
  status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const tick = tickMa2SongSync(false);
  storage.set('tblink.ma2-connection-method.v1', 'midi');
  finish({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  await tick;
  expect(sync).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
});
it('同曲开始新会话后，旧会话迟到回包不改工程或新会话状态', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  let finish: (value: unknown) => void = () => { throw new Error('sync not started'); };
  sync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const tick = tickMa2SongSync(false);
  await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
  const before = useDocumentStore.getState();
  startMa2SongSync('first', '新会话', ma2SongSyncSettings(before.project!, 'first'));
  const sessionId = useMa2SongSyncStore.getState().songs.first!.sessionId;
  finish({ binding: { sequence: 9000 }, changed: true }); await tick;
  expect(useDocumentStore.getState().revision).toBe(before.revision);
  expect(useMa2SongSyncStore.getState().songs.first).toMatchObject({ sessionId, name: '新会话', state: 'pending' });
});
it('存档过程中开始播放时暂不写控台，停止后保留原队列', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  archive.mockImplementationOnce(() => { useMa2AutoSyncStore.setState({ timelinePlaying: true }); return Promise.resolve('C:/archive.tblink'); });
  await tickMa2SongSync(false);
  expect(sync).not.toHaveBeenCalled();
  expect(useMa2SongSyncStore.getState().songs.first).toMatchObject({ state: 'pending' });
});
