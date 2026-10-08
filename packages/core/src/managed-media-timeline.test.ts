import { describe, expect, it } from 'vitest';
import { parseLinkProject } from '@tb/schema';
import { collectCrossedManagedMediaEvents, compileManagedMediaTimeline, managedMediaSourceName, materialSceneTargets } from './managed-media-timeline';
import { SceneOutputTimeline } from './scene-output-timeline';
import { editReferenceAudioCommand, setReferenceAudioCommand } from './link-command';
import { audioTracks, audioSegments } from './audio-edit';
import { allocateMediaTimecodeRanges } from './mtc-output';
import { resolveTimelineState } from './timeline-state';

describe('managed media timeline', () => {
  it('同一素材跨轨叠加使用独立来源和播放位置，同轨分割继续复用自己的解码器', () => {
    const project = projectWithClips([clip('one', 'video', 'layer-top', 0, 1000)]);
    project.obsOutputMode = 'scenes';
    const item = project.rundown[0]!;
    item.visualLayers.push({ id: 'layer-second', name: '轨道 2', visible: true, locked: false });
    item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'two', layerId: 'layer-second', sourceOffsetMs: 300 });
    item.referenceMediaClips.push({ ...item.referenceMediaClips[1]!, id: 'three', startTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
    const starts = compileManagedMediaTimeline(project, 'item').events.filter(event => event.phase === 'start');
    expect(starts[0]!.sourceName).not.toBe(starts[1]!.sourceName);
    expect(starts[1]!.sourceName).toBe(starts[2]!.sourceName);
    expect(starts[1]!.sourceOffsetMs).toBe(300);
    const targets = materialSceneTargets(project);
    expect(targets).toHaveLength(2);
    expect(starts.every(event => targets.some(target => target.sourceName === event.sourceName && target.sceneName === event.sceneName))).toBe(true);
    const action = new SceneOutputTimeline(project, 'item').at(0).cues[0]!.cue.actions[0]!;
    expect(action.kind === 'obs.setProgramScene' && new Set(action.sceneLayers).size).toBe(2);
  });
  it('旧视频主音频转多轨再删除，不会重新打开视频原声', () => {
    const project = projectWithClips([clip('one', 'video', 'layer-top', 0, 1000)]);
    const source = { assetId: 'music', relativePath: 'assets/music.wav', sha256: 'a'.repeat(64), durationMs: 1000, sourceMediaAssetId: 'asset-one' };
    project.rundown[0]!.referenceAudio = source;
    const mixed = { ...source, sourceMediaAssetId: undefined, timeline: { source, segments: audioSegments(source), tracks: audioTracks(source) } };
    const converted = editReferenceAudioCommand('item', mixed, '转换多轨').execute(project);
    expect(converted.rundown[0]!.referenceMediaClips[0]!.embeddedAudioEnabled).toBe(false);
    const removed = setReferenceAudioCommand('item', null).execute(converted);
    expect(resolveTimelineState(removed, removed.rundown[0]!, 0).activeAudioClipIds).toEqual([]);
  });
  it('视频完整原声替换一秒歌曲后统一主控时长，并阻止多个图层重复发声', () => {
    const project = projectWithClips([clip('one', 'video', 'layer-top', 0, 1000)]);
    project.rundown[0]!.visualLayers.push({ id: 'layer-bottom', name: '图层 2', visible: true, locked: false });
    project.rundown[0]!.referenceMediaClips.push({ ...project.rundown[0]!.referenceMediaClips[0]!, id: 'two', layerId: 'layer-bottom' });
    project.playbackSource = 'internal';
    project.internalVideoAudio = true;
    const short = { assetId: 'short', relativePath: 'assets/short.wav', sha256: 'a'.repeat(64), durationMs: 1000 };
    project.rundown[0]!.referenceAudio = short;
    const command = setReferenceAudioCommand('item', { ...short, assetId: 'full', durationMs: 37883, sourceMediaAssetId: 'asset-one' });
    const updated = command.execute(project);
    expect(allocateMediaTimecodeRanges(updated)[0]?.durationMs).toBe(37883);
    expect(compileManagedMediaTimeline(updated, 'item').events.every((event) => !event.embeddedAudioEnabled)).toBe(true);
    expect(resolveTimelineState(updated, updated.rundown[0]!, 0).activeAudioClipIds).toEqual([]);
    expect(command.undo(project).rundown[0]?.referenceAudio).toEqual(short);
  });
  it('内部音乐主控默认关闭视频原声，只在用户启用时混入', () => {
    const project = projectWithClips([clip('video', 'video', 'layer-top', 0, 1000)]); project.playbackSource = 'internal';
    expect(compileManagedMediaTimeline(project, 'item').events[0]?.embeddedAudioEnabled).toBe(false);
    project.internalVideoAudio = true;
    expect(compileManagedMediaTimeline(project, 'item').events[0]?.embeddedAudioEnabled).toBe(true);
  });
  it('compiles video clips into deterministic start and stop events with embedded audio', () => {
    const timeline = compileManagedMediaTimeline(projectWithClips([
      clip('clip-video', 'video', 'layer-top', 0, 1_000)
    ]), 'item');
    expect(timeline.events).toMatchObject([
      { id: 'managed-media:clip-video:start', phase: 'start', frameNumber: 0, embeddedAudioEnabled: true, assetKind: 'video' },
      { id: 'managed-media:clip-video:stop', phase: 'stop', frameNumber: 30, embeddedAudioEnabled: true, assetKind: 'video' }
    ]);
    expect(timeline.events[0]?.sourceName).toBe(managedMediaSourceName('project', 'layer-top', 'video'));
  });

  it('does not publish standalone reference audio to OBS', () => {
    const timeline = compileManagedMediaTimeline(projectWithClips([
      clip('clip-audio', 'audio', 'layer-top', 0, 1_000)
    ]), 'item');
    expect(timeline.events).toEqual([]);
  });

  it('does not publish media from a hidden visual layer to OBS', () => {
    const value = projectWithClips([clip('clip-video', 'video', 'layer-top', 0, 1_000)]);
    value.rundown[0]!.visualLayers[0]!.visible = false;
    expect(compileManagedMediaTimeline(value, 'item').events).toEqual([]);
  });

  it('orders a stop before the next start on the same frame', () => {
    const timeline = compileManagedMediaTimeline(projectWithClips([
      clip('first', 'video', 'layer-top', 0, 1_000),
      clip('second', 'video', 'layer-top', 30, 1_000)
    ]), 'item');
    expect(timeline.events.map((event) => `${event.frameNumber}:${event.phase}:${event.clipId}`)).toEqual([
      '0:start:first',
      '30:stop:first',
      '30:start:second',
      '60:stop:second'
    ]);
  });

  it('同一图层的图片与视频使用不同 OBS 输入，避免来源类型冲突', () => {
    const timeline = compileManagedMediaTimeline(projectWithClips([
      clip('first', 'image', 'layer-top', 0, 1_000),
      clip('second', 'video', 'layer-top', 30, 1_000)
    ]), 'item');
    const starts = timeline.events.filter((event) => event.phase === 'start');

    expect(starts.map((event) => event.sourceName)).toEqual([
      managedMediaSourceName('project', 'layer-top', 'image'),
      managedMediaSourceName('project', 'layer-top', 'video')
    ]);
  });

  it('清洗或截断后可读名称相同的图层仍生成不同 OBS 来源名', () => {
    const commonPrefix = 'layer-with-the-same-very-long-prefix-';
    expect(managedMediaSourceName('project', `${commonPrefix}a/b`, 'video'))
      .not.toBe(managedMediaSourceName('project', `${commonPrefix}a?b`, 'video'));
  });

  it('rejects overlapping visual clips on the same layer', () => {
    expect(() => compileManagedMediaTimeline(projectWithClips([
      clip('first', 'video', 'layer-top', 0, 2_000),
      clip('second', 'video', 'layer-top', 30, 1_000)
    ]), 'item')).toThrow('同一视觉图层的时间片段不能重叠');
  });

  it('uses the same strict crossing rule and never replays executed events', () => {
    const timeline = compileManagedMediaTimeline(projectWithClips([
      clip('clip-video', 'video', 'layer-top', 30, 1_000)
    ]), 'item');
    expect(collectCrossedManagedMediaEvents(timeline.events, 29, 30, new Set()).map((event) => event.phase)).toEqual(['start']);
    expect(collectCrossedManagedMediaEvents(timeline.events, 30, 60, new Set(['managed-media:clip-video:stop']))).toEqual([]);
    expect(collectCrossedManagedMediaEvents(timeline.events, 60, 20, new Set())).toEqual([]);
  });
});

