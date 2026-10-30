import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, linkCueSchema, type LightingTrack, type LinkProject, type Ma2Catalog } from '@tb/schema';
import { matchMa2Programs } from './ma2-program-matching';
import { ma2SongPairs, reconcileMa2ReadState } from './ma2-pairing-state';
import { ma2PendingChanges } from './ma2-pending-changes';
import { songLightingStatus } from './song-lighting-status';
import { lightingStartCheck } from './lighting-start-check';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { programStart } from './program-start';
import { parseP1TimeOrigin, programTimeOrigin } from './ma2-time-origin';
import { encodeMediaTimecode } from './mtc-output';

/**
 * The ten lighting workflow rules the operator set on 2026-10-26 (docs/LIGHTING_WORKFLOW.md), one
 * describe block per rule. The document names these tests beside each rule: a change that breaks a
 * rule fails here even when the tests written for that change still pass.
 */

const SONG_START_MS = 480_000;
const SHOW_START_TICKS = SONG_START_MS * 30 / 1000;

function song(id: string, startMs: number) {
  return { id, title: `歌曲${id}`, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 40_000 },
    playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: startMs, shortcut: '' } };
}

function catalog(shows: Array<{ target: number; ticks: number }>, show = '1hao 10.16', generation = 'session-a'): Ma2Catalog {
  return { directory: { show, generation, version: '3.3.4.3', entries: shows.map(entry => ({ target: entry.target, name: `灯光 ${entry.target}` })) }, readAt: '2026-10-28T00:00:00.000Z',
    entries: shows.map(entry => ({ target: entry.target, name: `灯光 ${entry.target}`, eventCount: 1, frameFormat: '30 FPS', offset: String(entry.ticks), slot: 'TC Slot 1',
      events: [{ path: '30', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: 'Cue' }], error: null, warnings: [] })) };
}

function project(): LinkProject {
  const value = createEmptyLinkProject('灯光工作流'); value.schemaVersion = 2;
  value.rundown = [song('甲', SONG_START_MS), song('乙', SONG_START_MS + 100_000)];
  value.ma2ReadState = reconcileMa2ReadState(value, '192.0.2.10:30000', catalog([{ target: 7, ticks: SHOW_START_TICKS }]));
  return value;
}

const track = (at: number): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: 'clip', name: '原编排', start: 0, duration: 40_000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] });

/** Song 甲 holding the Cues of console Timecode 7, with local edits when `editedAt` differs from 0. */
function bound(editedAt = 0, placedAt = SONG_START_MS): LinkProject {
  const value = project();
  const lighting = createLightingDocument(); lighting.tracks = [track(editedAt)];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 7, name: '灯光 7', readAt: '2026-10-28T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: placedAt }];
  value.rundown[0]!.lighting = lighting;
  return value;
}

describe('第 1 条：P1 的 MTC 起始码原样带进来', () => {
  it('P1 写的秒数原样成为歌曲的起始码，小数部分不丢', () => {
    expect(parseP1TimeOrigin('11820.02')).toBe(11_820_020);
    const p1Media = { sourceKey: 'p1:1', playlistId: 'list', sourceFileName: 'monster.mp4', playEndAction: 'stop' as const, volume: 100, muted: false, shortcut: '', midiStartTime: '11820.02' };
    expect(programTimeOrigin({ p1Media })).toBe(11_820_020);
  });
});

describe('第 3 条：音频和控台时间线只按 MTC 起始码配对', () => {
  it('起点相同就配对，不需要人确认', () => {
    expect(ma2SongPairs(project()).pairs).toEqual({ 7: '甲' });
  });

  it('控台另存了新 Show、换了会话或版本，配对不变', () => {
    const value = project();
    const renamed = catalog([{ target: 7, ticks: SHOW_START_TICKS }], '1hao 10.28', 'session-b');
    renamed.directory.version = '3.9.60.65';
    expect(matchMa2Programs(value, renamed).pairs).toEqual({ 7: '甲' });
  });

  it('歌名、歌曲顺序、音频文件改了，配对不变', () => {
    const value = project();
    value.rundown.reverse();
    value.rundown[1]!.title = '改过的歌名';
    value.rundown[1]!.referenceAudio!.sha256 = 'b'.repeat(64);
    value.rundown[1]!.referenceAudio!.durationMs = 55_000;
    expect(matchMa2Programs(value, value.ma2ReadState!.catalog).pairs).toEqual({ 7: '甲' });
  });

  it('工程里存的旧配对不参与：只看起始码', () => {
    const value = project();
    value.ma2ReadState = { ...value.ma2ReadState!, pairs: { 7: '乙' }, pairings: { 7: { itemId: '乙', status: 'stale', evidence: '{}' } } };
    expect(ma2SongPairs(value).pairs).toEqual({ 7: '甲' });
  });

  it('起点差不到一帧算同一个，差一帧以上不配对', () => {
    const value = project();
    expect(matchMa2Programs(value, catalog([{ target: 7, ticks: SHOW_START_TICKS + 0.5 }])).pairs).toEqual({ 7: '甲' });
    expect(matchMa2Programs(value, catalog([{ target: 7, ticks: SHOW_START_TICKS + 1 }])).pairs).toEqual({});
  });

  it('两首歌起点相同时不猜', () => {
    const value = project(); value.rundown[1]!.playback!.mtcOffsetMs = SONG_START_MS;
    expect(matchMa2Programs(value, value.ma2ReadState!.catalog).pairs).toEqual({});
  });
});

