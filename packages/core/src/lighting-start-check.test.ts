import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type Ma2Catalog } from '@tb/schema';
import { reconcileMa2ReadState } from './ma2-pairing-state';
import { lightingStartCheck } from './lighting-start-check';

function fixture() {
  const project = createEmptyLinkProject('开播前检查'); project.schemaVersion = 2; project.timebase.frameRate = '30';
  project.rundown = ['歌曲甲', '串场'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 },
    playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: 480000 + index * 100000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: '现场 Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 2, name: '歌曲甲' }] }, readAt: '2026-10-22T00:00:00.000Z',
    entries: [{ target: 2, name: '歌曲甲', eventCount: 2, frameFormat: '30 FPS', offset: '14400', slot: 'TC Slot 2', events: [0, 955].map(time => ({ path: String(time), time: String(time), action: 'Goto', executor: '1.101', cue: null, name: null })), error: null, warnings: [] }] };
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  return project;
}
const track = (at: number): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: 'clip', name: '原编排', start: 0, duration: 40000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] });
const port = { portName: '团播联动台 P1 MTC', ports: ['团播联动台 P1 MTC'] };

it('没有控台节目的歌直接播放；对上且端口、帧率都对时直接播放；没选端口不拦（引擎准备时会报）', () => {
  const project = fixture();
  expect(lightingStartCheck(project, '串场', { portName: null, ports: [] })).toBeNull();
  expect(lightingStartCheck(project, '歌曲甲', port)).toBeNull();
  expect(lightingStartCheck(project, '歌曲甲', { portName: port.portName, ports: null })).toBeNull();
  expect(lightingStartCheck(project, '歌曲甲', { portName: null, ports: null })).toBeNull();
});

it('对上的歌找不到时间码端口或帧率不一致时给出原因', () => {
  const project = fixture();
  expect(lightingStartCheck(project, '歌曲甲', { portName: port.portName, ports: ['其他端口'] })).toBe('这首歌可以播放，但找不到时间码输出端口：团播联动台 P1 MTC');
  project.timebase.frameRate = '25';
  expect(lightingStartCheck(project, '歌曲甲', port)).toBe('这首歌可以播放，但帧率不一致：工程是 25 FPS，控台 Timecode 2 是 30 FPS');
});

it('控台节目没同步最新改动或放 Cue 时的起点对不上时只提示，时间码照常发送（2026-10-26）', () => {
  const project = fixture(), lighting = createLightingDocument(); lighting.tracks = [track(500)];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲甲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: 480000 }];
  project.rundown[0]!.lighting = lighting;
  expect(lightingStartCheck(project, '歌曲甲', port)).toBe('控台上还是上一版：这首歌还有 1 项改动没同步到控台，这次时间码触发的是控台上现有的灯光；停止播放后会自动同步');
  const placed = structuredClone(project); placed.rundown[0]!.lighting!.ma2Bindings![0]!.timeOriginMs = 0;
  expect(lightingStartCheck(placed, '歌曲甲', port)).toMatch(/对不上.*；时间码照常发送$/);
});

it('控台上两个节目起点都和这首歌一样：提示，时间码照常发送', () => {
  const project = fixture();
  const catalog = structuredClone(project.ma2ReadState!.catalog); catalog.entries.push({ ...catalog.entries[0]!, target: 4 });
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  expect(lightingStartCheck(project, '歌曲甲', port)).toContain('Timecode 2、4 的起点和这首歌相同');
});