function clip(id: string, kind: 'audio' | 'video' | 'image', layerId: string, startFrame: number, durationMs: number) {
  return { id, kind, layerId, startFrame, durationMs };
}

function projectWithClips(values: Array<ReturnType<typeof clip>>) {
  return parseLinkProject({
    schemaVersion: 1,
    projectId: 'project',
    name: '工程',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    timebase: { frameRate: '30', mode: 'per-item-reset' },
    mediaFolders: [],
    mediaAssets: values.map((value) => ({
      id: `asset-${value.id}`,
      name: value.id,
      kind: value.kind,
      folderId: null,
      relativePath: `assets/reference-media/${value.id}.${value.kind === 'image' ? 'png' : value.kind === 'video' ? 'mp4' : 'wav'}`,
      sha256: 'a'.repeat(64),
      byteLength: 10,
      ...(value.kind !== 'image' ? { durationMs: value.durationMs } : {}),
      ...(value.kind !== 'audio' ? { width: 1080, height: 1920 } : {})
    })),
    rundown: [{
      id: 'item',
      title: '节目',
      enabled: true,
      notes: '',
      visualLayers: [{ id: 'layer-top', name: '图层 1', visible: true, locked: false }],
      referenceMediaClips: values.map((value) => ({
        id: value.id,
        assetId: `asset-${value.id}`,
        startTimecode: { hours: 0, minutes: 0, seconds: Math.floor(value.startFrame / 30), frames: value.startFrame % 30 },
        durationMs: value.durationMs,
        label: value.id,
        layerId: value.layerId,
        canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
      })),
      cues: []
    }]
  });
}
