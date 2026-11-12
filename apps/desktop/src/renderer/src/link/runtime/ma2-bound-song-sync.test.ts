import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type LinkProject, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2CompareRequest, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
import { importMa2TimecodeCommand, ma2PendingChanges, padSongCommand, padSongRender, setLightingCommand, SHOW_WAIT_CLOCK_MOVING, type Ma2SyncPreview } from '@tb/core/link';
import { convertMa2Snapshot, convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2OnpcBridge } from '../../../../main/link/ma2-onpc-bridge';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { inspectMa2TimecodeXml, patchMa2EventTimes, sameMa2XmlObjects } from '../../../../main/link/ma2-timecode-xml';
import { useDocumentStore } from '../stores/document-store';
import { ma2ConsoleWriting, useMa2SyncStore } from '../stores/ma2-sync-store';
import { useShowStateStore } from '../stores/show-state-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { markPendingMa2Songs, ma2SongSyncSettings, startMa2SongSync, stopMa2SongSync, takeMa2SongFromConsole, tickMa2SongSync, writeMa2SongFromSoftware } from './ma2-song-sync';
import { readMa2ShowNow } from './ma2-console-version';
import { syncBoundSong } from './ma2-bound-song-sync';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from '../../../../main/link/ma2-event-write';
import { showStopped } from '../../../../main/link/fixtures/show-gates';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));
const { recordLog } = vi.hoisted(() => ({ recordLog: vi.fn<(entry: { level: string; message: string }) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog } }));

