import { expect, it } from 'vitest';
import { createEmptyLinkProject, nativeObsPrepareSchema, obsProgramSnapshotSchema, parseLinkProject } from '@tb/schema';
import { createObsProgramSnapshot, projectFromObsSnapshot, preciseSeekAssetIds } from './obs-program-snapshot';
import { compileManagedMediaTimeline } from './managed-media-timeline';

it('只投影当前节目的 OBS 输出，保留原工程全部其他通道及原始偏移', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('原工程'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', playback: { startMs: 2000, endMs: 10000, mtcOffsetMs: 480000, volume: 100, endAction: 'pause', shortcut: '' },
      cues: [{ id: 'mixed', name: '混合 Cue', timecode: { hours: 0, minutes: 0, seconds: 5, frames: 0 }, actions: [
        { id: 'obs', kind: 'obs.setProgramScene', label: '场景', sceneName: '机位 1' },
        { id: 'midi', kind: 'midi.noteOn', label: 'MIDI', portProfileId: 'lights', channel: 1, note: 1, velocity: 100 }
      ] }] }, { id: 'other', title: '另一节目', cues: [] }] });
  const before = JSON.stringify(project), snapshot = obsProgramSnapshotSchema.parse(createObsProgramSnapshot(project, 'song', 7));
  expect(snapshot.item.cues[0]?.actions.map(action => action.kind)).toEqual(['obs.setProgramScene']);
  expect(projectFromObsSnapshot(snapshot).rundown.map(item => item.id)).toEqual(['song']);
  expect(snapshot.item.cues[0]?.timecode.seconds).toBe(5);
  expect(JSON.stringify(project)).toBe(before);
  expect(snapshot).toMatchObject({ projectId: project.projectId, revision: 7 });
  expect(() => nativeObsPrepareSchema.parse({ version: 1, sessionId: crypto.randomUUID(), generation: 1,
    projectPath: 'C:/shows/test.tblink', snapshot, command: '任意命令' })).toThrow();
});

it('片段的样子要送 OBS 的歌（schema 3）照样能投影成画面工程，样子和是否送 OBS 都在快照里；样子变了快照就不同（0.5.9 E16）', () => {
  const look = { x: 0.25, y: 0.75, scale: 0.5, scaleX: 1, scaleY: 1, rotation: 10 };
  const project = parseLinkProject({ ...createEmptyLinkProject('样子'), schemaVersion: 3, playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 5000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', cues: [], referenceMediaClips: [{ id: 'clip', assetId: 'video', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      durationMs: 1000, canvasTransform: look, obsTransform: 'project' }] }] });
  const snapshot = obsProgramSnapshotSchema.parse(createObsProgramSnapshot(project, 'song', 0));
  expect(snapshot.item.referenceMediaClips[0]).toMatchObject({ canvasTransform: look, obsTransform: 'project' });
  expect(projectFromObsSnapshot(snapshot).rundown[0]!.referenceMediaClips[0]).toMatchObject({ canvasTransform: look, obsTransform: 'project' });
  const moved = parseLinkProject({ ...project, rundown: [{ ...project.rundown[0]!, referenceMediaClips: [{ ...project.rundown[0]!.referenceMediaClips[0]!, canvasTransform: { ...look, x: 0.5 } }] }] });
  expect(JSON.stringify(createObsProgramSnapshot(moved, 'song', 0))).not.toBe(JSON.stringify(createObsProgramSnapshot(project, 'song', 0)));
});

it('音乐后面留了空白的歌（schema 3）也能投影成画面工程（0.5.9 E14）', () => {
  const source = { assetId: 'music', relativePath: 'assets/reference-audio/music.wav', sha256: 'a'.repeat(64), durationMs: 20_000 };
  const file = { assetId: 'mix', relativePath: 'assets/reference-audio/mix.wav', sha256: 'b'.repeat(64), durationMs: 21_000 };
  const referenceAudio = { ...file, timeline: { source: file, segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs: 21_000 }],
    tracks: [{ id: 'music-track', title: '歌曲音频', source, segments: [{ id: 'music', startMs: 0, sourceOffsetMs: 0, durationMs: 20_000 }] }], durationMs: 21_000 } };
  const project = parseLinkProject({ ...createEmptyLinkProject('空白'), schemaVersion: 3, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues: [], referenceAudio }] });
  expect(projectFromObsSnapshot(createObsProgramSnapshot(project, 'song', 0)).rundown[0]!.referenceAudio?.timeline?.durationMs).toBe(21_000);
});

it('跨目标或损坏的媒体引用仍由完整工程关系校验拒绝', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('工程'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
  const snapshot = createObsProgramSnapshot(project, 'song', 0);
  snapshot.item.referenceMediaClips.push({ id: 'clip', assetId: 'missing', label: '错误素材', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1000,
    canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } });
  expect(() => projectFromObsSnapshot(snapshot)).toThrow();
});

