import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, type Ma2SongBinding, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
import { legacyMa2Renames, ma2SongPoints, pendingMa2Renames, renameConsoleCueCommand, setLightingCommand, SHOW_WAIT_CLOCK_MOVING } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useShowStateStore } from '../stores/show-state-store';
import { startMa2SongSync, stopMa2SongSync, tickMa2SongSync, ma2SongSyncSettings, markPendingMa2Songs, flushPendingMa2Songs } from './ma2-song-sync';
import { useProgramSelectionStore } from '../stores/program-selection-store';
import { useMtcStartAllocationStore } from '../stores/mtc-start-allocation-store';
import { setMa2ConsoleChanges, setMa2WriteMode, useMa2RealtimePreference } from './ma2-realtime-preference';
import { prepareMa2RealtimeSession, pauseMa2RealtimeSession, recheckMa2Songs, refreshMa2RealtimeSession, retryMa2RealtimeSession, pendingSongSummary, songsWithoutConsoleShow, syncMa2Once, writeMissingConsoleShows } from './ma2-realtime-session';
import { convertMa2LegacyNames, legacyMa2ConsoleNames } from './ma2-legacy-names';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { recordLog } = vi.hoisted(() => ({ recordLog: vi.fn<(entry: { level: string; message: string }) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog } }));
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
    const lighting = createLightingDocument();
    lighting.tracks = [{ id: `track-${id}`, name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: `clip-${id}`, name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: `point-${id}`, kind: 'empty-cue', at: 0, label: '开场', runMode: 'independent' }] }] }];
    return { id, title: id, enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting };
  });
  return value;
}

/** The show as main reports it (useShowStateStore): idle, the program moving, or paused (held). */
const RUNNING = { phase: 'running', source: 'internal', itemId: 'song', program: null } as const;
const HELD = { phase: 'held', source: 'internal', itemId: 'song', reason: 'paused', program: null } as const;
const IDLE = { phase: 'idle', program: null } as const;