const xml = await readFile(new URL('../../../../main/link/fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('../../../../main/link/fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const preview = convertMa2Timecode(xml, [sequence], 9902);
const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' };
const library = (show = 'Test') => ({ directory: { show, generation: 'session', version: '3.3.4', entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] });

/** The console writes what it was asked to and reads it back as the apply service confirms it. */
const confirmWrite = (request: Ma2ApplyRequest): Promise<Ma2ApplyResult> => {
  const prepared = prepareMa2MergedEvents(request.document, request.bindingId, request.readback, new Map(request.conflicts), [sequence], request.timeAlignment, request.consoleChanges);
  return Promise.resolve({ status: 'verified', confirmed: confirmMa2MergedEvents(prepared, prepared.desiredXml, [sequence]), backupFile: 'backup.xml' });
};
/** `song` is way 1 (bound to the console's Timecode 9902); `own`, when asked for, is way 2 (its own Sequence 9000). */
function project(own = false, source = preview): LinkProject {
  let value = createEmptyLinkProject('同步测试');
  value.schemaVersion = 2;
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  value = importMa2TimecodeCommand('song', source).execute(value);
  value.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: library() };
  if (own) {
    const lighting = createLightingDocument();
    lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: 'Test', sequence: 9000, name: '新歌', executor: '1000.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'own-point', cue: '1.000' }] };
    lighting.tracks = [{ id: 'own-track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: 'own-clip', name: '编排', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'own-point', kind: 'empty-cue', at: 0, label: '开场', runMode: 'independent' }] }] }];
    value.rundown.push({ id: 'own', title: '新歌', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting });
  }
  return value;
}
const status = vi.fn(), previewMa2 = vi.fn(), compareMa2 = vi.fn<(request: Ma2CompareRequest) => Promise<Ma2SyncPreview>>(), applyMa2 = vi.fn<(request: Ma2ApplyRequest) => Promise<Ma2ApplyResult>>(), syncMa2Song = vi.fn<(request: Ma2SongSyncRequest) => Promise<Ma2SongSyncResult>>();
let unsubscribe = (): void => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'tblink.ma2-connection-method.v1' ? 'network' : null, setItem: () => undefined });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, previewMa2, compareMa2, applyMa2, syncMa2Song, cancelMa2Read: () => Promise.resolve() } });
  status.mockResolvedValue({ state: 'connected', settings: { ...network, autoConnect: false } });
  previewMa2.mockResolvedValue(preview);
  compareMa2.mockImplementation(request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, request.consoleChanges)));
  applyMa2.mockResolvedValue({ status: 'incomplete', stage: 'write', message: '写入结果未知', mayHaveWritten: true, backupFile: 'backup.xml' });
  archive.mockResolvedValue('C:/archive.tblink');
  useMa2RealtimePreference.setState({ enabled: true, once: null, writeMode: 'merge', consoleChanges: 'read-back' });
  useMa2SyncStore.setState({ songs: {}, names: { state: 'idle', message: '' }, previewPlaying: false });
  useShowStateStore.setState({ show: IDLE });
  useDocumentStore.getState().setProject(project(), 'song.tblink');
  unsubscribe = useDocumentStore.subscribe((state, previous) => { if (state.project !== previous.project) markPendingMa2Songs(); });
});
afterEach(() => { unsubscribe(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const start = (itemId = 'song') => startMa2SongSync(itemId, itemId, ma2SongSyncSettings(useDocumentStore.getState().project!, itemId));
const tick = () => tickMa2SongSync();
/** The show as main reports it (useShowStateStore): idle, the program moving, or paused (held). */
const RUNNING = { phase: 'running', source: 'internal', itemId: 'song', program: null } as const;
const HELD = { phase: 'held', source: 'internal', itemId: 'song', reason: 'paused', program: null } as const;
const IDLE = { phase: 'idle', program: null } as const;

const song = (itemId = 'song') => useMa2SyncStore.getState().songs[itemId]!;
const edit = (at = 1000) => {
  const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
  lighting.tracks[0]!.clips[0]!.events[0]!.at = at;
  useDocumentStore.getState().execute(setLightingCommand('song', lighting, '修改灯光位置'));
};

it('没有修改的歌：读一次控台核对一致就停下，不写控台、不制造撤销历史，下一轮不再重读', async () => {
  start(); await tick(); await tick();
  expect(previewMa2).toHaveBeenCalledOnce(); expect(applyMa2).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().past).toEqual([]);
  expect(song()).toMatchObject({ state: 'verified', message: 'Timecode 9902 和控台一致' });
});
it('写入结果不确定时停下，不自动重试；修改留在本地，说明可能已写入和备份位置', async () => {
  start(); edit(); await tick(); await tick();
  expect(applyMa2).toHaveBeenCalledOnce();
  expect(song()).toMatchObject({ state: 'blocked', consecutiveFailures: 1 });
  expect(song().message).toContain('控台可能已经写入'); expect(song().message).toContain('backup.xml'); expect(song().message).toContain('刷新同步');
});
// 2026-11-10 现场：每次编辑都重试一次又失败，红字和运行日志各一条，叠到“连续 15 次同步失败，已停止自动重试”，可编辑时其实还在重试。
it('同一个原因的失败只报一次：编辑后重试又是同样的原因，不再写日志、不再弹；原因变了或成功过才再报；文字说的是真的', async () => {
  const errors = () => recordLog.mock.calls.filter(([entry]) => entry.level === 'error').map(([entry]) => entry.message);
  start(); edit(1000); await tick();
  expect(song().state).toBe('blocked'); expect(song().announcedFailure).toContain('写入结果未知');
  expect(song().message).toBe('同步没成功：写入结果未知；控台可能已经写入；备份：backup.xml。改动还留在联动台，下次改动或点“刷新同步”时再试；也可以在「同步状态详情」里选“用控台上的”或“用联动台的”');
  expect(errors()).toHaveLength(1);
  edit(1100); await tick(); edit(1200); await tick();
  expect(applyMa2).toHaveBeenCalledTimes(3);
  expect(errors()).toHaveLength(1);
  expect(song().message).not.toMatch(/已停止自动重试|连续/);
  applyMa2.mockResolvedValue({ status: 'incomplete', stage: 'read', message: '控台没有回答', mayHaveWritten: false, backupFile: null });
  edit(1300); await tick();
  expect(errors()).toHaveLength(2); expect(song().announcedFailure).toBe('控台没有回答');
  // Once the song synced, the same failure as before is news again.
  applyMa2.mockImplementation(confirmWrite); edit(1400); await tick();
  expect(song()).toMatchObject({ state: 'verified', announcedFailure: undefined, loggedFailure: undefined });
  applyMa2.mockResolvedValue({ status: 'incomplete', stage: 'read', message: '控台没有回答', mayHaveWritten: false, backupFile: null });
  edit(1500); await tick();
  expect(errors()).toHaveLength(3);
});
it('实时同步关着时，失败的文字说点“同步一次”再试', async () => {
  useMa2RealtimePreference.setState({ enabled: false, once: Date.now() });
  start(); edit(); await tick();
  expect(song().message).toContain('点“同步一次”时再试'); expect(song().message).not.toContain('刷新同步');
});
it('失败停下后再编辑会再试一次；一分钟内只存一次同步前存档，过了一分钟再编辑才存新档', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  start(); edit(1000); await tick();
  edit(1100); await tick();
  expect(applyMa2).toHaveBeenCalledTimes(2); expect(archive).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 61_000);
  edit(1200); await tick();
  expect(applyMa2).toHaveBeenCalledTimes(3); expect(archive).toHaveBeenCalledTimes(2);
});
it('播放期间不读取也不写入，修改先存着；停止后再同步', async () => {
  start(); edit(); useShowStateStore.setState({ show: RUNNING }); await tick();
  expect(status).not.toHaveBeenCalled(); expect(previewMa2).not.toHaveBeenCalled(); expect(applyMa2).not.toHaveBeenCalled();
  expect(song().state).toBe('pending'); expect(song().message).toContain(SHOW_WAIT_CLOCK_MOVING);
  useShowStateStore.setState({ show: IDLE }); await tick();
  expect(applyMa2).toHaveBeenCalledOnce();
});
// 2026-11-10 第 3 题（S3b）：只有节目在走时才挡；暂停、播完停住、P1 等下一首时照常同步。
it('联动台播放暂停时照常同步：定时同步读控台、写入并确认', async () => {
  start(); edit(); useShowStateStore.setState({ show: HELD }); await tick();
  expect(previewMa2).toHaveBeenCalled(); expect(applyMa2).toHaveBeenCalledOnce();
  useShowStateStore.setState({ show: { phase: 'held', source: 'p1', itemId: null, reason: 'p1-waiting', program: null } });
  applyMa2.mockImplementation(confirmWrite); edit(1100); await tick();
  expect(applyMa2).toHaveBeenCalledTimes(2); expect(song().state).toBe('verified');
});
it('同步到一半节目走起来：停在当前一步，不算失败、不写日志；回到暂停后接着做', async () => {
  const errors = () => recordLog.mock.calls.filter(([entry]) => entry.level === 'error');
  applyMa2.mockImplementation(confirmWrite);
  start(); edit();
  previewMa2.mockImplementationOnce(() => { useShowStateStore.setState({ show: RUNNING }); return Promise.resolve(preview); });
  await tick();
  expect(previewMa2).toHaveBeenCalledOnce(); expect(applyMa2).not.toHaveBeenCalled();
  expect(song()).toMatchObject({ state: 'pending', checking: false, writing: false });
  expect(song().message).toContain(SHOW_WAIT_CLOCK_MOVING);
  expect(song().consecutiveFailures ?? 0).toBe(0); expect(errors()).toHaveLength(0);
  await tick(); expect(previewMa2).toHaveBeenCalledOnce();
  useShowStateStore.setState({ show: HELD }); await tick();
  expect(applyMa2).toHaveBeenCalledOnce(); expect(song().state).toBe('verified');
});
it('界面镜像慢一拍、主进程按节目在走拒绝：记成等待，不算失败、不标红、不写日志', async () => {
  const errors = () => recordLog.mock.calls.filter(([entry]) => entry.level === 'error');
  start(); edit();
  applyMa2.mockRejectedValueOnce(new Error(`Error invoking remote method 'link:ma2-apply': Error: ${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再同步控台。`));
  await tick();
  expect(song()).toMatchObject({ state: 'pending', consecutiveFailures: 0 });
  expect(song().announcedFailure).toBeUndefined(); expect(song().loggedFailure).toBeUndefined();
  expect(song().message).toBe(`${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再同步控台。`);
  expect(errors()).toHaveLength(0);
  applyMa2.mockImplementation(confirmWrite); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001);
  await tick();
  expect(applyMa2).toHaveBeenCalledTimes(2); expect(song().state).toBe('verified');
});
it('歌曲 MTC 起始码改了以后，本地拖动先留在联动台，不写到控台；歌曲照常可播', async () => {
  const value = project();
  value.rundown[0]!.playback = { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: (value.rundown[0]!.lighting!.ma2Bindings![0]!.timeOriginMs ?? 0) + 5000, shortcut: '' };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  start(); edit(); await tick(); await tick();
  expect(previewMa2).not.toHaveBeenCalled(); expect(applyMa2).not.toHaveBeenCalled();
  expect(song().state).toBe('pending'); expect(song().message).toContain('Cue 是按起点');
});
it('音源或长度变化的既有绑定起点未变时，仍先核对三方基线再同步；起点改了才把修改留在本地', async () => {
  const value = project();
  value.rundown[0]!.referenceAudio = { assetId: 'audio', relativePath: 'audio.wav', sha256: 'a'.repeat(64), durationMs: 33000 };
  value.rundown[0]!.playback = { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  start(); edit(); await tick();
  expect(previewMa2).toHaveBeenCalledOnce(); expect(compareMa2).toHaveBeenCalledOnce(); expect(applyMa2).toHaveBeenCalledOnce();
  const moved = structuredClone(useDocumentStore.getState().project!);
  moved.rundown[0]!.playback!.mtcOffsetMs = 3600000;
  useDocumentStore.getState().setProject(moved, 'song.tblink');
  vi.clearAllMocks(); start(); await tick();
  expect(previewMa2).not.toHaveBeenCalled(); expect(applyMa2).not.toHaveBeenCalled();
  expect(song().state).toBe('pending'); expect(song().message).toContain('歌曲现在从 01:00:00:00 开始');
});
it('暂停同步不能提前释放已经发出的写入：等控台答复，失败照实写明，之后不再发', async () => {
  start(); edit();
  let rejectWrite: ((reason: Error) => void) | undefined;
  applyMa2.mockImplementation(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
  const operation = tick();
  await vi.waitFor(() => expect(applyMa2).toHaveBeenCalledOnce());
  stopMa2SongSync('song');
  expect(ma2ConsoleWriting()).toBe(true);
  rejectWrite!(new Error('写入超时')); await operation;
  expect(ma2ConsoleWriting()).toBe(false);
  expect(song().state).toBe('paused'); expect(song().message).toContain('写入超时');
  await tick(); expect(applyMa2).toHaveBeenCalledOnce();
});
it('控台 Show 另存了新名字、又新建了时间码节目：照常读回并写入，不停下（2026-10-30）', async () => {
  const value = project();
  value.ma2MaterialLibrary!.library = { ...library('Test 10.28'), directory: { ...library('Test 10.28').directory, entries: [{ target: 9903, name: '新歌' }] } };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  applyMa2.mockImplementation(confirmWrite);
  start(); edit(); await tick();
  expect(previewMa2).toHaveBeenCalledOnce(); expect(applyMa2).toHaveBeenCalledOnce();
  expect(song()).toMatchObject({ state: 'verified', message: 'Timecode 9902 已写入控台并回读确认' });
});
// 2026-11-11 用户：“矛盾的时候采用最新的”，取代 2026-10-26 的“以联动台为准”（控台上的改动选“读回联动台”时）。
// 联动台的改动按改的时间算，控台的改动按联动台第一次看到它的时间算；同步照样不停下来等人选。
const consoleMoved = () => convertMa2Timecode(xml.replace('<Event index="0"', '<Event time="15" index="0"'), [sequence], 9902);
const messagesOf = async (run: () => Promise<void>): Promise<string[]> => {
  const messages: string[] = [];
  const listen = useMa2SyncStore.subscribe(state => { const message = state.songs.song?.message; if (message && messages.at(-1) !== message) messages.push(message); });
  try { await run(); } finally { listen(); }
  return messages;
};
it('同一项两边都改过、控台上的改动是后看到的：用控台的，同步不停下来等人选，写明用了哪边（2026-11-11）', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000);
  previewMa2.mockResolvedValue(consoleMoved()); applyMa2.mockImplementation(confirmWrite);
  const messages = await messagesOf(async () => { start(); edit(); vi.setSystemTime(1_002_000); await tick(); });
  const request = applyMa2.mock.calls[0]?.[0];
  expect(request?.conflicts.length).toBeGreaterThan(0); expect(request?.conflicts.every(([, side]) => side === 'remote')).toBe(true);
  expect(messages.some(message => message.includes('有 1 处两边都改过，按最新的用了控台上的'))).toBe(true);
  expect(song()).toMatchObject({ state: 'verified' }); expect(song().message).toContain('按最新的用了控台上的');
  expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at).toBe(500);
});
it('同一项两边都改过、联动台是在看到控台改动之后才改的：用联动台的（2026-11-11）', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000);
  previewMa2.mockResolvedValue(consoleMoved());
  // The first pass sees the console's move; its write does not complete, so nothing is confirmed.
  start(); await tick();
  expect(song().state).toBe('blocked');
  vi.setSystemTime(1_005_000); applyMa2.mockImplementation(confirmWrite);
  const messages = await messagesOf(async () => { edit(); await tick(); });
  const request = applyMa2.mock.calls[1]?.[0];
  expect(request?.conflicts.length).toBeGreaterThan(0); expect(request?.conflicts.every(([, side]) => side === 'local')).toBe(true);
  expect(messages.some(message => message.includes('按最新的用了联动台上的'))).toBe(true);
  expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at).toBe(1000);
});
it('同一项两边都改过、联动台的改动不知道是什么时候改的（重启后从文件打开）：算更早，用控台的（2026-11-11）', async () => {
  const value = project();
  value.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at = 1000;
  useDocumentStore.getState().setProject(value, 'song.tblink');
  previewMa2.mockResolvedValue(consoleMoved()); applyMa2.mockImplementation(confirmWrite);
  start(); await tick();
  expect(applyMa2.mock.calls[0]?.[0].conflicts.every(([, side]) => side === 'remote')).toBe(true);
  expect(song().message).toContain('按最新的用了控台上的');
});
it('选了以联动台为准：两边都改过的点照旧用联动台的（2026-11-04 的选项不变）', async () => {
  useMa2RealtimePreference.setState({ consoleChanges: 'software' });
  previewMa2.mockResolvedValue(consoleMoved());
  start(); edit(); await tick();
  expect(applyMa2.mock.calls[0]?.[0].conflicts.every(([, side]) => side === 'local')).toBe(true);
});
it('控台上挪了点、联动台没改：默认读回联动台；选了以联动台为准就按联动台写回控台（2026-11-04）', async () => {
  previewMa2.mockResolvedValue(convertMa2Timecode(xml.replace('<Event index="0"', '<Event time="15" index="0"'), [sequence], 9902));
  const previews: Ma2SyncPreview[] = [];
  compareMa2.mockImplementation(request => { const value = compareMa2LightingReadback(request.document, request.bindingId, request.readback, request.consoleChanges); previews.push(value); return Promise.resolve(value); });
  start(); await tick();
  expect(applyMa2.mock.calls[0]?.[0]).toMatchObject({ consoleChanges: 'read-back', conflicts: [] });
  const preview = previews[0]!;
  useMa2SyncStore.setState({ songs: {} }); applyMa2.mockClear();
  useMa2RealtimePreference.setState({ consoleChanges: 'software' });
  start(); await tick();
  expect(applyMa2.mock.calls[0]?.[0]).toMatchObject({ consoleChanges: 'software', conflicts: [] });
  const written = previews[1]!;
  // Read back, the merge takes the console's time; written over, it keeps the timeline's.
  const events = (objects: Ma2SyncPreview['merged']) => objects.filter(object => object.kind === 'event').sort((a, b) => a.id.localeCompare(b.id));
  expect(events(preview.merged)).toEqual(events(preview.remote.objects));
  expect(events(written.merged)).toEqual(events(written.local.objects));
  expect(events(written.merged)).not.toEqual(events(preview.merged));
});
it('同一条控台时间线绑定在两首歌上：两首都不自动写，写明是哪两首', async () => {
  const value = project();
  value.rundown.push({ ...structuredClone(value.rundown[0]!), id: 'copy', title: '翻唱' });
  useDocumentStore.getState().setProject(value, 'song.tblink');
  start(); edit(); await tick();
  expect(previewMa2).not.toHaveBeenCalled(); expect(applyMa2).not.toHaveBeenCalled();
  expect(song().state).toBe('blocked'); expect(song().message).toContain('“翻唱”');
});
it('两种方式的歌走同一个同步：方式 1 的歌失败停下，不挡方式 2 的歌照常写到控台', async () => {
  useDocumentStore.getState().setProject(project(true), 'song.tblink');
  syncMa2Song.mockImplementation(request => Promise.resolve({ binding: { ...request.binding!, baselineXml: '<synced/>', points: request.points.map((point, index) => ({ id: point.id, cue: `${index + 1}.000` })) },
    layout: null, backupFile: '', changed: true, library: { ...library(), sequences: [{ sequence: 9000, name: request.name, cues: request.points.map((_, index) => ({ index: index + 1, number: `${index + 1}.000`, name: '开场' })) }] } }));
  start(); start('own'); edit(); await tick();
  expect(song()).toMatchObject({ state: 'blocked' });
  expect(syncMa2Song).toHaveBeenCalledOnce();
  expect(song('own')).toMatchObject({ state: 'verified' });
  expect(useDocumentStore.getState().project!.rundown[1]!.lighting!.consoleSong).toMatchObject({ sequence: 9000, executor: '1000.101', baselineXml: '<synced/>' });
});
it('断线时方式 1 的歌等待连接，不算一次失败；连上后接着同步', async () => {
  status.mockResolvedValue({ state: 'disconnected' });
  start(); edit(); await tick();
  expect(song()).toMatchObject({ state: 'pending', waitingForConnection: true });
  expect(song().consecutiveFailures ?? 0).toBe(0); expect(previewMa2).not.toHaveBeenCalled();
  status.mockResolvedValue({ state: 'connected', settings: { ...network, autoConnect: false } });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001);
  await tick();
  expect(applyMa2).toHaveBeenCalledOnce();
});

