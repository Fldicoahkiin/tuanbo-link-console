import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LinkProject, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2CompareRequest, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
import { importMa2TimecodeCommand, setLightingCommand, type Ma2SyncPreview } from '@tb/core/link';
import { convertMa2Snapshot, convertMa2Timecode } from '../../../../main/link/ma2-timecode-conversion';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2OnpcBridge } from '../../../../main/link/ma2-onpc-bridge';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { inspectMa2TimecodeXml, patchMa2EventTimes, sameMa2XmlObjects } from '../../../../main/link/ma2-timecode-xml';
import { useDocumentStore } from '../stores/document-store';
import { ma2ConsoleWriting, ma2SyncPlaying, useMa2SyncStore } from '../stores/ma2-sync-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { markPendingMa2Songs, ma2SongSyncSettings, startMa2SongSync, stopMa2SongSync, tickMa2SongSync } from './ma2-song-sync';
import { syncBoundSong } from './ma2-bound-song-sync';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from '../../../../main/link/ma2-event-write';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: () => Promise.resolve() } }));

const xml = await readFile(new URL('../../../../main/link/fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('../../../../main/link/fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const preview = convertMa2Timecode(xml, [sequence], 9902);
const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' };
const library = (show = 'Test') => ({ directory: { show, generation: 'session', version: '3.3.4', entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] });

/** The console writes what it was asked to and reads it back as the apply service confirms it. */
const confirmWrite = (request: Ma2ApplyRequest): Promise<Ma2ApplyResult> => {
  const prepared = prepareMa2MergedEvents(request.document, request.bindingId, request.readback, new Map(), new Map(), [sequence]);
  return Promise.resolve({ status: 'verified', confirmed: confirmMa2MergedEvents(prepared, prepared.desiredXml, [sequence]), backupFile: 'backup.xml' });
};
/** `song` is way 1 (bound to the console's Timecode 9902); `own`, when asked for, is way 2 (its own Sequence 9000). */
function project(own = false): LinkProject {
  let value = createEmptyLinkProject('同步测试');
  value.schemaVersion = 2;
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  value = importMa2TimecodeCommand('song', preview).execute(value);
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
  compareMa2.mockImplementation(request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map(request.choices), request.consoleChanges)));
  applyMa2.mockResolvedValue({ status: 'incomplete', stage: 'write', message: '写入结果未知', mayHaveWritten: true, backupFile: 'backup.xml' });
  archive.mockResolvedValue('C:/archive.tblink');
  useMa2RealtimePreference.setState({ enabled: true, once: null, writeMode: 'merge', consoleChanges: 'read-back' });
  useMa2SyncStore.setState({ songs: {}, names: { state: 'idle', message: '' }, timelinePlaying: false, previewPlaying: false });
  useDocumentStore.getState().setProject(project(), 'song.tblink');
  unsubscribe = useDocumentStore.subscribe((state, previous) => { if (state.project !== previous.project) markPendingMa2Songs(); });
});
afterEach(() => { unsubscribe(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const start = (itemId = 'song') => startMa2SongSync(itemId, itemId, ma2SongSyncSettings(useDocumentStore.getState().project!, itemId));
const tick = () => tickMa2SongSync(ma2SyncPlaying());
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
  start(); edit(); useMa2SyncStore.setState({ timelinePlaying: true }); await tick();
  expect(status).not.toHaveBeenCalled(); expect(previewMa2).not.toHaveBeenCalled(); expect(applyMa2).not.toHaveBeenCalled();
  expect(song().state).toBe('pending'); expect(song().message).toContain('播放中');
  useMa2SyncStore.setState({ timelinePlaying: false }); await tick();
  expect(applyMa2).toHaveBeenCalledOnce();
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
it('同一项两边都改过时以软件为准写入，同步不停下来等人选（2026-10-26）', async () => {
  previewMa2.mockResolvedValue(convertMa2Timecode(xml.replace('<Event index="0"', '<Event time="15" index="0"'), [sequence], 9902));
  const messages: string[] = [];
  const listen = useMa2SyncStore.subscribe(state => { const message = state.songs.song?.message; if (message && messages.at(-1) !== message) messages.push(message); });
  try { start(); edit(); await tick(); } finally { listen(); }
  const request = applyMa2.mock.calls[0]?.[0];
  expect(request?.conflicts.length).toBeGreaterThan(0); expect(request?.conflicts.every(([, side]) => side === 'local')).toBe(true);
  expect(messages.some(message => message.includes('以联动台为准'))).toBe(true);
});
it('控台上挪了点、联动台没改：默认读回联动台；选了以联动台为准就按联动台写回控台（2026-11-04）', async () => {
  previewMa2.mockResolvedValue(convertMa2Timecode(xml.replace('<Event index="0"', '<Event time="15" index="0"'), [sequence], 9902));
  const previews: Ma2SyncPreview[] = [];
  compareMa2.mockImplementation(request => { const value = compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map(request.choices), request.consoleChanges); previews.push(value); return Promise.resolve(value); });
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

it.skipIf(!process.env.MA2_ONPC_AUTO_SYNC_ACCEPTANCE)('真实 onPC 自动写回及反向修改进入工程，最后恢复测试对象', async () => {
  const target = process.env.MA2_ONPC_AUTO_SYNC_TARGET === '9907' ? 9907 : 9902;
  const connection = { dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '' };
  const bridge = new Ma2OnpcBridge(connection.dataDirectory, () => false);
  const original = await bridge.request('READ', target);
  expect(inspectMa2TimecodeXml(original).timecodes[0]?.attributes.name).toBe(target === 9907 ? '100步灯光测试' : 'TBLINK_FRACTIONAL_TIMECODE');
  const service = new Ma2ApplyService(bridge, () => false);
  let value = createEmptyLinkProject('自动同步真实验收');
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }];
  value = importMa2TimecodeCommand('song', convertMa2Snapshot(await bridge.request('SNAPSHOT', target), target)).execute(value);
  const pass = () => syncBoundSong({ itemId: 'song', connection, consoleChanges: 'read-back', project: () => value, current: () => true,
    read: async request => convertMa2Snapshot(await bridge.request('SNAPSHOT', request.target), request.target, [], request.timeOriginMs),
    compare: request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map())), apply: request => service.apply(request),
    archive: () => Promise.resolve(), confirm: command => { value = command.execute(value); }, writing: () => undefined });
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