it('零裁剪片段也可能在边界后或机位结束时进入，准备全部未结束素材的精确定位能力', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('定位准备'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: ['zero', 'trim', 'next'].map(id => ({ id, name: id, kind: 'video', relativePath: `${id}.mp4`, sha256: 'a'.repeat(64), byteLength: 1, durationMs: 5000, width: 1920, height: 1080 })),
    rundown: [{ id: 'song', title: '歌曲', referenceMediaClips: [
      { id: 'clip-zero', assetId: 'zero', label: '零点', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1000 },
      { id: 'clip-trim', assetId: 'trim', label: '源裁剪', sourceOffsetMs: 500, startTimecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 }, durationMs: 1000 },
      { id: 'clip-next', assetId: 'next', label: '下一段', startTimecode: { hours: 0, minutes: 0, seconds: 3, frames: 0 }, durationMs: 1000 }
    ], cues: [] }] });
  const snapshot = createObsProgramSnapshot(project, 'song', 0);
  expect([...preciseSeekAssetIds(snapshot, 0)]).toEqual(['zero', 'trim', 'next']);
  expect([...preciseSeekAssetIds(snapshot, 500)]).toEqual(['zero', 'trim', 'next']);
  expect([...preciseSeekAssetIds(snapshot, 1000)]).toEqual(['trim', 'next']);
  expect([...preciseSeekAssetIds(snapshot, 3000)]).toEqual(['next']);
  expect([...preciseSeekAssetIds(snapshot, 3500)]).toEqual(['next']);
  expect(() => preciseSeekAssetIds(snapshot, NaN)).toThrow('位置无效');
});

it('视频原声：不管谁放音乐、视频原声开没开、片段自己的开关、歌的音频是不是从这个素材来的，经画面快照算出来的和工程本身算出来的一样（0.5.9，P1 的画面）', () => {
  const asset = (id: string, kind: 'video' | 'audio') => ({ id, name: id, kind, relativePath: `${id}.${kind === 'video' ? 'mp4' : 'wav'}`,
    sha256: 'a'.repeat(64), byteLength: 1, durationMs: 5000, ...(kind === 'video' ? { width: 1920, height: 1080 } : {}) });
  const clip = (id: string, assetId: string, embeddedAudioEnabled: boolean | undefined) => ({ id, assetId, label: id, layerId: `${id}-layer`,
    startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1000, ...(embeddedAudioEnabled === undefined ? {} : { embeddedAudioEnabled }) });
  const layers = (clipId: string) => [{ id: `${clipId}-layer`, name: '轨道 1', visible: true, locked: false }];
  const sources = [{ playbackSource: 'p1' }, { playbackSource: 'internal' }, {}] as const;
  let compared = 0;
  for (const source of sources) for (const internalVideoAudio of [true, false, undefined]) for (const own of [true, false, undefined]) for (const contains of [true, false]) {
    const music = { assetId: 'music', relativePath: 'assets/music.wav', sha256: 'b'.repeat(64), durationMs: 5000 };
    const project = parseLinkProject({ ...createEmptyLinkProject('原声'), ...source, obsOutputMode: 'scenes',
      ...(internalVideoAudio === undefined ? {} : { internalVideoAudio }),
      mediaAssets: [asset('video', 'video'), asset('sound', 'audio')],
      rundown: [{ id: 'video-song', title: '视频', cues: [], referenceAudio: { ...music, ...(contains ? { sourceMediaAssetId: 'video' } : {}) },
        visualLayers: layers('video-clip'), referenceMediaClips: [clip('video-clip', 'video', own)] },
      { id: 'sound-song', title: '音频', cues: [], referenceAudio: { ...music, ...(contains ? { sourceMediaAssetId: 'sound' } : {}) },
        visualLayers: layers('sound-clip'), referenceMediaClips: [clip('sound-clip', 'sound', own)] }] });
    for (const itemId of ['video-song', 'sound-song']) {
      const sound = (value: typeof project) => compileManagedMediaTimeline(value, itemId).events.map(event => [event.id, event.embeddedAudioEnabled]);
      const direct = sound(project), viaSnapshot = sound(projectFromObsSnapshot(createObsProgramSnapshot(project, itemId, 0)));
      expect(viaSnapshot, JSON.stringify({ source, internalVideoAudio, own, contains, itemId })).toEqual(direct);
      // An audio clip the song's audio already plays is left out both ways.
      if (itemId === 'sound-song') expect(direct.length, JSON.stringify({ contains })).toBe(contains ? 0 : 2);
      compared++;
    }
  }
  expect(compared).toBe(108);
  // The case the snapshot used to get wrong: P1 plays the music and the clip's switch is on.
  const p1 = parseLinkProject({ ...createEmptyLinkProject('P1'), playbackSource: 'p1', obsOutputMode: 'scenes', mediaAssets: [asset('video', 'video')],
    rundown: [{ id: 'song', title: '歌曲', cues: [], visualLayers: layers('clip'), referenceMediaClips: [clip('clip', 'video', undefined)] }] });
  expect(compileManagedMediaTimeline(projectFromObsSnapshot(createObsProgramSnapshot(p1, 'song', 0)), 'song').events.map(event => event.embeddedAudioEnabled)).toEqual([true, true]);
});

it('联动台播放的歌，画面快照没有 playbackSource 这一项（和以前一样）；P1 的歌、没写播放方式的工程写 p1', () => {
  const project = (source: object) => parseLinkProject({ ...createEmptyLinkProject('播放方式'), ...source, obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
  const internal = createObsProgramSnapshot(project({ playbackSource: 'internal' }), 'song', 0);
  expect(Object.keys(internal)).toEqual(['version', 'projectId', 'revision', 'frameRate', 'outputCanvas', 'internalVideoAudio', 'item', 'assets']);
  expect(projectFromObsSnapshot(internal).playbackSource).toBe('internal');
  for (const source of [{ playbackSource: 'p1' }, {}]) {
    const snapshot = obsProgramSnapshotSchema.parse(createObsProgramSnapshot(project(source), 'song', 0));
    expect(snapshot.playbackSource).toBe('p1');
    expect(projectFromObsSnapshot(snapshot).playbackSource).toBe('p1');
  }
});