/** The fixture's show with its first Cue fired at each of `ticks` (30 FPS) and its second Cue at 45. */
function repeated(ticks: readonly number[]): string {
  // \r?\n: a Windows checkout gives the fixture CRLF line ends.
  const events = [...xml.matchAll(/\t*<Event [\s\S]*?<\/Event>\r?\n/g)].map(match => match[0]);
  const first = events[0]!.replace(/<Event index="0"/, '<Event index="X" time="T"');
  const shows = [...ticks.map(time => ({ time, block: first.replace('time="T"', `time="${time}"`) })), { time: 45, block: events[1]! }].sort((a, b) => a.time - b.time);
  return xml.replace(events.join(''), shows.map((entry, index) => entry.block.replace(/<Event index="[^"]*"/, `<Event index="${index}"`)).join(''));
}
const eventTimes = (tracks: LightingTrack[]): number[] => tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => clip.start + event.at))).sort((a, b) => a - b);
// 2026-11-10 现场（natural.mp4，Timecode 63）：控台上改了一个触发两次的 Cue，联动台每次同步都报“对不上，请在手动同步中确认”。
// 2026-11-11 用户：“我要的是软件能实时同步控台做出的修改”。同一个 Cue 的几次触发自动配对，不让人确认。
it.each([
  ['挪了其中一次', [0, 90], [0, 120]],
  ['两次都挪了', [0, 90], [15, 120]],
  ['删了一次、挪了另一次', [0, 90], [120]],
  ['加了一次', [0, 90], [0, 90, 150]],
  ['三次触发挪了中间一次', [0, 90, 150], [0, 105, 150]],
  ['两边次数不同', [0, 90, 150], [30, 160]]
])('同一个 Cue 触发多次、控台上%s：同步不报错，控台上的时间进到歌里', async (_name, before, after) => {
  const base = convertMa2Timecode(repeated(before), [sequence], 9902);
  const remote = convertMa2Timecode(repeated(after), [sequence], 9902);
  useDocumentStore.getState().setProject(project(false, base), 'song.tblink');
  previewMa2.mockResolvedValue(remote); applyMa2.mockImplementation(confirmWrite);
  start(); await tick();
  expect(song()).toMatchObject({ state: 'verified' });
  const songTimes = eventTimes(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks);
  expect(songTimes).toEqual(eventTimes(remote.document.tracks));
  expect(songTimes).toContain(after.at(-1)! * 1000 / 30);
});

