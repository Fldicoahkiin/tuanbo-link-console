import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type Ma2Catalog } from '@tb/schema';
import { reconcileMa2ReadState } from './ma2-pairing-state';
import { songLightingStatus } from './song-lighting-status';

function fixture() {
  const project = createEmptyLinkProject('灯光状态'); project.schemaVersion = 2;
  project.rundown = ['歌曲甲', '歌曲乙'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 },
    playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: 480000 + index * 100000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: '现场 Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 2, name: '歌曲甲' }] }, readAt: '2026-10-22T00:00:00.000Z',
    entries: [{ target: 2, name: '歌曲甲', eventCount: 2, frameFormat: '30 FPS', offset: '14400', slot: 'TC Slot 2', events: [0, 955].map(time => ({ path: String(time), time: String(time), action: 'Goto', executor: '1.101', cue: null, name: null })), error: null, warnings: [] }] };
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  return { project, catalog };
}
const track = (at: number): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: 'clip', name: '原编排', start: 0, duration: 40000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] });
const matched = { state: 'matched', timecode: 2, startMs: 480000, frameRate: '30', pending: 0, problems: [], notes: [] };

it('起始码对上就是对上，不用确认；没有控台节目的歌是未对上；给出控台节目、起始码和帧率', () => {
  const { project } = fixture();
  expect(songLightingStatus(project, '歌曲乙')).toEqual({ state: 'unmatched', reason: null });
  expect(songLightingStatus(project, '歌曲甲')).toEqual(matched);
  expect(() => songLightingStatus(project, '不存在')).toThrow('节目单中没有');
  const other = structuredClone(project); other.ma2ReadState!.catalog.entries[0]!.frameFormat = '25 FPS';
  expect(songLightingStatus(other, '歌曲甲')).toEqual({ ...matched, frameRate: '25' });
});

it('改了歌曲起点就不再对上；控台两个节目起点相同时标起点重复', () => {
  const { project, catalog } = fixture();
  const moved = structuredClone(project); moved.rundown[0]!.playback!.mtcOffsetMs += 1000;
  expect(songLightingStatus(moved, '歌曲甲')).toEqual({ state: 'unmatched', reason: null });
  const twice = structuredClone(catalog); twice.entries.push({ ...twice.entries[0]!, target: 5 });
  const duplicate = structuredClone(project); duplicate.ma2ReadState = reconcileMa2ReadState(duplicate, 'console', twice);
  expect(songLightingStatus(duplicate, '歌曲甲')).toEqual({ state: 'duplicate', timecodes: [2, 5] });
});

it('对上的歌有本地修改还没写到控台：给出待同步件数；放 Cue 时的起点对不上：未对上并说明怎么处理', () => {
  const { project } = fixture();
  const lighting = createLightingDocument(); lighting.tracks = [track(500)];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲甲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: 480000 }];
  project.rundown[0]!.lighting = lighting;
  expect(songLightingStatus(project, '歌曲甲')).toEqual({ ...matched, pending: 1 });
  // Every edit is a new project snapshot, as commands produce.
  const written = structuredClone(project); written.rundown[0]!.lighting!.tracks = [track(0)];
  expect(songLightingStatus(written, '歌曲甲')).toEqual(matched);
  const placed = structuredClone(written); placed.rundown[0]!.lighting!.ma2Bindings![0]!.timeOriginMs = 0;
  expect(songLightingStatus(placed, '歌曲甲')).toEqual({ state: 'unmatched', reason: expect.stringContaining('刷新') as string });
});

it('控台事件在歌曲结束之后：仍然对上，带提示', () => {
  const { project, catalog } = fixture();
  const late = structuredClone(catalog); late.entries[0]!.events.push({ path: '2', time: '1500', action: 'Goto', executor: '1.101', cue: null, name: null });
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', late);
  expect(songLightingStatus(project, '歌曲甲')).toEqual({ ...matched, notes: [expect.stringContaining('1 个事件在歌曲结束之后') as string] });
});

function ownShowSong(times: number[], start = 480000) {
  const { project } = fixture();
  const lighting = createLightingDocument();
  lighting.tracks = [{ ...track(0), clips: [{ ...track(0).clips[0]!, events: times.map((at, index) => ({ id: `p${index}`, kind: 'ma2' as const, at, sequence: 9000, executor: '1000.101', cue: `${index + 1}.000`, action: 'goto' as const, label: `段落 ${index + 1}` })) }] }];
  lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: '现场 Show', layout: null, executor: '1000.101', sequence: 9000, name: 'GeQu', baselineXml: '<MA/>',
    points: [0, 1000].map((atMs, index) => ({ id: `p${index}`, cue: `${index + 1}.000`, atMs })), timecode: { number: 9000, offset: 14400, slot: 'TC Slot 2', revision: 'a'.repeat(64) } };
  project.rundown[1]!.lighting = lighting; project.rundown[1]!.playback!.mtcOffsetMs = start;
  return project;
}

it('自有时间码节目：一直算对上；挪动时间、加点位、改起始码算待同步；控台上还没有节目时说明会自动建立', () => {
  const own = { state: 'matched', timecode: 9000, startMs: 480000, frameRate: '30', problems: [], notes: [] };
  expect(songLightingStatus(ownShowSong([0, 1000]), '歌曲乙')).toEqual({ ...own, pending: 0 });
  expect(songLightingStatus(ownShowSong([0, 1010]), '歌曲乙')).toEqual({ ...own, pending: 0 });
  expect(songLightingStatus(ownShowSong([0, 1500]), '歌曲乙')).toEqual({ ...own, pending: 1 });
  expect(songLightingStatus(ownShowSong([0, 1000, 2000]), '歌曲乙')).toEqual({ ...own, pending: 1 });
  expect(songLightingStatus(ownShowSong([0, 1000], 490000), '歌曲乙')).toEqual({ ...own, startMs: 490000, pending: 1 });
  const unwritten = ownShowSong([0, 1000]); delete unwritten.rundown[1]!.lighting!.consoleSong!.timecode;
  expect(songLightingStatus(unwritten, '歌曲乙')).toEqual({ state: 'unmatched', reason: expect.stringContaining('同步时自动建立') as string });
});

it('只放在 Layout 页面上、没有执行器位置的本曲序列建不了时间码节目：未对上并说明', () => {
  const project = ownShowSong([0, 1000]);
  const song = project.rundown[1]!.lighting!.consoleSong!;
  project.rundown[1]!.lighting!.consoleSong = { ...song, layout: 999, executor: undefined, timecode: undefined };
  expect(songLightingStatus(project, '歌曲乙')).toEqual({ state: 'unmatched', reason: expect.stringContaining('没有执行器位置') as string });
});
