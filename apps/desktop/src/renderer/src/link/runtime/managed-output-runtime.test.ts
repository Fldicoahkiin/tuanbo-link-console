import { createEmptyLinkProject, type LinkCue } from '@tb/schema';
import { compileScheduledTimelineCues, MANAGED_OBS_SCENE_NAME, type LinkDesktopApi, type ManagedMediaEvent } from '@tb/core/link';
import { describe, expect, it, vi } from 'vitest';
import {
  ManagedMediaExecutionError,
  ManagedOutputRuntime,
  type ManagedOutputRuntimeDependencies
} from '@tb/core/link';

describe('ManagedOutputRuntime', () => {
  it('直播模式记录 OBS 素材失败并允许后续时间线继续', async () => {
    const dependencies = createDependencies(new Error('OBS 媒体源启动失败'));
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);

    await expect(runtime.sendMedia(event(), 'live')).resolves.toMatchObject({
      status: 'failed',
      error: 'OBS 媒体源启动失败'
    });
    expect(dependencies.recordLog).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'failed' }));
  });

  it('排练模式记录失败后阻断当前批次', async () => {
    const dependencies = createDependencies(new Error('OBS 媒体源启动失败'));
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);

    await expect(runtime.sendMedia(event(), 'rehearsal')).rejects.toBeInstanceOf(ManagedMediaExecutionError);
    expect(dependencies.recordLog).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'failed' }));
  });

  it('素材动作每次只记一条结果日志，带耗时；执行前不写「执行中」', async () => {
    const dependencies = createDependencies();
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);
    await runtime.sendMedia(event(), 'live');
    expect(dependencies.recordLog).toHaveBeenCalledTimes(1);
    const [entry] = dependencies.recordLog.mock.calls[0]!;
    expect(entry).toMatchObject({ level: 'info', result: 'succeeded' });
    expect(typeof entry.details?.['durationMs']).toBe('number');
  });

  it('OBS duration 结束隐藏成功后清除受管来源且运行停止不再重复清理', () => {
    const project = createEmptyLinkProject('测试');
    const cue: LinkCue = {
      id: 'camera', name: '显示机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      durationMs: 1_000, enabled: true, notes: '', layerId: 'layer', actions: [{
        id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled',
        sceneName: MANAGED_OBS_SCENE_NAME, sourceName: '机位一', enabled: true
      }]
    };
    project.rundown = [{
      id: 'item', title: '节目', enabled: true, notes: '',
      visualLayers: [{ id: 'layer', name: '图层 1', visible: true, locked: false }],
      referenceMediaClips: [], cues: [cue]
    }];
    const runtime = new ManagedOutputRuntime(project, 'C:\\show\\test.tblink', createDependencies());
    const [show, hide] = compileScheduledTimelineCues([cue], '30');
    if (!show || !hide) throw new Error('测试未生成完整显示/隐藏事件');
    runtime.selectItem('item');
    const executionShow = runtime.compileVisualCue(show.cue);
    runtime.applyVisualCueResult(show.cue, executionShow, executionShow.actions.map((action) => ({ actionId: action.id, status: 'succeeded' })));
    expect(runtime.takeCleanup().cameraCues).toMatchObject([{ actions: [{ kind: 'obs.setSceneItemEnabled', enabled: false, sourceName: '机位一' }] }]);

    runtime.selectItem('item');
    const secondShow = runtime.compileVisualCue(show.cue);
    runtime.applyVisualCueResult(show.cue, secondShow, secondShow.actions.map((action) => ({ actionId: action.id, status: 'succeeded' })));
    runtime.applyVisualCueResult(hide.cue, hide.cue, hide.cue.actions.map((action) => ({ actionId: action.id, status: 'succeeded' })));
    expect(runtime.takeCleanup().cameraCues).toEqual([]);
  });

  it('机位切换隐藏失败时保留全部活动来源供停止清理', () => {
    const project = createEmptyLinkProject('测试');
    const camera = (id: string, sourceName: string): LinkCue => ({
      id, name: id, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      enabled: true, notes: '', layerId: 'layer', actions: [{
        id: `show-${id}`, label: `显示 ${sourceName}`, kind: 'obs.setSceneItemEnabled',
        sceneName: MANAGED_OBS_SCENE_NAME, sourceName, enabled: true
      }]
    });
    const first = camera('first', '机位一');
    const second = camera('second', '机位二');
    project.rundown = [{
      id: 'item', title: '节目', enabled: true, notes: '',
      visualLayers: [{ id: 'layer', name: '图层 1', visible: true, locked: false }],
      referenceMediaClips: [], cues: [first, second]
    }];
    const runtime = new ManagedOutputRuntime(project, 'C:\\show\\test.tblink', createDependencies());
    runtime.selectItem('item');
    const firstExecution = runtime.compileVisualCue(first);
    runtime.applyVisualCueResult(first, firstExecution, firstExecution.actions.map((action) => ({ actionId: action.id, status: 'succeeded' })));
    const secondExecution = runtime.compileVisualCue(second);
    const hidePrevious = secondExecution.actions.find((action) => action.id.startsWith('second:hide-previous:'));
    if (!hidePrevious) throw new Error('测试未生成隐藏上一来源动作');
    runtime.applyVisualCueResult(second, secondExecution, secondExecution.actions.map((action) => ({
      actionId: action.id,
      status: action.id === hidePrevious.id ? 'failed' : 'succeeded'
    })));

    expect(runtime.takeCleanup().cameraCues.map((cue) => cue.actions[0])).toMatchObject([
      { sourceName: '机位一', enabled: false },
      { sourceName: '机位二', enabled: false }
    ]);
  });

  it('OBS 显示动作只要开始尝试就纳入停止清理', () => {
    const project = createEmptyLinkProject('测试');
    const cue: LinkCue = {
      id: 'camera', name: '显示机位', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      durationMs: 1_000, enabled: true, notes: '', layerId: 'layer', actions: [{
        id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled',
        sceneName: MANAGED_OBS_SCENE_NAME, sourceName: '机位一', enabled: true
      }]
    };
    project.rundown = [{
      id: 'item', title: '节目', enabled: true, notes: '',
      visualLayers: [{ id: 'layer', name: '图层 1', visible: true, locked: false }],
      referenceMediaClips: [], cues: [cue]
    }];
    const runtime = new ManagedOutputRuntime(project, 'C:\\show\\test.tblink', createDependencies());
    runtime.selectItem('item');

    runtime.trackVisualActionAttempt(cue.id, cue.actions[0]!);

    expect(runtime.takeCleanup().cameraCues).toMatchObject([{
      actions: [{ sourceName: '机位一', enabled: false }]
    }]);
  });
});