// 2026-11-11 用户：“按了也没用，一直告诉我对不上”。方式 1 的歌停下时，同步状态详情里有两个出口，各确认一次。
it('用控台上的：先存档，再从控台读这首歌现在的时间线换进歌里，没写到控台的本地改动去掉；歌和控台一致', async () => {
  start(); edit(1000); await tick();
  expect(song().state).toBe('blocked');
  previewMa2.mockClear(); previewMa2.mockResolvedValue(consoleMoved()); archive.mockClear();
  const message = await takeMa2SongFromConsole('song');
  expect(archive).toHaveBeenCalledOnce(); expect(previewMa2).toHaveBeenCalledOnce();
  expect(archive.mock.invocationCallOrder[0]!).toBeLessThan(previewMa2.mock.invocationCallOrder[0]!);
  expect(message).toContain('已换成控台上的 Timecode 9902');
  const lighting = useDocumentStore.getState().project!.rundown[0]!.lighting!;
  expect(eventTimes(lighting.tracks)).toEqual(eventTimes(consoleMoved().document.tracks));
  expect(lighting.ma2Bindings).toHaveLength(1);
  expect(ma2PendingChanges(useDocumentStore.getState().project)).toEqual([]);
  expect(song()).toMatchObject({ state: 'verified', announcedFailure: undefined, localEditedAt: undefined });
  // One step: undo brings the local edit back.
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at).toBe(1000);
});
it('用控台上的：控台没连上时不拿上次读的冒充，什么都不改', async () => {
  start(); edit(1000); await tick();
  status.mockResolvedValue({ state: 'disconnected' });
  const before = useDocumentStore.getState().project;
  await expect(takeMa2SongFromConsole('song')).rejects.toThrow('控台没连上');
  expect(useDocumentStore.getState().project).toBe(before);
});
it('用联动台的：下一次同步按以联动台为准写一次，之后照常读回控台上的改动', async () => {
  previewMa2.mockResolvedValue(consoleMoved());
  start(); edit(1000); await tick();
  expect(song().state).toBe('blocked');
  applyMa2.mockImplementation(confirmWrite);
  writeMa2SongFromSoftware('song');
  expect(song()).toMatchObject({ state: 'pending', consoleChangesOnce: 'software' });
  await tick();
  expect(applyMa2.mock.calls.at(-1)?.[0]).toMatchObject({ consoleChanges: 'software' });
  expect(song()).toMatchObject({ state: 'verified', consoleChangesOnce: undefined });
  expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at).toBe(1000);
  edit(1100); await tick();
  expect(applyMa2.mock.calls.at(-1)?.[0]).toMatchObject({ consoleChanges: 'read-back' });
});
it('用联动台的：这一次碰上控台同时在改，选择留着，重读后照样按联动台的写', async () => {
  previewMa2.mockResolvedValue(consoleMoved());
  start(); edit(1000); await tick();
  expect(song().state).toBe('blocked');
  writeMa2SongFromSoftware('song');
  applyMa2.mockResolvedValueOnce({ status: 'incomplete', stage: 'read', message: '控台同时在改：预览之后控台的 Timecode 9902 或它用的序列变了，这次没有写入', mayHaveWritten: false, backupFile: null });
  await tick();
  expect(song()).toMatchObject({ state: 'pending', consecutiveCollisions: 1, consoleChangesOnce: 'software' });
  applyMa2.mockImplementation(confirmWrite);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 2001);
  await tick();
  expect(applyMa2.mock.calls.at(-1)?.[0]).toMatchObject({ consoleChanges: 'software' });
  expect(song()).toMatchObject({ state: 'verified', consoleChangesOnce: undefined });
});
it('控台时间线页的刷新：控台连着就现读这一条，没连上才用上次读的，播放中不读', async () => {
  expect(await readMa2ShowNow(9902, 0)).toEqual(preview);
  expect(previewMa2).toHaveBeenCalledWith(expect.objectContaining({ target: 9902, timeOriginMs: 0, network }));
  status.mockResolvedValue({ state: 'disconnected' });
  expect(await readMa2ShowNow(9902, 0)).toBeNull();
  status.mockResolvedValue({ state: 'connected', settings: { ...network, autoConnect: false } });
  useShowStateStore.setState({ show: RUNNING });
  await expect(readMa2ShowNow(9902, 0)).rejects.toThrow(SHOW_WAIT_CLOCK_MOVING);
  expect(previewMa2).toHaveBeenCalledOnce();
});