beforeEach(() => {
  vi.clearAllMocks(); storage.clear(); storage.set('tblink.ma2-connection-method.v1', 'network');
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog: catalog, readMa2EffectLibrary: metadata, cancelMa2Read: cancel, syncMa2Song: sync, checkMa2Song: check, renameMa2Object: rename } });
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  catalog.mockResolvedValue({ directory: { ...source, entries: [] }, readAt: new Date().toISOString(), entries: [] });
  metadata.mockResolvedValue(project().ma2MaterialLibrary!.library);
  cancel.mockResolvedValue(undefined);
  archive.mockResolvedValue('C:/archive.tblink');
  useMa2SyncStore.setState({ songs: {} });
  useMa2SyncStore.setState({ names: { state: 'idle', message: '' }, session: { status: 'waiting', message: '' }, previewPlaying: false });
  useShowStateStore.setState({ show: IDLE });
  useMa2RealtimePreference.setState({ enabled: true, once: null, writeMode: 'merge', consoleChanges: 'read-back' });
  useMtcStartAllocationStore.setState({ error: null, context: '', retryAt: 0 });
  useDocumentStore.getState().setProject(project(), 'song.tblink');
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('默认开启后整曲进入歌曲序列同步，不再调用隐式 Timecode 9999 创建', async () => {
  await prepareMa2RealtimeSession();
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']);
  expect(useMa2SyncStore.getState().songs.first?.settings.executorPage).toBe(1000);
  expect(useMa2SyncStore.getState().session.status).toBe('ready');
  expect(catalog).not.toHaveBeenCalled();
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, targets: [] });
  expect(pendingSongSummary(useDocumentStore.getState().project)).toHaveLength(2);
});
it('旧工程存着 MIDI 直控或网络发命令的歌，打开后按时间码进入同步并写到控台（2026-11-01）', async () => {
  const value = project();
  value.rundown[0]!.lighting = lightingDocumentSchema.parse({ ...value.rundown[0]!.lighting, outputMode: 'network' });
  value.rundown[1]!.lighting = lightingDocumentSchema.parse({ ...value.rundown[1]!.lighting, outputMode: 'direct' });
  useDocumentStore.getState().setProject(value, 'song.tblink');
  sync.mockRejectedValue(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
  await prepareMa2RealtimeSession();
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']);
  expect(pendingSongSummary(useDocumentStore.getState().project)).toHaveLength(2);
  await tickMa2SongSync();
  expect(sync.mock.calls.map(call => (call[0] as Ma2SongSyncRequest).itemId)).toEqual(['first', 'second']);
});
it('同一工程已有歌曲绑定仍自动接纳新歌，原绑定页不受默认页影响', async () => {
  const value = project();
  const binding: Ma2SongBinding = { endpoint: '192.0.2.1:30000', show: 'Show', sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  value.rundown[0]!.lighting!.consoleSong = binding;
  useDocumentStore.getState().setProject(value, 'song.tblink');
  await prepareMa2RealtimeSession();
  expect(useMa2SyncStore.getState().songs.first?.settings.executorPage).toBe(1234);
  expect(useMa2SyncStore.getState().songs.second?.settings.executorPage).toBe(1000);
});
function boundFirst(patch: Partial<Ma2SongBinding> = {}) {
  const value = project();
  const lighting = value.rundown[0]!.lighting!;
  lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }], ...patch };
  return value;
}
const answer = (request: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> => Promise.resolve({ binding: { ...request.binding!, points: request.points.map((point, index) => ({ id: point.id, cue: `${index + 1}.000` })) }, layout: null, backupFile: '', changed: true,
  library: { directory: { ...source, entries: [{ target: 9000, name: 'first' }] }, readAt: new Date().toISOString(), sequences: [{ sequence: 9000, name: 'first', cues: request.points.map((_, index) => ({ index: index + 1, number: `${index + 1}.000`, name: '开场' })) }], fixtureUsage: [], errors: [] } });
it('已绑定歌曲清空时直接同步删除，回读 0 步，不再等核对清单', async () => {
  const value = boundFirst();
  value.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events = [];
  useDocumentStore.getState().setProject(value, 'song.tblink');
  sync.mockImplementation(answer);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]?.[0]).toMatchObject({ points: [], binding: { sequence: 9000, executor: '1234.101' } });
  expect(sync.mock.calls[0]?.[0]).not.toHaveProperty('confirmedDeletions');
  expect(useDocumentStore.getState().project?.rundown[0]?.lighting?.consoleSong).toMatchObject({ sequence: 9000, executor: '1234.101', points: [] });
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
});
it('执行器被解除分配的歌曲照常完整同步，由同步把序列放回按钮页', async () => {
  useDocumentStore.getState().setProject(boundFirst({ assignment: 'unassigned' }), 'song.tblink');
  sync.mockImplementation(answer);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  expect(useMa2SyncStore.getState().songs.first).toBeDefined();
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(1); expect(check).not.toHaveBeenCalled();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
});
const answerOwn = (request: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> => {
  const sequence = request.binding!.sequence;
  return Promise.resolve({ binding: { ...request.binding!, baselineXml: `<synced-${sequence}/>`, points: request.points.map((point, index) => ({ id: point.id, cue: `${index + 1}.000` })) }, layout: null, backupFile: '', changed: true,
    library: { directory: { ...source, entries: [{ target: sequence, name: request.name }] }, readAt: new Date().toISOString(), sequences: [{ sequence, name: request.name, cues: request.points.map((_, index) => ({ index: index + 1, number: `${index + 1}.000`, name: '开场' })) }], fixtureUsage: [], errors: [] } });
};
function bothBound() {
  const value = boundFirst();
  value.rundown[1]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9001, name: 'second', executor: '1234.102', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-second', cue: '1.000' }] };
  return value;
}
it('已确认的歌：编辑器里打开的歌约 2 秒复查一次，其他歌 30 秒才复查一次', async () => {
  vi.useFakeTimers();
  useDocumentStore.getState().setProject(boundFirst(), 'song.tblink');
  sync.mockImplementation(answerOwn); check.mockResolvedValue(false);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  vi.advanceTimersByTime(2001); await tickMa2SongSync();
  expect(check).not.toHaveBeenCalled();
  vi.advanceTimersByTime(28000); await tickMa2SongSync();
  expect(check).toHaveBeenCalledTimes(1);
  useProgramSelectionStore.getState().set(useDocumentStore.getState().project!.projectId, 'first');
  vi.advanceTimersByTime(1000); await tickMa2SongSync();
  expect(check).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1001); await tickMa2SongSync();
  expect(check).toHaveBeenCalledTimes(2);
  expect(sync).toHaveBeenCalledTimes(1);
});
it('打开的歌先同步；复查别的歌时来了编辑，这一轮不再复查其余的歌，下一轮先同步这次编辑', async () => {
  vi.useFakeTimers();
  useDocumentStore.getState().setProject(bothBound(), 'song.tblink');
  useProgramSelectionStore.getState().set(useDocumentStore.getState().project!.projectId, 'second');
  sync.mockImplementation(answerOwn);
  await prepareMa2RealtimeSession();
  await tickMa2SongSync();
  expect(sync.mock.calls.map(call => (call[0] as Ma2SongSyncRequest).itemId)).toEqual(['second', 'first']);
  useProgramSelectionStore.getState().set(useDocumentStore.getState().project!.projectId, 'first');
  check.mockImplementation(() => {
    // The operator edits the other song while this one is being compared with the console.
    const lighting = structuredClone(useDocumentStore.getState().project!.rundown[1]!.lighting!);
    const event = lighting.tracks[0]!.clips[0]!.events[0]!;
    if (event.kind !== 'empty-cue' && event.kind !== 'ma2') throw new Error('fixture 应为 Cue 点');
    event.label = '开场改';
    useDocumentStore.getState().execute(setLightingCommand('second', lighting));
    markPendingMa2Songs();
    return Promise.resolve(false);
  });
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0]?.[0]).toMatchObject({ sequence: 9000 });
  expect(useMa2SyncStore.getState().songs.second?.state).toBe('pending');
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(3);
  expect(sync.mock.calls[2]?.[0]).toMatchObject({ itemId: 'second' });
});
it('一分钟内的连续编辑只存一次同步前存档，过了一分钟再编辑才存新档', async () => {
  vi.useFakeTimers();
  useDocumentStore.getState().setProject(boundFirst(), 'song.tblink');
  sync.mockImplementation(answerOwn);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(archive).toHaveBeenCalledTimes(1);
  const edit = (label: string): void => {
    const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
    const event = lighting.tracks[0]!.clips[0]!.events[0]!;
    if (event.kind !== 'empty-cue' && event.kind !== 'ma2') throw new Error('fixture 应为 Cue 点');
    event.label = label;
    useDocumentStore.getState().execute(setLightingCommand('first', lighting));
    markPendingMa2Songs();
  };
  edit('主歌'); vi.advanceTimersByTime(20000); await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(2); expect(archive).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(40001);
  edit('副歌'); await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(3); expect(archive).toHaveBeenCalledTimes(2);
});
it('有起始码的已确认歌曲：改别的歌不再把它标成待同步；在它复查时改它，复查完立即转为待同步', async () => {
  vi.useFakeTimers();
  const value = boundFirst();
  value.rundown[0]!.playback = { volume: 100, endAction: 'pause', startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  sync.mockImplementation(answerOwn); check.mockResolvedValue(false);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(sync.mock.calls[0]?.[0]).toMatchObject({ timecodeStartMs: 480_000 });
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  const edit = (itemId: string): void => {
    const index = useDocumentStore.getState().project!.rundown.findIndex(item => item.id === itemId);
    const lighting = structuredClone(useDocumentStore.getState().project!.rundown[index]!.lighting!);
    const event = lighting.tracks[0]!.clips[0]!.events[0]!;
    if (event.kind !== 'empty-cue' && event.kind !== 'ma2') throw new Error('fixture 应为 Cue 点');
    event.label = `${event.label}改`;
    useDocumentStore.getState().execute(setLightingCommand(itemId, lighting));
    markPendingMa2Songs();
  };
  // The comparison waits for an idle moment; run it now so the check below sees its answer.
  edit('second'); flushPendingMa2Songs();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  check.mockImplementation(() => { edit('first'); return Promise.resolve(false); });
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  expect(check).toHaveBeenCalledTimes(1);
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('pending');
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(2);
});
it('改了已确认的歌：编辑时间当下记下，待同步的比较排到空闲时；同步这一轮开始前一定先比较完', async () => {
  vi.useFakeTimers();
  useDocumentStore.getState().setProject(boundFirst(), 'song.tblink');
  sync.mockImplementation(answerOwn); check.mockResolvedValue(false);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  expect(useMa2SyncStore.getState().songs.first?.localEditedAt).toBeUndefined();
  const edit = (): void => {
    const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
    const event = lighting.tracks[0]!.clips[0]!.events[0]!;
    if (event.kind !== 'empty-cue' && event.kind !== 'ma2') throw new Error('fixture 应为 Cue 点');
    event.label = `${event.label}改`;
    useDocumentStore.getState().execute(setLightingCommand('first', lighting));
    markPendingMa2Songs();
  };
  edit();
  expect(useMa2SyncStore.getState().songs.first?.localEditedAt).toEqual(expect.any(Number));
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  vi.advanceTimersByTime(200);
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ state: 'pending', message: '修改已暂存，等待同步' });
  // Not yet compared when the pass starts: the pass compares first and syncs the edit.
  await tickMa2SongSync();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  edit();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(3);
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
});
it('回读后绑定没变但空 Cue 已有了控台编号：照样写回歌曲，下一轮只复查不再整首同步', async () => {
  vi.useFakeTimers();
  useDocumentStore.getState().setProject(boundFirst(), 'song.tblink');
  sync.mockImplementation(answer); check.mockResolvedValue(false);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  const event = useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!;
  expect(event).toMatchObject({ kind: 'ma2', sequence: 9000, cue: '1.000' });
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
});
it('同一同步连续失败 3 次后停下并写明原因，不再每隔几秒重试；编辑或点刷新同步后再试', async () => {
  vi.useFakeTimers();
  sync.mockRejectedValue(new Error('控台操作未完成：Sequence occupied'));
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  for (let attempt = 0; attempt < 6; attempt++) { await tickMa2SongSync(); vi.advanceTimersByTime(30001); }
  expect(sync).toHaveBeenCalledTimes(3);
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('blocked');
  expect(useMa2SyncStore.getState().songs.first?.message).toContain('Sequence occupied');
  expect(useMa2SyncStore.getState().songs.first?.message).toContain('刷新同步');
  refreshMa2RealtimeSession('first');
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(4);
  // Without an itemId every song is read again, a paused one included.
  refreshMa2RealtimeSession();
  expect(useMa2SyncStore.getState().songs.second?.state).toBe('pending');
});
it('刷新同步让已确认的歌重新完整核对控台，而不是只做复查', async () => {
  // Only the first song has lighting: the refresh's own session check must not start another song meanwhile.
  const value = boundFirst(); value.rundown[1]!.lighting!.tracks = [];
  useDocumentStore.getState().setProject(value, 'song.tblink');
  sync.mockImplementation(answer);
  await prepareMa2RealtimeSession();
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first']);
  await tickMa2SongSync();
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('verified');
  refreshMa2RealtimeSession('first');
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(2); expect(check).not.toHaveBeenCalled();
  expect(archive).toHaveBeenCalledTimes(1);
});
it('同步失败退避重试时同一份本地内容只存档一次，编辑后才存新档', async () => {
  vi.useFakeTimers();
  sync.mockRejectedValue(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(3); expect(archive).toHaveBeenCalledTimes(1);
  const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
  const event = lighting.tracks[0]!.clips[0]!.events[0]!;
  if (event.kind !== 'empty-cue') throw new Error('fixture 应为空 Cue');
  event.label = '开场改';
  useDocumentStore.getState().execute(setLightingCommand('first', lighting));
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(4);
  expect(archive).toHaveBeenCalledTimes(2);
});
it('没有起始码的歌连上控台就按控台节目分配起点，撤销也保留（否则撤销后会马上再分配，把要撤的修改挤掉），并带着起点同步', async () => {
  const value = project();
  value.rundown[0]!.referenceAudio = { assetId: 'audio', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 120_000 };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  // 控台节目从 600 s 起长 200 s：新歌从 810 s 开始。
  const ranges = vi.fn().mockResolvedValue({ show: 'Show', entries: [{ target: 1, name: 'A', offset: '18000', length: '6000', slot: 'TC Slot 2', frame: '30 FPS', last: '5940' }] });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog: catalog, readMa2EffectLibrary: metadata, cancelMa2Read: cancel, syncMa2Song: sync, checkMa2Song: check, renameMa2Object: rename, ma2TimecodeRanges: ranges } });
  sync.mockRejectedValue(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(ranges).toHaveBeenCalledExactlyOnceWith({ host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' });
  // Only the start: no end action of its own, so the song keeps following the player's 播放方式.
  expect(useDocumentStore.getState().project!.rundown[0]!.playback).toEqual({ volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 810_000, shortcut: '' });
  expect(sync.mock.calls[0]![0]).toMatchObject({ timecodeStartMs: 810_000, timecodeLengthMs: 120_000 });
  expect(useDocumentStore.getState().past).toHaveLength(0);
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project!.rundown[0]!.playback?.mtcOffsetMs).toBe(810_000);
});
it('还没加 Cue 的歌连上控台就分配 MTC 起点；没编灯、已配对的歌不动；分配失败显示原因、不挡其他歌，30 秒后再试', async () => {
  vi.useFakeTimers();
  const value = project();
  const audio = { assetId: 'audio', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 120_000 };
  value.rundown[0]!.referenceAudio = audio; value.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events = [];
  value.rundown.push({ id: 'plain', title: 'plain', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], referenceAudio: audio });
  useDocumentStore.getState().setProject(value, 'song.tblink');
  const ranges = vi.fn().mockRejectedValueOnce(new Error('MA2 响应超时')).mockResolvedValue({ show: 'Show', entries: [] });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog: catalog, readMa2EffectLibrary: metadata, cancelMa2Read: cancel, syncMa2Song: sync, checkMa2Song: check, renameMa2Object: rename, ma2TimecodeRanges: ranges } });
  expect(await prepareMa2RealtimeSession()).toBe(true);
  // The other song still enrolled; the failure is logged once and waits.
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['second']);
  expect(useMtcStartAllocationStore.getState().error).toBe('MA2 响应超时');
  expect(recordLog).toHaveBeenCalledWith(expect.objectContaining({ message: '分配 MTC 起点失败：MA2 响应超时' }));
  await prepareMa2RealtimeSession();
  expect(ranges).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_001);
  await prepareMa2RealtimeSession();
  expect(ranges).toHaveBeenCalledTimes(2);
  const songs = useDocumentStore.getState().project!.rundown;
  expect(songs.map(item => item.playback?.mtcOffsetMs)).toEqual([60_000, undefined, undefined]);
  expect(useMtcStartAllocationStore.getState().error).toBeNull();
  await prepareMa2RealtimeSession();
  expect(ranges).toHaveBeenCalledTimes(2);
});
it('连上控台时分配没成功的歌，首次同步前再分配一次，并按歌曲里实际写入的起点同步', async () => {
  const value = project();
  value.rundown[0]!.referenceAudio = { assetId: 'audio', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 120_000 };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  const ranges = vi.fn().mockRejectedValueOnce(new Error('MA2 响应超时')).mockResolvedValue({ show: 'Show', entries: [] });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog: catalog, readMa2EffectLibrary: metadata, cancelMa2Read: cancel, syncMa2Song: sync, checkMa2Song: check, renameMa2Object: rename, ma2TimecodeRanges: ranges } });
  sync.mockRejectedValue(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  expect(useDocumentStore.getState().project!.rundown[0]!.playback).toBeUndefined();
  await tickMa2SongSync();
  expect(ranges).toHaveBeenCalledTimes(2);
  expect(useDocumentStore.getState().project!.rundown[0]!.playback?.mtcOffsetMs).toBe(60_000);
  expect(sync.mock.calls[0]![0]).toMatchObject({ timecodeStartMs: 60_000 });
});
it('已同步过但还没有时间码节目的歌：列为「要同步到控台才能演出」，点击后重新完整同步并带上起始码', async () => {
  const value = project();
  value.rundown[0]!.playback = { volume: 100, endAction: 'pause', startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' };
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: 'Show', sequence: 9000, name: 'first', executor: '1000.101', layout: null, baselineXml: '<baseline/>', points: [] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  expect(songsWithoutConsoleShow(useDocumentStore.getState().project)).toEqual([{ itemId: 'first', title: 'first' }]);
  // Already checked in this session: a periodic check alone would not rewrite it.
  useMa2SyncStore.setState({ songs: { first: { sessionId: 'old', itemId: 'first', documentId: useDocumentStore.getState().documentId, name: 'first', settings: ma2SongSyncSettings(value, 'first'), state: 'verified', message: '',
    acknowledged: JSON.stringify([ma2SongPoints(value.rundown[0]!.lighting!), 'first', 480_000]), remoteRevision: 'a'.repeat(64) } } });
  sync.mockRejectedValue(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
  writeMissingConsoleShows(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(check).not.toHaveBeenCalled();
  expect((sync.mock.calls[0]![0] as Ma2SongSyncRequest).timecodeStartMs).toBe(480_000);
});
it('有本地修改的歌先同步，已确认歌曲的周期复查排在后面', async () => {
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  await prepareMa2RealtimeSession();
  const lighting = value.rundown[0]!.lighting!;
  const first = useMa2SyncStore.getState().songs.first!;
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, first: { ...first, state: 'verified', acknowledged: JSON.stringify([ma2SongPoints(lighting), 'first']), remoteRevision: 'a'.repeat(64) } } }));
  const order: string[] = [];
  check.mockImplementation(() => { order.push('check:first'); return Promise.resolve(false); });
  sync.mockImplementation((request: Ma2SongSyncRequest) => { order.push(`sync:${request.itemId}`); return Promise.reject(new Error('测试不写入')); });
  await tickMa2SongSync();
  expect(order).toEqual(['sync:second', 'check:first']);
});
it('复查发现控台变化后转入同步，期间显示同步中', async () => {
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point-first', cue: '1.000' }] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  const lighting = value.rundown[0]!.lighting!;
  const first = useMa2SyncStore.getState().songs.first!;
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, first: { ...first, state: 'verified', acknowledged: JSON.stringify([ma2SongPoints(lighting), 'first']), remoteRevision: 'a'.repeat(64) } } }));
  check.mockResolvedValue(true);
  const during: string[] = [];
  sync.mockImplementation(() => { during.push(useMa2SyncStore.getState().songs.first!.state); return Promise.reject(new Error('测试不写入')); });
  await tickMa2SongSync();
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
  await tickMa2SongSync();
  const song = () => useDocumentStore.getState().project!.rundown[0]!.lighting!;
  expect(song().consoleSong?.name).toBe('联动歌曲');
  expect(ma2SongPoints(song()).map(point => point.name)).toEqual(['开场']);
  check.mockResolvedValue(false);
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
  respond('Renamed On Console'); check.mockResolvedValue(true);
  vi.advanceTimersByTime(30001); await tickMa2SongSync();
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
  expect(useMa2SyncStore.getState().songs.first?.rewriteLegacyNames).toBeUndefined();
  expect(await convertMa2LegacyNames(useDocumentStore.getState().documentId)).toBe(2);
  expect(rename).not.toHaveBeenCalled();
  await tickMa2SongSync();
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
  expect(useMa2SyncStore.getState().songs).toEqual({});
});
it('播放中不启动目录扫描，不把读取被播放打断误报为同步故障', async () => {
  useShowStateStore.setState({ show: RUNNING });
  expect(await prepareMa2RealtimeSession()).toBe(false);
  expect(metadata).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  expect(useMa2SyncStore.getState().session.status).toBe('waiting');
});
it('暂停时照常核对控台、启动逐首同步（第 3 题）', async () => {
  useShowStateStore.setState({ show: HELD });
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']);
});
it('控台换了 IP：按编号认作同一台控台，素材来源跟过去，歌曲照常进入同步（2026-10-30）', async () => {
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.2', port: 30000, monitorPort: 30001, username: 'test' } });
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.source).toBe('192.0.2.2:30000');
  expect(useMa2SyncStore.getState().session.status).not.toBe('blocked');
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']);
  expect(recordLog.mock.calls.some(([entry]) => entry.level === 'info' && entry.message.includes('按编号接着同步'))).toBe(true);
});
it('会话检查偶发失败后，下一次核对成功即解除待核对，不需要手动按钮', async () => {
  vi.useFakeTimers();
  metadata.mockRejectedValueOnce(new Error('控台的 Show 或序列有变化，请重新读取'));
  expect(await prepareMa2RealtimeSession()).toBe(false);
  expect(useMa2SyncStore.getState().session).toMatchObject({ status: 'blocked', message: '控台的 Show 或序列有变化，请重新读取' });
  vi.advanceTimersByTime(1001);
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(useMa2SyncStore.getState().session.status).not.toBe('blocked');
  expect(useMa2SyncStore.getState().session.message).not.toContain('序列有变化');
});
it('会话检查持续失败时保持待核对，不来回跳也不重复写日志', async () => {
  vi.useFakeTimers();
  metadata.mockRejectedValue(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
  const statuses: string[] = [];
  const unsubscribe = useMa2SyncStore.subscribe(state => { if (statuses.at(-1) !== state.session.status) statuses.push(state.session.status); });
  try {
    await prepareMa2RealtimeSession();
    for (let attempt = 0; attempt < 3; attempt++) { vi.advanceTimersByTime(1001); await prepareMa2RealtimeSession(); }
  } finally { unsubscribe(); }
  expect(statuses).toEqual(['waiting', 'blocked']);
  expect(recordLog).toHaveBeenCalledTimes(1);
});
it('歌曲自己的同步失败不会被会话检查成功清掉', async () => {
  vi.useFakeTimers();
  await prepareMa2RealtimeSession();
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, first: { ...state.songs.first!, state: 'blocked', message: 'Timecode 1 有 1 处冲突', blockedRevision: 0 } } }));
  vi.advanceTimersByTime(5001);
  await prepareMa2RealtimeSession();
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ state: 'blocked', message: 'Timecode 1 有 1 处冲突' });
  expect(useMa2SyncStore.getState().session.status).toBe('ready');
});
it('控台上已有时间码的歌（方式 1）也进入同一个逐首同步，和新歌一样', async () => {
  const value = project();
  const preview = { name: 'TC', readAt: new Date().toISOString(), sourceXml: '<MA/>' };
  value.rundown[0]!.lighting!.ma2Bindings = [{ id: 'bound', timecode: 9901, ...preview, baselineTracks: [], mappings: [], trackMappings: [] }];
  useDocumentStore.getState().setProject(value, 'song.tblink');
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']);
  expect(catalog).not.toHaveBeenCalled();
  expect(pendingSongSummary(useDocumentStore.getState().project).map(item => item.itemId)).toEqual(['second']);
});
it('桥重启后先核对同一 Show 的新 generation，再续接原歌曲，不反复读整曲', async () => {
  vi.useFakeTimers();
  await prepareMa2RealtimeSession();
  const sessions = Object.fromEntries(Object.entries(useMa2SyncStore.getState().songs).map(([key, song]) => [key, song.sessionId]));
  metadata.mockResolvedValue({ ...project().ma2MaterialLibrary!.library, directory: { ...source, generation: 'restarted-bridge', entries: [] } });
  await prepareMa2RealtimeSession();
  expect(metadata).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5001);
  expect(await prepareMa2RealtimeSession()).toBe(true);
  expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.library?.directory.generation).toBe('restarted-bridge');
  expect(Object.fromEntries(Object.entries(useMa2SyncStore.getState().songs).map(([key, song]) => [key, song.sessionId]))).toEqual(sessions);
  expect(catalog).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
});
it('控台上 Show 另存了新名字（或重启后打开）：不用重新读取，素材和歌曲的控台位置跟着改名，照常同步（2026-10-30）', async () => {
  const value = project();
  value.rundown[0]!.lighting!.consoleSong = { endpoint: '192.0.2.1:30000', show: source.show, layout: null, executor: '1000.101', sequence: 9000, name: 'first', baselineXml: '<MA/>', points: [] };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  metadata.mockResolvedValue({ ...value.ma2MaterialLibrary!.library, directory: { ...source, show: 'Show 10.28', generation: 'other', entries: [{ target: 9000, name: 'first' }] } });
  expect(await prepareMa2RealtimeSession()).toBe(true);
  const after = useDocumentStore.getState().project!;
  expect(after.ma2MaterialLibrary?.library?.directory.show).toBe('Show 10.28');
  expect(after.rundown[0]!.lighting!.consoleSong).toMatchObject({ show: 'Show 10.28', sequence: 9000 });
  expect(useMa2SyncStore.getState().session.status).not.toBe('blocked');
  expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']);
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
  expect(useMa2SyncStore.getState().songs).toEqual({});
});
it('暂停持久化并取消在途任务，下一轮不会重新开启', async () => {
  await prepareMa2RealtimeSession();
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, first: { ...state.songs.first!, requestId: 'task-in-flight', state: 'syncing' } } }));
  pauseMa2RealtimeSession(); await prepareMa2RealtimeSession();
  expect(storage.get('tblink.ma2-realtime-enabled.v1')).toBe('false');
  expect(cancel).toHaveBeenCalledExactlyOnceWith('task-in-flight');
  expect(Object.values(useMa2SyncStore.getState().songs).every(song => song.state === 'paused')).toBe(true);
});
it('手动发起本曲同步不会被首次会话初始化清掉', async () => {
  const value = useDocumentStore.getState().project!;
  startMa2SongSync('first', '自定义名称', ma2SongSyncSettings(value, 'first'));
  const sessionId = useMa2SyncStore.getState().songs.first?.sessionId;
  await prepareMa2RealtimeSession();
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ sessionId, name: '自定义名称' });
});
it('人工重新核对时恢复暂停歌曲，仍在取消中的歌曲不会并发重发', async () => {
  await prepareMa2RealtimeSession(); pauseMa2RealtimeSession();
  useMa2SyncStore.setState(state => ({ songs: { ...state.songs, first: { ...state.songs.first!, requestId: 'still-running' } } }));
  retryMa2RealtimeSession();
  await vi.waitFor(() => expect(useMa2SyncStore.getState().songs.second?.state).toBe('pending'));
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('paused');
  expect(useMa2RealtimePreference.getState().enabled).toBe(true);
});
it('断线后进入等待，保持待同步修改且不尝试写控台', async () => {
  await prepareMa2RealtimeSession();
  status.mockResolvedValue({ state: 'disconnected' });
  await tickMa2SongSync();
  expect(Object.values(useMa2SyncStore.getState().songs).every(song => song.state === 'pending' && song.waitingForConnection)).toBe(true);
  expect(archive).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
});
it('开始播放中断写入时保留待同步状态，不把歌曲永久锁住', async () => {
  await prepareMa2RealtimeSession();
  stopMa2SongSync('second');
  sync.mockImplementationOnce(() => {
    useShowStateStore.setState({ show: RUNNING });
    return Promise.reject(new Error('播放已开始，后续步骤未发送'));
  });
  await tickMa2SongSync();
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ state: 'pending', requestId: null });
  expect(useMa2SyncStore.getState().songs.first?.message).toContain(SHOW_WAIT_CLOCK_MOVING);
});
it('存档期间暂停也会取消尚未发出的同步，不会在暂停后偷偷写入', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  let finish: (value: string) => void = () => { throw new Error('archive not started'); };
  archive.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const tick = tickMa2SongSync();
  await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
  stopMa2SongSync('first'); finish('C:/archive.tblink'); await tick;
  expect(sync).not.toHaveBeenCalled(); expect(useMa2SyncStore.getState().songs.first?.state).toBe('paused');
});
it('等待连接查询时改为 MIDI，不继续存档或发送网络同步', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  let finish: (value: unknown) => void = () => { throw new Error('status not started'); };
  status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const before = status.mock.calls.length;
  const tick = tickMa2SongSync();
  await vi.waitFor(() => expect(status.mock.calls.length).toBe(before + 1));
  storage.set('tblink.ma2-connection-method.v1', 'midi');
  finish({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  await tick;
  expect(sync).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
});
it('同曲开始新会话后，旧会话迟到回包不改工程或新会话状态', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  let finish: (value: unknown) => void = () => { throw new Error('sync not started'); };
  sync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const tick = tickMa2SongSync();
  await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
  const before = useDocumentStore.getState();
  startMa2SongSync('first', '新会话', ma2SongSyncSettings(before.project!, 'first'));
  const sessionId = useMa2SyncStore.getState().songs.first!.sessionId;
  finish({ binding: { sequence: 9000 }, changed: true }); await tick;
  expect(useDocumentStore.getState().revision).toBe(before.revision);
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ sessionId, name: '新会话', state: 'pending' });
});
it('存档过程中开始播放时暂不写控台，停止后保留原队列', async () => {
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  archive.mockImplementationOnce(() => { useShowStateStore.setState({ show: RUNNING }); return Promise.resolve('C:/archive.tblink'); });
  await tickMa2SongSync();
  expect(sync).not.toHaveBeenCalled();
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ state: 'pending' });
});