describe('第 4、10 条：不接网线也能用 MIDI 时间码，随时都能发', () => {
  it('时间码从歌曲自己的起始码开始，和有没有读过控台无关', () => {
    const value = project();
    const offline = structuredClone(value); delete offline.ma2ReadState;
    for (const each of [value, offline]) {
      const prepared = nativeProgramSnapshot(each, '甲', 1, undefined, 48_000);
      expect(prepared.allowMtc).toBe(true);
      expect(prepared.snapshot.offsetMs).toBe(SONG_START_MS);
    }
  });

  it('起始码 8 分整在 30 FPS 下就是 00:08:00:00', () => {
    expect(encodeMediaTimecode(SONG_START_MS, '30').fullFrame).toEqual([0xf0, 0x7f, 0x7f, 1, 1, 3 << 5, 8, 0, 0, 0xf7]);
  });
});

describe('第 5 条：联动台改的 Cue 写回控台同一条时间线', () => {
  it('待同步的改动指向原来那条 Timecode，不新建', () => {
    const changes = ma2PendingChanges(bound(500));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ itemId: '甲', target: 7, error: null });
  });
});

describe('第 8 条：不重复同步', () => {
  it('联动台和上次写入控台的内容一样时，没有要同步的东西', () => {
    expect(ma2PendingChanges(bound())).toEqual([]);
    expect(songLightingStatus(bound(), '甲')).toMatchObject({ state: 'matched', timecode: 7, pending: 0 });
  });
});

describe('第 9 条：随时可以播放，任何原因都不拦', () => {
  const cases: Array<[string, () => LinkProject]> = [
    ['没编灯', project],
    ['有改动还没同步到控台', () => bound(500)],
    ['放 Cue 时的起点和现在对不上', () => bound(500, 0)],
    ['控台上没有对应的时间线', () => { const value = project(); delete value.ma2ReadState; return value; }],
    ['两首歌起点相同', () => { const value = project(); value.rundown[1]!.playback!.mtcOffsetMs = SONG_START_MS; return value; }]
  ];
  it.each(cases)('%s：照常播放并发时间码，只给提示', (_name, make) => {
    const value = make();
    const prepared = nativeProgramSnapshot(value, '甲', 1, undefined, 48_000);
    expect(prepared.allowMtc).toBe(true);
    expect(prepared.snapshot.offsetMs).toBe(SONG_START_MS);
    const notice = lightingStartCheck(value, '甲', { portName: null, ports: null });
    expect(notice === null || typeof notice === 'string').toBe(true);
    // programStart is the one place that decides what starting a song does.
    const start = programStart(value, '甲', { revision: 1, positionMs: undefined, sampleRate: 48_000, mtcPortName: 'MTC', check: true });
    expect(start).toMatchObject({ allowMtc: true, snapshot: { offsetMs: SONG_START_MS } });
  });

  it('要画面的歌也照常播放并发时间码：只等画面准备，画面失败不拦（取代 2026-10-19 的“画面不就绪就不播”）', () => {
    const value = project();
    value.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
    const start = programStart(value, '甲', { revision: 1, positionMs: undefined, sampleRate: 48_000, mtcPortName: null, check: true });
    expect(start).toMatchObject({ picture: 'wait', allowMtc: true, snapshot: { offsetMs: SONG_START_MS } });
    expect(programStart(value, '乙', { revision: 1, positionMs: undefined, sampleRate: 48_000, mtcPortName: null, check: true }).picture).toBe('optional');
  });

  it('配对上的歌显示两边的起始码：歌曲的和控台 Timecode 的是同一个', () => {
    const status = songLightingStatus(project(), '甲');
    expect(status).toMatchObject({ state: 'matched', timecode: 7, startMs: SONG_START_MS });
  });
});
