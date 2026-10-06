import { expect, it } from 'vitest';
import { createEmptyLinkProject, nativeObsPrepareSchema, obsProgramSnapshotSchema, parseLinkProject } from '@tb/schema';
import { createObsProgramSnapshot, projectFromObsSnapshot, preciseSeekAssetIds } from './obs-program-snapshot';

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
