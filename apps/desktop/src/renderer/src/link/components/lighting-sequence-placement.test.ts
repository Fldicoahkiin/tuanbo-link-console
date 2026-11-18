import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingUserLibrary, createLightingDocument, parseLinkProject, type LightingTrack } from '@tb/schema';
import { placeLightingTemplate as placeEffect, lightingSequenceSteps, ma2SongPoints } from '@tb/core/link';
import { useLightingEffectStamp } from './useLightingEffectStamp';
import { useDocumentStore } from '../stores/document-store';
import { useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { syncMa2Once } from '../runtime/ma2-realtime-session';
import * as sequenceLibrary from '../view-models/ma2-sequence-library';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
vi.mock('../runtime/ma2-song-sync', () => ({ ma2SongSyncSettings: () => ({ nextSequence: 9000, executorPage: 1000 }) }));
vi.mock('../runtime/ma2-realtime-session', () => ({ syncMa2Once: vi.fn() }));
const sequence = { sequence: 10, complete: true, cues: [1, 2, 3].map(number => ({ number: `${number}.000`, name: `第 ${number} 步` })) };
function fixture() {
  const document = createLightingDocument(); document.tempos = [{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }];
  const track: LightingTrack = { id: 'template', name: '三步', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: 10, cue: '1.000', executor: '' } };
  document.templates = [{ id: 'sequence', name: '三步', nativeSequence: true, track }];
  return document;
}
it('整套三步按一拍依次放入，形成三个独立同步点而非合成一步', () => {
  const result = placeEffect(fixture(), { effectId: 'sequence', ms: 1000, id: 'first' }, 10000, [sequence]);
  expect(ma2SongPoints(result).map(point => [point.atMs, point.cues[0]?.cue])).toEqual([[1000, '1.000'], [1500, '2.000'], [2000, '3.000']]);
  expect(new Set(ma2SongPoints(result).map(point => point.id)).size).toBe(3);
});
it('实际添加入口首次创建后请求同一逐首同步，再添加只更新原时间线', () => {
  const lighting = fixture();
  const project = parseLinkProject({ ...createEmptyLinkProject('联调'), schemaVersion: 2, rundown: [{ id: 'song', title: '新节目', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 60000 }, lighting }] });
  project.ma2MaterialLibrary = { version: 2, source: 'console', library: { directory: { show: 'show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), fixtureUsage: [], errors: [], sequences: [{ sequence: 10, name: '三步', cues: sequence.cues.map((cue, index) => ({ ...cue, index })) }] },
    userLibrary: { ...createLightingUserLibrary(), entries: [{ id: 'sequence', name: '三步', originalName: '三步', revision: 1, kind: 'sequence', categoryIds: [], favorite: false, source: { endpoint: 'console', show: 'show', verified: true }, track: lighting.templates[0]!.track }] } };
  useDocumentStore.getState().setProject(project, 'C:/test/project.tblink');
  const notify = vi.fn();
  // The material library reads the same complete sequence used by native dragging.
  vi.spyOn(sequenceLibrary, 'ma2SequenceLibrary').mockReturnValue([{ ...sequence, name: '三步' }]);
  vi.mocked(syncMa2Once).mockClear();
  const actions = useLightingEffectStamp('song', lighting, 60000, notify);
  actions.stamp('sequence', 1000);
  const first = useDocumentStore.getState().project!.rundown[0]!.lighting!;
  expect(notify).not.toHaveBeenCalled();
  expect(first.timelineDestination).toEqual({ name: '新节目', sequence: 9000, timecode: 9000, executor: '1000.101' });
  expect(syncMa2Once).toHaveBeenCalledExactlyOnceWith('song');
  actions.stamp('sequence', 5000);
  expect(notify).not.toHaveBeenCalled();
  expect(ma2SongPoints(useDocumentStore.getState().project!.rundown[0]!.lighting!)).toHaveLength(6);
  expect(syncMa2Once).toHaveBeenCalledTimes(1);
  useDocumentStore.getState().setProject(project, 'C:/test/project.tblink');
  useLightingEffectStamp('song', lighting, 60000, notify).stampConsoleCue({ sequence: 10, cue: '2.000', name: '第 2 步', executor: '' }, 7000);
  const single = useDocumentStore.getState().project!.rundown[0]!.lighting!;
  expect(single.timelineDestination?.timecode).toBe(9000);
  expect(ma2SongPoints(single)).toMatchObject([{ atMs: 7000, cues: [{ sequence: 10, cue: '2.000' }] }]);
  expect(syncMa2Once).toHaveBeenLastCalledWith('song');
  useDocumentStore.getState().setProject(project, 'C:/test/project.tblink');
  useMa2RealtimePreference.setState({ enabled: false });
  try {
    vi.mocked(syncMa2Once).mockClear();
    useLightingEffectStamp('song', lighting, 60000, notify).stampConsoleCue({ sequence: 10, cue: '2.000', name: '第二步', executor: '' }, 7500);
    expect(useDocumentStore.getState().project!.rundown[0]!.lighting!.timelineDestination?.timecode).toBe(9000);
    expect(syncMa2Once).not.toHaveBeenCalled();
  } finally { useMa2RealtimePreference.setState({ enabled: true }); }
  vi.restoreAllMocks();
});
it('可调间隔按节拍图换算；未读完整或放不下时整个操作失败，原编排不变', () => {
  const document = fixture();
  expect(lightingSequenceSteps(document, sequence, '', 0, 2).map(step => step.delayMs)).toEqual([0, 1000, 2000]);
  expect(() => placeEffect(document, { effectId: 'sequence', ms: 0, id: 'first' }, 900, [sequence])).toThrow('歌曲结尾');
  expect(() => placeEffect(document, { effectId: 'sequence', ms: 0, id: 'first' }, 10000, [{ ...sequence, complete: false }])).toThrow('还没读完整');
  expect(document.tracks).toEqual([]);
});

it('已识别的歌曲使用真实拍点及分数拍，优先于默认 120 BPM', () => {
  const beats = { state: 'ready' as const, method: 'ibt' as const, taskId: 'test', bpm: 100, beatsPerBar: 4,
    beats: [0, 600, 1300, 2100].map((atMs, i) => ({ id: String(i), sourceId: String(i), atMs, strong: i === 0 })), segments: [], editPointsMs: [], pieces: [] };
  expect(lightingSequenceSteps(fixture(), sequence, '', 0, 1, beats).map(step => step.delayMs)).toEqual([0, 600, 1300]);
  expect(ma2SongPoints(placeEffect(fixture(), { effectId: 'sequence', ms: 0, id: 'first' }, 10000, [sequence], 1, beats)).map(point => point.atMs)).toEqual([0, 600, 1300]);
  expect(lightingSequenceSteps(fixture(), sequence, '', 300, 0.5, beats).map(step => step.delayMs)).toEqual([0, 300, 650]);
  const intro = { ...beats, beats: [980, 8140.000000000001, 8680, 9220].map((atMs, i) => ({ id: String(i), sourceId: String(i), atMs, strong: false })) };
  expect(lightingSequenceSteps(fixture(), sequence, '', 0, 1, intro)[0]?.delayMs).toBe(0);
});