function createDependencies(failure?: Error): ManagedOutputRuntimeDependencies & {
  executeManagedMediaEvent: ReturnType<typeof vi.fn<LinkDesktopApi['executeManagedMediaEvent']>>;
  recordLog: ReturnType<typeof vi.fn<LinkDesktopApi['recordLog']>>;
} {
  const executeManagedMediaEvent = vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(() => {
    if (failure) return Promise.reject(failure);
    return Promise.resolve();
  });
  const recordLog = vi.fn<LinkDesktopApi['recordLog']>((entry) => Promise.resolve({
    ...entry,
    id: crypto.randomUUID(),
    sessionId: 'test-session',
    timestamp: '2026-08-27T00:00:00.000Z',
    monotonicMs: 0
  }));
  return { executeManagedMediaEvent, recordLog };
}

function event(): ManagedMediaEvent {
  return {
    id: 'managed-media:clip:start',
    phase: 'start',
    frameNumber: 0,
    itemId: 'item',
    clipId: 'clip',
    layerId: 'layer',
    layerIndex: 0,
    layerCount: 1,
    sourceName: '团播联动台·素材·video·来源',
    sceneName: '团播联动台·素材·video',
    assetId: 'asset',
    assetName: 'video.mp4',
    assetKind: 'video',
    relativePath: 'assets/reference-media/video.mp4',
    sourceOffsetMs: 0,
    embeddedAudioEnabled: true,
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
  };
}
