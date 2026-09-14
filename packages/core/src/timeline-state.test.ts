import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, parseLinkProject, type LinkProject, type MtcFrameRate } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import {
  compileScheduledTimelineCues,
  quantizeTimelineRange,
  resolveTimelineClipSpan,
  resolveTimelineCueSpan,
  resolveTimelineState,
  wasTimelineFrameCrossed
} from './timeline-state';

describe('timeline state', () => {
  it('对本地片段使用统一半开区间边界', () => {
    const value = project();
    expect(activeClipIds(value, 999)).toEqual([]);
    expect(activeClipIds(value, 1_000)).toEqual(['video-clip']);
    expect(activeClipIds(value, 2_000)).toEqual(['video-clip']);
    expect(activeClipIds(value, 2_999)).toEqual(['video-clip']);
    expect(activeClipIds(value, 3_000)).toEqual([]);
    expect(activeClipIds(value, 3_001)).toEqual([]);
  });

  it('OBS 显示 Cue 到 durationMs 结束时立即失效', () => {
    const value = project();
    expect(activeObsIds(value, 999)).toEqual([]);
    expect(activeObsIds(value, 1_000)).toEqual(['obs-clip']);
    expect(activeObsIds(value, 2_999)).toEqual(['obs-clip']);
    expect(activeObsIds(value, 3_000)).toEqual([]);
    expect(activeObsIds(value, 9_000)).toEqual([]);
  });

  it('从结束后倒拖回片段内会重新显示，再倒拖到开始前会消失', () => {
    const value = project();
    expect(resolveTimelineState(value, value.rundown[0]!, 5_000).activeVisualClipIds).toEqual([]);
    expect(resolveTimelineState(value, value.rundown[0]!, 2_000).activeVisualClipIds).toEqual(['video-clip']);
    expect(resolveTimelineState(value, value.rundown[0]!, 500).activeVisualClipIds).toEqual([]);
  });

  it('停用 OBS Cue 和隐藏图层都会立即移除有效内容，锁定不影响播放', () => {
    const value = project();
    value.rundown[0]!.cues[0]!.enabled = false;
    expect(activeObsIds(value, 2_000)).toEqual([]);
    value.rundown[0]!.cues[0]!.enabled = true;
    value.rundown[0]!.visualLayers[0]!.visible = false;
    value.rundown[0]!.visualLayers[1]!.locked = true;
    const state = resolveTimelineState(value, value.rundown[0]!, 2_000);
    expect(state.activeObsCueIds).toEqual([]);
    expect(state.activeVisualClipIds).toEqual(['video-clip']);
  });

  it('图层数组第一项始终是顶部，重排后有效内容顺序同步改变', () => {
    const value = project({ includeObs: false, includeSecondClip: true });
    const before = resolveTimelineState(value, value.rundown[0]!, 2_000);
    expect(before.activeVisualClipIds).toEqual(['image-clip', 'video-clip']);
    value.rundown[0]!.visualLayers.reverse();
    const after = resolveTimelineState(value, value.rundown[0]!, 2_000);
    expect(after.activeVisualClipIds).toEqual(['video-clip', 'image-clip']);
  });

  it('同一 OBS 来源的两个非重叠片段各自按自己的区间生效', () => {
    const value = project();
    value.rundown[0]!.cues.push({
      id: 'obs-again', name: '再次显示', timecode: frameNumberToTimecode(120, '30'), durationMs: 1_000,
      enabled: true, notes: '', layerId: 'top', actions: [{
        id: 'show-again', label: '再次显示', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: 'Camera', enabled: true
      }]
    });
    expect(activeObsIds(value, 2_000)).toEqual(['obs-clip']);
    expect(activeObsIds(value, 3_500)).toEqual([]);
    expect(activeObsIds(value, 4_000)).toEqual(['obs-again']);
    expect(activeObsIds(value, 5_000)).toEqual([]);
  });

  it('关闭视频内嵌音频只移除可听状态，视频画面仍然有效', () => {
    const value = project();
    value.rundown[0]!.referenceMediaClips[0]!.embeddedAudioEnabled = false;
    const state = resolveTimelineState(value, value.rundown[0]!, 2_000);
    expect(state.activeVisualClipIds).toEqual(['video-clip']);
    expect(state.activeAudioClipIds).toEqual([]);
  });

  it('独立音频跟随所属图层的显隐，且不会成为视觉片段', () => {
    const value = project({ includeObs: false });
    value.rundown[0]!.visualLayers[1]!.visible = false;
    value.rundown[0]!.referenceMediaClips = [{
      id: 'audio-clip', assetId: 'audio', startTimecode: frameNumberToTimecode(30, '30'),
      sourceOffsetMs: 0, durationMs: 2_000, label: 'Audio', layerId: 'bottom',
      canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM
    }];
    value.mediaAssets.push({
      id: 'audio', name: 'Audio', kind: 'audio', folderId: null,
      relativePath: 'assets/reference-media/audio.wav', sha256: 'c'.repeat(64), byteLength: 10,
      durationMs: 10_000
    });

    const state = resolveTimelineState(value, value.rundown[0]!, 2_000);
    expect(state.activeClipIds).toEqual([]);
    expect(state.activeVisualClipIds).toEqual([]);
    expect(state.activeAudioClipIds).toEqual([]);
    value.rundown[0]!.visualLayers[1]!.visible = true;
    const visibleState = resolveTimelineState(value, value.rundown[0]!, 2_000);
    expect(visibleState.activeClipIds).toEqual(['audio-clip']);
    expect(visibleState.activeAudioClipIds).toEqual(['audio-clip']);
  });

  it.each(['25', '30', '29.97df'] as const)('%s 在帧边界前有效、结束帧起失效', (frameRate) => {
    const value = project({ frameRate, includeObs: false });
    const clip = value.rundown[0]!.referenceMediaClips[0]!;
    const span = resolveTimelineClipSpan(clip, frameRate);
    expect(activeClipIds(value, span.startMs)).toEqual(['video-clip']);
    expect(activeClipIds(value, span.endMs - 0.001)).toEqual(['video-clip']);
    expect(activeClipIds(value, span.endMs)).toEqual([]);
  });

  it.each(['25', '30', '29.97df'] as const)('%s 的非整帧 duration 在参考舞台与运行时使用同一结束帧', (frameRate) => {
    const value = project({ frameRate });
    const cue = value.rundown[0]!.cues[0]!;
    cue.durationMs = 7_067;
    const span = resolveTimelineCueSpan(cue, frameRate);
    const durationEnd = compileScheduledTimelineCues([cue], frameRate).find((event) => event.cue.id.endsWith(':duration-end'));
    expect(durationEnd?.scheduledFrame).toBe(span.endFrame);
    expect(activeObsIds(value, span.endMs - 0.001)).toEqual(['obs-clip']);
    expect(activeObsIds(value, span.endMs)).toEqual([]);
  });

  it('快速跨过 OBS 开始和结束边界时按显示后隐藏顺序生成事件', () => {
    const value = project();
    const events = compileScheduledTimelineCues(value.rundown[0]!.cues, '30');
    const crossed = events.filter((event) => wasTimelineFrameCrossed(29, 91, event.scheduledFrame));
    expect(crossed.map((event) => event.cue.id)).toEqual(['obs-clip', 'obs-clip:duration-end']);
    expect(crossed.at(-1)?.cue.actions).toMatchObject([{ kind: 'obs.setSceneItemEnabled', enabled: false }]);
  });

  it('相邻 OBS 片段在同一帧始终先隐藏旧片段再显示新片段', () => {
    const first: LinkProject['rundown'][number]['cues'][number] = {
      id: 'first', name: '第一个片段', timecode: frameNumberToTimecode(30, '30'), durationMs: 1_000,
      enabled: true, notes: '', layerId: 'top', actions: [{
        id: 'show-first', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: 'Camera', enabled: true
      }]
    };
    const second: LinkProject['rundown'][number]['cues'][number] = {
      id: 'second', name: '第二个片段', timecode: frameNumberToTimecode(60, '30'), durationMs: 1_000,
      enabled: true, notes: '', layerId: 'top', actions: [{
        id: 'show-second', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: 'Camera', enabled: true
      }]
    };

    const boundary = compileScheduledTimelineCues([second, first], '30').filter((event) => event.scheduledFrame === 60);

    expect(boundary.map((event) => event.cue.id)).toEqual(['first:duration-end', 'second']);
    expect(boundary.map((event) => event.cue.actions[0])).toMatchObject([
      { kind: 'obs.setSceneItemEnabled', enabled: false },
      { kind: 'obs.setSceneItemEnabled', enabled: true }
    ]);
  });

  it('关闭吸附后的连续预览在提交时按工程帧率量化为合法区间', () => {
    expect(quantizeTimelineRange(1_016, 2_019, '30')).toMatchObject({
      startTimecode: frameNumberToTimecode(30, '30'),
      durationMs: 2_033
    });
    const dropFrame = quantizeTimelineRange(60_060, 1_001, '29.97df');
    expect(dropFrame.startTimecode).toEqual({ hours: 0, minutes: 1, seconds: 0, frames: 2 });
    expect(quantizeTimelineRange(0, 1_001, '30', 999).endMs).toBeLessThanOrEqual(999);
  });

  it('超长素材上限直接量化且结束毫秒不会在 24 小时处回绕', () => {
    const nearDayEnd = quantizeTimelineRange(86_399_000, 2_000, '30');
    expect(nearDayEnd.endMs).toBe(86_401_000);
    expect(quantizeTimelineRange(0, 86_400_000, '30', 1_000).endMs).toBe(1_000);
  });

  it('旧 OBS 显示 Cue 缺少 durationMs 时工程解析明确失败', () => {
    const raw = project();
    delete raw.rundown[0]!.cues[0]!.durationMs;
    expect(() => parseLinkProject(raw)).toThrow('缺少 durationMs');
  });
});

