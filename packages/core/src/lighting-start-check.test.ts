import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type Ma2Catalog } from '@tb/schema';
import { confirmMa2PairingCommand, reconcileMa2ReadState } from './ma2-pairing-state';
import { lightingStartCheck } from './lighting-start-check';

function fixture() {
  const project = createEmptyLinkProject('开播前检查'); project.schemaVersion = 2; project.timebase.frameRate = '30';
  project.rundown = ['歌曲甲', '串场'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 },
    playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: 480000 + index * 100000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: '现场 Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 2, name: '歌曲甲' }] }, readAt: '2026-10-22T00:00:00.000Z',
    entries: [{ target: 2, name: '歌曲甲', eventCount: 2, frameFormat: '30 FPS', offset: '14400', slot: 'TC Slot 2', events: [0, 955].map(time => ({ path: String(time), time: String(time), action: 'Goto', executor: '1.101', cue: null, name: null })), error: null, warnings: [] }] };
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  return confirmMa2PairingCommand(2, '歌曲甲').execute(project);
}
const track = (at: number): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: 'clip', name: '原编排', start: 0, duration: 40000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] });
const port = { portName: '团播联动台 P1 MTC', ports: ['团播联动台 P1 MTC'] };

it('没有灯光工作的歌直接播放；可演出且端口、起始码、帧率都对上时直接播放', () => {
  const project = fixture();
  expect(lightingStartCheck(project, '串场', { portName: null, ports: [] })).toBeNull();
  expect(lightingStartCheck(project, '歌曲甲', port)).toBeNull();
  expect(lightingStartCheck(project, '歌曲甲', { portName: port.portName, ports: null })).toBeNull();
});

it('可演出的歌缺时间码端口或帧率不一致时给出原因', () => {
  const project = fixture();
  expect(lightingStartCheck(project, '歌曲甲', { portName: null, ports: null })).toBe('这首歌可以播放，但没有选择时间码输出端口');
  expect(lightingStartCheck(project, '歌曲甲', { portName: port.portName, ports: ['其他端口'] })).toBe('这首歌可以播放，但找不到时间码输出端口：团播联动台 P1 MTC');
  project.timebase.frameRate = '25';
  expect(lightingStartCheck(project, '歌曲甲', port)).toBe('这首歌可以播放，但帧率不一致：工程是 25 FPS，控台上是 30 FPS');
});

it('控台节目没同步最新改动或灯光需要处理时给出原因', () => {
  const project = fixture(), lighting = createLightingDocument(); lighting.tracks = [track(500)];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 2, name: '歌曲甲', readAt: '2026-10-22T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: 480000 }];
  project.rundown[0]!.lighting = lighting;
  expect(lightingStartCheck(project, '歌曲甲', port)).toBe('控台上的节目还没同步最新改动（1 项），带灯光播放会用控台上的旧版本。请先同步到控台，或选择不带灯光播放。');
  lighting.ma2Bindings[0]!.timeOriginMs = 0;
  expect(lightingStartCheck(project, '歌曲甲', port)).toMatch(/^这首歌的灯光需要处理：.*起点对不上/);
});