it('只手动同步：关掉实时同步后点“同步一次”，按选的同步方式每首歌同步一次，之后实时同步还是关着（2026-11-04）', async () => {
  useDocumentStore.getState().setProject(bothBound(), 'song.tblink');
  sync.mockImplementation(answerOwn); check.mockResolvedValue(false);
  pauseMa2RealtimeSession();
  expect(await prepareMa2RealtimeSession()).toBe(false);
  setMa2WriteMode('direct'); setMa2ConsoleChanges('software');
  expect(storage.get('tblink.ma2-write-mode.v1')).toBe('direct');
  syncMa2Once();
  await vi.waitFor(() => expect(Object.keys(useMa2SyncStore.getState().songs)).toEqual(['first', 'second']));
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(2);
  expect(sync.mock.calls.map(call => call[0] as Ma2SongSyncRequest)).toEqual([expect.objectContaining({ writeMode: 'direct', consoleChanges: 'software' }), expect.objectContaining({ writeMode: 'direct', consoleChanges: 'software' })]);
  expect(useMa2RealtimePreference.getState()).toMatchObject({ enabled: false, once: null });
  expect(Object.values(useMa2SyncStore.getState().songs).map(song => song.state)).toEqual(['verified', 'verified']);
  // An edit afterwards waits for the next 同步一次.
  const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
  const event = lighting.tracks[0]!.clips[0]!.events[0]!;
  if (event.kind !== 'empty-cue' && event.kind !== 'ma2') throw new Error('fixture 应为 Cue 点');
  event.label = '改过';
  useDocumentStore.getState().execute(setLightingCommand('first', lighting)); markPendingMa2Songs();
  expect(await prepareMa2RealtimeSession()).toBe(false);
  await tickMa2SongSync();
  expect(sync).toHaveBeenCalledTimes(2);
  expect(useMa2SyncStore.getState().songs.first?.state).toBe('pending');
});
it('同步一次时控台没连上：一直等到连上再同步，不算结束；暂停可以取消（2026-11-04）', async () => {
  pauseMa2RealtimeSession();
  status.mockResolvedValue({ state: 'disconnected' });
  syncMa2Once();
  await vi.waitFor(() => expect(useMa2SyncStore.getState().session.message).toContain('等待控台连接'));
  expect(useMa2RealtimePreference.getState().once).not.toBeNull();
  pauseMa2RealtimeSession();
  expect(useMa2RealtimePreference.getState()).toMatchObject({ enabled: false, once: null });
});
it('改了同步方式：每首歌下次同步时完整读一遍控台，按新的方式检查（2026-11-04）', async () => {
  useDocumentStore.getState().setProject(boundFirst(), 'song.tblink');
  sync.mockImplementation(answerOwn); check.mockResolvedValue(false);
  await prepareMa2RealtimeSession(); stopMa2SongSync('second');
  await tickMa2SongSync();
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ state: 'verified' });
  setMa2WriteMode('overwrite'); recheckMa2Songs();
  expect(useMa2SyncStore.getState().songs.first).toMatchObject({ state: 'pending', remoteRevision: undefined });
  await tickMa2SongSync();
  expect(check).not.toHaveBeenCalled();
  expect(sync).toHaveBeenCalledTimes(2);
  expect(sync.mock.calls[1]?.[0]).toMatchObject({ writeMode: 'overwrite', consoleChanges: 'read-back' });
});