function activeClipIds(value: LinkProject, playheadMs: number): string[] {
  return resolveTimelineState(value, value.rundown[0]!, playheadMs).activeVisualClipIds;
}

function activeObsIds(value: LinkProject, playheadMs: number): string[] {
  return resolveTimelineState(value, value.rundown[0]!, playheadMs).activeObsCueIds;
}

function project(input: { frameRate?: MtcFrameRate; includeObs?: boolean; includeSecondClip?: boolean } = {}): LinkProject {
  const frameRate = input.frameRate ?? '30';
  const startFrame = frameRate === '25' ? 25 : 30;
  const includeObs = input.includeObs ?? true;
  const mediaAssets = [{
    id: 'video', name: 'Video', kind: 'video' as const, folderId: null,
    relativePath: 'assets/reference-media/video.mp4', sha256: 'a'.repeat(64), byteLength: 10,
    durationMs: 10_000, width: 1080, height: 1920
  }, {
    id: 'image', name: 'Image', kind: 'image' as const, folderId: null,
    relativePath: 'assets/reference-media/image.png', sha256: 'b'.repeat(64), byteLength: 10,
    width: 1080, height: 1920
  }];
  return parseLinkProject({
    schemaVersion: 1,
    projectId: 'project',
    name: '工程',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    timebase: { frameRate, mode: 'per-item-reset' },
    mediaFolders: [],
    mediaAssets,
    rundown: [{
      id: 'item', title: '节目', enabled: true, notes: '',
      visualLayers: [
        { id: 'top', name: '顶部', visible: true, locked: false },
        { id: 'bottom', name: '底部', visible: true, locked: false }
      ],
      referenceMediaClips: [{
        id: 'video-clip', assetId: 'video', startTimecode: frameNumberToTimecode(startFrame, frameRate),
        sourceOffsetMs: 0, durationMs: 2_000, label: 'Video', layerId: 'bottom'
      }, ...(input.includeSecondClip ? [{
        id: 'image-clip', assetId: 'image', startTimecode: frameNumberToTimecode(startFrame, frameRate),
        sourceOffsetMs: 0, durationMs: 2_000, label: 'Image', layerId: 'top'
      }] : [])],
      cues: includeObs ? [{
        id: 'obs-clip', name: '显示机位', timecode: frameNumberToTimecode(startFrame, frameRate), durationMs: 2_000,
        enabled: true, notes: '', layerId: 'top', actions: [{
          id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: 'Camera', enabled: true
        }]
      }] : []
    }]
  });
}