it.skipIf(!process.env.MA2_ONPC_AUTO_SYNC_ACCEPTANCE)('真实 onPC 自动写回及反向修改进入工程，最后恢复测试对象', async () => {
  const target = process.env.MA2_ONPC_AUTO_SYNC_TARGET === '9907' ? 9907 : 9902;
  const connection = { dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '' };
  const bridge = new Ma2OnpcBridge(connection.dataDirectory, showStopped);
  const original = await bridge.request('READ', target);
  expect(inspectMa2TimecodeXml(original).timecodes[0]?.attributes.name).toBe(target === 9907 ? '100步灯光测试' : 'TBLINK_FRACTIONAL_TIMECODE');
  const service = new Ma2ApplyService(bridge, showStopped);
  let value = createEmptyLinkProject('自动同步真实验收');
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  value = importMa2TimecodeCommand('song', convertMa2Snapshot(await bridge.request('SNAPSHOT', target), target)).execute(value);
  const pass = () => syncBoundSong({ itemId: 'song', connection, consoleChanges: 'read-back', project: () => value, current: () => true,
    read: async request => convertMa2Snapshot(await bridge.request('SNAPSHOT', request.target), request.target, [], request.timeOriginMs),
    compare: request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback)), apply: request => service.apply(request),
    archive: () => Promise.resolve(), confirm: command => { value = command.execute(value); }, writing: () => undefined, localEditedAt: () => undefined, consoleSeen: () => Date.now() });
  try {
    value.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at = 1200;
    expect(await pass()).toMatchObject({ kind: 'confirmed', wrote: true });
    const updated = await bridge.request('READ', target);
    const report = inspectMa2TimecodeXml(updated);
    expect(report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.attributes.time).toBe('36');
    const remote = patchMa2EventTimes(updated, report.sha256, [{ path: report.timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.path, rawTime: '39' }]);
    await bridge.exchange('APPLY', target, updated, remote);
    expect(await pass()).toMatchObject({ kind: 'confirmed' });
    expect(value.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]!.at).toBe(1300);
  } finally {
    const current = await bridge.request('READ', target);
    if (!sameMa2XmlObjects(current, original)) await bridge.exchange('APPLY', target, current, original);
    expect(sameMa2XmlObjects(await bridge.request('READ', target), original)).toBe(true);
  }
}, 300000);

