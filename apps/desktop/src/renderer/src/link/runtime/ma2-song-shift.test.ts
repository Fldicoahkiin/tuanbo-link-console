import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { padSongCommand, padSongRender, setLightingCommand } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, type AudioTrack, type Ma2SongSyncRequest, type Ma2SongSyncResult, type ReferenceAudio } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { useShowStateStore } from '../stores/show-state-store';
import { markPendingMa2Songs, tickMa2SongSync } from './ma2-song-sync';
import { prepareMa2RealtimeSession } from './ma2-realtime-session';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { PADDING_SYNC_FIRST, ma2ConsoleChangesFor, ma2PaddingWait, ma2SongShifted, noteMa2SongsShifted } from './ma2-song-shift';

/*
 * Blank time before a song's music and the console (0.5.9 E15, 冲突 5): the whole song moved, so until the console
 * confirmed the rewrite the song is not read back and its next sync writes it; before blank time is added the song is
 * to be in step with the console, and without the console it can always be added.
 */

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { recordLog } = vi.hoisted(() => ({ recordLog: vi.fn<(entry: { level: string; message: string }) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog } }));
const { archive } = vi.hoisted(() => ({ archive: vi.fn() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));

const consoleSource = { show: 'Show', generation: 'session', version: '3.7.0.5' };
const status = vi.fn(), catalog = vi.fn(), metadata = vi.fn(), cancel = vi.fn(), sync = vi.fn(), check = vi.fn(), rename = vi.fn();
const storage = new Map<string, string>();
const music = { assetId: 'music', relativePath: 'assets/reference-audio/music.wav', sha256: 'a'.repeat(64), durationMs: 20_000 };
let renders = 0;
function mixed(tracks: AudioTrack[], songMs?: number): ReferenceAudio {
  const durationMs = songMs ?? Math.max(...tracks.flatMap(track => track.segments.map(segment => segment.startMs + segment.durationMs)));
  const file = { assetId: `mix-${++renders}`, relativePath: `assets/reference-audio/mix-${renders}.wav`, sha256: renders.toString(16).padStart(64, '0'), durationMs };
  return { ...file, timeline: { source: file, segments: [{ id: file.assetId, startMs: 0, sourceOffsetMs: 0, durationMs }], tracks, ...(songMs === undefined ? {} : { durationMs: songMs }) } };
}

/** One way-2 song with its music and a Cue point at 5 s, its own Sequence 9000 on the console. */
function project() {
  const value = createEmptyLinkProject('加空白');
  value.schemaVersion = 2;
  value.playbackSource = 'internal';
  value.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { ...consoleSource, entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] } };
  const lighting = createLightingDocument();
  lighting.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    clips: [{ id: 'clip', name: '编排', start: 0, duration: 20_000, timeLock: 'time', muted: false, events: [{ id: 'point', kind: 'empty-cue', at: 5_000, label: '开场', runMode: 'independent' }] }] }];
  lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: consoleSource.show, sequence: 9000, name: 'first', executor: '1234.101', layout: null, baselineXml: '<baseline/>', points: [{ id: 'point', cue: '1.000' }] };
  value.rundown = [{ id: 'first', title: 'first', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting,
    referenceAudio: mixed([{ id: 'music-track', title: '歌曲音频', source: music, segments: [{ id: 'music', startMs: 0, sourceOffsetMs: 0, durationMs: 20_000 }] }]),
    playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 3_600_000, shortcut: '' } }];
  return value;
}
const answer = (request: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> => {
  const sequence = request.binding!.sequence;
  return Promise.resolve({ binding: { ...request.binding!, baselineXml: `<synced-${sequence}/>`, points: request.points.map((point, index) => ({ id: point.id, cue: `${index + 1}.000` })) }, layout: null, backupFile: '', changed: true,
    library: { directory: { ...consoleSource, entries: [{ target: sequence, name: request.name }] }, readAt: new Date().toISOString(), sequences: [{ sequence, name: request.name, cues: request.points.map((_, index) => ({ index: index + 1, number: `${index + 1}.000`, name: '开场' })) }], fixtureUsage: [], errors: [] } });
};
/** Two seconds before the music, as the editor does it (render, then the one command), and what the sync hook hears. */
function padLead(): void {
  const state = useDocumentStore.getState(), audio = state.project!.rundown[0]!.referenceAudio!;
  const plan = padSongRender(audio, 2_000, 0, state.project!.timebase.frameRate);
  state.execute(padSongCommand('first', { baseAudioSha256: audio.sha256, leadDeltaMs: 2_000, tailMs: 0, rendered: mixed(plan.tracks, plan.durationMs) }));
  // What use-ma2-sync.ts does on every project change.
  markPendingMa2Songs();
}
const requests = (): Ma2SongSyncRequest[] => sync.mock.calls.map(call => call[0] as Ma2SongSyncRequest);
const entry = (): SongSync => useMa2SyncStore.getState().songs.first!;

beforeEach(() => {
  vi.clearAllMocks(); storage.clear(); storage.set('tblink.ma2-connection-method.v1', 'network');
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, readMa2Catalog: catalog, readMa2EffectLibrary: metadata, cancelMa2Read: cancel, syncMa2Song: sync, checkMa2Song: check, renameMa2Object: rename } });
  status.mockResolvedValue({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
  metadata.mockResolvedValue(project().ma2MaterialLibrary!.library);
  cancel.mockResolvedValue(undefined); check.mockResolvedValue(false); archive.mockResolvedValue('C:/archive.tblink');
  sync.mockImplementation(answer);
  useMa2SyncStore.setState({ songs: {}, names: { state: 'idle', message: '' }, session: { status: 'waiting', message: '' }, previewPlaying: false });
  useShowStateStore.setState({ show: { phase: 'idle', program: null } });
  useMa2RealtimePreference.setState({ enabled: true, once: null, writeMode: 'merge', consoleChanges: 'read-back' });
  useDocumentStore.getState().setProject(project(), 'song.tblink');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('整首平移以后，到控台重写确认之前不读回，下一次同步是写入', () => {
  it('选的是“读回联动台”：加空白后的那次同步按“以联动台为准”写；控台确认以后照原来的方式', async () => {
    await prepareMa2RealtimeSession();
    await tickMa2SongSync();
    expect(requests().map(request => request.consoleChanges)).toEqual(['read-back']);
    expect(entry().state).toBe('verified');

    padLead();
    expect(ma2SongShifted(entry())).toBe(true);
    await tickMa2SongSync();
    expect(requests()[1]).toMatchObject({ consoleChanges: 'software', points: [expect.objectContaining({ id: 'point' })] });
    expect(entry().state).toBe('verified');
    expect(ma2SongShifted(entry())).toBe(false);

    // The next edit is read back as the operator chose.
    const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
    const point = lighting.tracks[0]!.clips[0]!.events[0]!;
    if (point.kind !== 'empty-cue' && point.kind !== 'ma2') throw new Error('fixture 应为 Cue 点');
    point.label = '改过';
    useDocumentStore.getState().execute(setLightingCommand('first', lighting)); markPendingMa2Songs();
    await tickMa2SongSync();
    expect(requests()[2]).toMatchObject({ consoleChanges: 'read-back' });
  });

  it('写入失败没确认：还记着，下一次同步照样是写入', async () => {
    await prepareMa2RealtimeSession();
    await tickMa2SongSync();
    padLead();
    sync.mockRejectedValueOnce(new Error('MA2 响应超时，操作没有确认，不会自动重试'));
    await tickMa2SongSync();
    expect(requests()[1]).toMatchObject({ consoleChanges: 'software' });
    expect(ma2SongShifted(entry())).toBe(true);
  });

  it('加了又撤销、控台还没写过：不再记着，照原来的方式', async () => {
    await prepareMa2RealtimeSession();
    await tickMa2SongSync();
    padLead();
    expect(ma2SongShifted(entry())).toBe(true);
    useDocumentStore.getState().undo();
    markPendingMa2Songs();
    expect(ma2SongShifted(entry())).toBe(false);
    expect(ma2ConsoleChangesFor(entry(), 'read-back')).toBe('read-back');
  });

  it('方式 1 的一次性“用联动台的”之外，挪过的歌也一律以联动台为准', () => {
    const song = { documentId: 7, itemId: 'way1', consoleChangesOnce: undefined };
    expect(ma2ConsoleChangesFor(song, 'read-back')).toBe('read-back');
    expect(ma2ConsoleChangesFor({ ...song, consoleChangesOnce: 'software' }, 'read-back')).toBe('software');
    const before = structuredClone(useDocumentStore.getState().project!);
    const way1 = { ...before.rundown[0]!, id: 'way1' };
    before.rundown[0] = way1;
    const audio = way1.referenceAudio!;
    const padded = padSongCommand('way1', { baseAudioSha256: audio.sha256, leadDeltaMs: 1_000, tailMs: 0,
      rendered: mixed(padSongRender(audio, 1_000, 0, '25').tracks) }).execute(structuredClone(before));
    noteMa2SongsShifted(7, before);
    expect(ma2ConsoleChangesFor(song, 'read-back')).toBe('read-back');
    noteMa2SongsShifted(7, padded);
    expect(ma2ConsoleChangesFor(song, 'read-back')).toBe('software');
  });
});

describe('加空白之前，这首歌要和控台一致', () => {
  const song = (patch: Partial<SongSync>): SongSync => ({ sessionId: 's', itemId: 'first', documentId: 1, name: 'first', settings: entry0.settings, state: 'verified', message: '', ...patch });
  let entry0: SongSync;
  beforeEach(async () => { await prepareMa2RealtimeSession(); entry0 = entry(); });
  it('控台连着：有没读回的控台改动、或同步停在失败上，写“先同步这首歌再加空白”', () => {
    expect(ma2PaddingWait(song({}), 1, true)).toBeNull();
    expect(ma2PaddingWait(song({ consoleSeen: { own: { revision: '1:abc', at: 1 } } }), 1, true)).toBe(PADDING_SYNC_FIRST);
    expect(ma2PaddingWait(song({ state: 'blocked' }), 1, true)).toBe(PADDING_SYNC_FIRST);
    expect(ma2PaddingWait(song({ state: 'pending', consecutiveFailures: 1 }), 1, true)).toBe(PADDING_SYNC_FIRST);
    // Local edits not written yet are no reason: the padding is written with them.
    expect(ma2PaddingWait(song({ state: 'pending', localEditedAt: 5 }), 1, true)).toBeNull();
  });
  it('没连控台、或这首歌没有同步：照常能加', () => {
    expect(ma2PaddingWait(song({ state: 'blocked', consoleSeen: { own: { revision: '1:abc', at: 1 } } }), 1, false)).toBeNull();
    expect(ma2PaddingWait(undefined, 1, true)).toBeNull();
    expect(ma2PaddingWait(song({ state: 'blocked' }), 2, true)).toBeNull();
  });
});
