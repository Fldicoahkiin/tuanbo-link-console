import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type Ma2Catalog } from '@tb/schema';
import { confirmMa2PairingCommand, reconcileMa2ReadState, withMa2PairingValidation } from './ma2-pairing-state';
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

it('没有配对和绑定是未匹配；自动匹配未确认要处理；确认后可演出并给出控台节目、起始码和帧率', () => {
  const { project } = fixture();
  expect(songLightingStatus(project, '歌曲乙')).toEqual({ state: 'unmatched' });
  expect(songLightingStatus(project, '歌曲甲')).toMatchObject({ state: 'attention', reasons: [expect.stringContaining('尚未确认')] });
  const confirmed = confirmMa2PairingCommand(2, '歌曲甲').execute(project);
  expect(songLightingStatus(confirmed, '歌曲甲')).toEqual({ state: 'ready', timecode: 2, startMs: 480000, frameRate: '30' });
  expect(() => songLightingStatus(confirmed, '不存在')).toThrow('节目单中没有');
});

it('改了歌曲起点后配对失效，变为需处理并写明原因；控台节目不是 30 FPS 也需处理', () => {
  const { project } = fixture();
  const confirmed = confirmMa2PairingCommand(2, '歌曲甲').execute(project);
  const moved = withMa2PairingValidation({ id: 'move', label: '改起点', execute: value => { const next = structuredClone(value); next.rundown[0]!.playback!.mtcOffsetMs += 1000; return next; }, undo: before => before }).execute(confirmed);
  expect(songLightingStatus(moved, '歌曲甲')).toMatchObject({ state: 'attention', reasons: [expect.stringContaining('歌曲起点或音频范围已修改')] });
  const other = structuredClone(confirmed); other.ma2ReadState!.catalog.entries[0]!.frameFormat = '25 FPS';
  expect(songLightingStatus(other, '歌曲甲')).toMatchObject({ state: 'attention', reasons: [expect.stringContaining('25 FPS')] });
});

it('已确认配对的歌有本地修改尚未写到控台：编灯中，并给出待同步件数', () => {
  const { project } = fixture();
  const confirmed = confirmMa2PairingCommand(2, '歌曲甲').execute(project);
  const lighting = createLightingDocument(); lighting.tracks = [track(500)];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲甲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: 480000 }];
  confirmed.rundown[0]!.lighting = lighting;
  expect(songLightingStatus(confirmed, '歌曲甲')).toEqual({ state: 'editing', pending: 1 });
  lighting.tracks = [track(0)];
  expect(songLightingStatus(confirmed, '歌曲甲')).toEqual({ state: 'ready', timecode: 2, startMs: 480000, frameRate: '30' });
  lighting.ma2Bindings[0]!.timeOriginMs = 0;
  expect(songLightingStatus(confirmed, '歌曲甲')).toMatchObject({ state: 'attention', reasons: [expect.stringContaining('起点不一致')] });
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

it('自有时间码节目：点位和起始码都与上次写入一致即可演出；挪动时间、改起始码算编灯中；只有序列没有节目仍是未匹配', () => {
  expect(songLightingStatus(ownShowSong([0, 1000]), '歌曲乙')).toEqual({ state: 'ready', timecode: 9000, startMs: 480000, frameRate: '30' });
  expect(songLightingStatus(ownShowSong([0, 1010]), '歌曲乙')).toEqual({ state: 'ready', timecode: 9000, startMs: 480000, frameRate: '30' });
  expect(songLightingStatus(ownShowSong([0, 1500]), '歌曲乙')).toEqual({ state: 'editing', pending: 1 });
  expect(songLightingStatus(ownShowSong([0, 1000, 2000]), '歌曲乙')).toEqual({ state: 'editing', pending: 1 });
  expect(songLightingStatus(ownShowSong([0, 1000], 490000), '歌曲乙')).toEqual({ state: 'editing', pending: 1 });
  const unwritten = ownShowSong([0, 1000]); delete unwritten.rundown[1]!.lighting!.consoleSong!.timecode;
  expect(songLightingStatus(unwritten, '歌曲乙')).toEqual({ state: 'unmatched' });
});

it('只放在 Layout 页面上、没有执行器位置的本曲序列建不了时间码节目：需处理并说明', () => {
  const project = ownShowSong([0, 1000]);
  const song = project.rundown[1]!.lighting!.consoleSong!;
  project.rundown[1]!.lighting!.consoleSong = { ...song, layout: 999, executor: undefined, timecode: undefined };
  expect(songLightingStatus(project, '歌曲乙')).toMatchObject({ state: 'attention', reasons: [expect.stringContaining('没有执行器位置')] });
});