// 0.5.9 E15（冲突 5）：整首挪过的歌，控台上原来的点读回来会被当成“控台后改的”，把灯拽回原处、和音乐差一段空白。
it('方式 1 的歌整首挪过（加了前空白）：到控台确认之前按“以联动台为准”写，确认以后照原来的方式读回', async () => {
  const file = { assetId: 'music', relativePath: 'assets/reference-audio/music.wav', sha256: 'a'.repeat(64), durationMs: 20_000 };
  const music = (leadMs: number, sha256: string) => ({ ...file, sha256, durationMs: 20_000 + leadMs, timeline: { source: file, segments: [{ id: 'music', startMs: leadMs, sourceOffsetMs: 0, durationMs: 20_000 }] } });
  const value = project();
  value.playbackSource = 'internal';
  value.rundown[0] = { ...value.rundown[0]!, referenceAudio: music(0, 'b'.repeat(64)) };
  useDocumentStore.getState().setProject(value, 'song.tblink');
  applyMa2.mockImplementation(confirmWrite);
  start(); edit(1000); await tick();
  expect(applyMa2.mock.calls.at(-1)?.[0]).toMatchObject({ consoleChanges: 'read-back' });
  expect(song().state).toBe('verified');
  // A second before the music, as the editor writes it (the rendered mix, then the one command).
  const padded = music(1_000, 'c'.repeat(64));
  useDocumentStore.getState().execute(padSongCommand('song', { baseAudioSha256: 'b'.repeat(64), leadDeltaMs: 1_000, tailMs: 0,
    rendered: { ...padded, timeline: { source: padded, segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs: 21_000 }], tracks: padSongRender(music(0, 'b'.repeat(64)), 1_000, 0, '25').tracks } } }));
  await tick();
  expect(applyMa2.mock.calls.at(-1)?.[0]).toMatchObject({ consoleChanges: 'software' });
  expect(song().state).toBe('verified');
  // The next edit, a little later than where the move put the point, is read back as chosen.
  edit(useDocumentStore.getState().project!.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]!.at + 100); await tick();
  expect(applyMa2.mock.calls.at(-1)?.[0]).toMatchObject({ consoleChanges: 'read-back' });
});
