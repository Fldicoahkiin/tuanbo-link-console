import { createEmptyLinkProject, type LinkCue } from '@tb/schema';
import { CueActionRunner, compileScheduledTimelineCues, MANAGED_OBS_SCENE_NAME, type LinkDesktopApi, type ManagedMediaEvent } from '@tb/core/link';
import { describe, expect, it, vi } from 'vitest';
import {
  collectManagedOutputCleanupAfter,
  ManagedMediaExecutionError,
  ManagedOutputRuntime,
  type ManagedOutputRuntimeDependencies
} from '@tb/core/link';

describe('ManagedOutputRuntime', () => {
  it('场景模式暂停后继续底层媒体，只恢复时钟，不抢占机位或重播', async () => {
    const project = createEmptyLinkProject('机位期间暂停'); project.obsOutputMode = 'scenes';
    const dependencies = createDependencies();
    const runtime = new ManagedOutputRuntime(project, 'C:/show.tblink', dependencies);
    await runtime.executeMedia(event(), 'rehearsal');
    const execute = vi.fn<(action: LinkCue['actions'][number]) => Promise<void>>(() => Promise.resolve());
    const runner = new CueActionRunner([{ id: 'obs', supports: () => true, execute }]);
    await runtime.executeTransport(runner, 'pause', 360);
    await runtime.executeTransport(runner, 'start', 360);
    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ kind: 'obs.mediaAction', action: 'pause' }),
      expect.objectContaining({ kind: 'obs.mediaAction', action: 'start' })
    ]);
    expect(dependencies.executeManagedMediaEvent).toHaveBeenCalledTimes(1);
  });
  it('直播模式记录 OBS 素材失败并允许后续时间线继续', async () => {
    const dependencies = createDependencies(new Error('OBS 媒体源启动失败'));
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);

    await expect(runtime.executeMedia(event(), 'live')).resolves.toMatchObject({
      status: 'failed',
      error: 'OBS 媒体源启动失败'
    });
    expect(dependencies.recordLog).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'failed' }));
    expect(runtime.takeCleanup().mediaEvents).toMatchObject([{ phase: 'stop', clipId: 'clip' }]);
  });

  it('排练模式记录失败后阻断当前批次', async () => {
    const dependencies = createDependencies(new Error('OBS 媒体源启动失败'));
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);

    await expect(runtime.executeMedia(event(), 'rehearsal')).rejects.toBeInstanceOf(ManagedMediaExecutionError);
    expect(dependencies.recordLog).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'failed' }));
  });

  it('素材动作每次只记一条结果日志，带耗时；执行前不写「执行中」', async () => {
    const dependencies = createDependencies();
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);
    await runtime.executeMedia(event(), 'live');
    expect(dependencies.recordLog).toHaveBeenCalledTimes(1);
    const [entry] = dependencies.recordLog.mock.calls[0]!;
    expect(entry).toMatchObject({ level: 'info', result: 'succeeded' });
    expect(typeof entry.details?.['durationMs']).toBe('number');
  });

  it('成功启动后允许同一片段停止并生成独立执行记录', async () => {
    const dependencies = createDependencies();
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);
    const start = event();
    const stop: ManagedMediaEvent = { ...start, id: 'managed-media:clip:stop', phase: 'stop', frameNumber: 30 };

    await expect(runtime.executeMedia(start, 'rehearsal')).resolves.toMatchObject({ status: 'succeeded' });
    await expect(runtime.executeMedia(stop, 'rehearsal')).resolves.toMatchObject({ status: 'succeeded' });
    expect(dependencies.executeManagedMediaEvent).toHaveBeenCalledTimes(2);
  });

  it('没有启动过的片段：停止不发给 OBS，记一条跳过和原因', async () => {
    const dependencies = createDependencies();
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);
    const stop: ManagedMediaEvent = { ...event(), id: 'managed-media:clip:stop', phase: 'stop', frameNumber: 30 };

    await expect(runtime.executeMedia(stop, 'live')).resolves.toMatchObject({ status: 'skipped', error: '对应的片段这次没有成功启动' });
    expect(dependencies.executeManagedMediaEvent).not.toHaveBeenCalled();
    expect(dependencies.recordLog).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'skipped', message: '停止素材 · video.mp4 · skipped：对应的片段这次没有成功启动' }));
  });

  it('重同步时将此前未执行的素材边界记为 skipped 且不调用 OBS', async () => {
    const dependencies = createDependencies();
    const project = createEmptyLinkProject('测试');
    project.mediaAssets = [{
      id: 'asset', name: 'video.mp4', kind: 'video', folderId: null,
      relativePath: 'assets/reference-media/video.mp4', sha256: 'a'.repeat(64),
      byteLength: 10, durationMs: 1_000, width: 1080, height: 1920
    }];
    project.rundown = [{
      id: 'item', title: '节目', enabled: true, notes: '',
      visualLayers: [{ id: 'layer', name: '图层 1', visible: true, locked: false }],
      referenceMediaClips: [{
        id: 'clip', assetId: 'asset', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        durationMs: 1_000, label: 'video.mp4', layerId: 'layer',
        canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
      }],
      cues: []
    }];
    const runtime = new ManagedOutputRuntime(project, 'C:\\show\\test.tblink', dependencies);
    runtime.selectItem('item');

    const crossed = runtime.collectThrough(30);
    await expect(runtime.reportSkippedMedia(crossed, 'MTC 丢失期间已越过')).resolves.toMatchObject([
      { status: 'skipped', event: { phase: 'start' }, error: 'MTC 丢失期间已越过' },
      { status: 'skipped', event: { phase: 'stop' }, error: 'MTC 丢失期间已越过' }
    ]);
    expect(runtime.collectThrough(30)).toEqual([]);
    expect(dependencies.executeManagedMediaEvent).not.toHaveBeenCalled();
    expect(dependencies.recordLog).toHaveBeenCalledTimes(2);
    expect(dependencies.recordLog).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'skipped' }));
  });

  it('运行停止清理在 OBS 停止动作执行前保留已启动片段', async () => {
    const dependencies = createDependencies();
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);

    await expect(runtime.executeMedia(event(), 'live')).resolves.toMatchObject({ status: 'succeeded' });
    const [cleanup] = runtime.takeCleanup().mediaEvents;
    if (!cleanup) throw new Error('测试未生成停止清理动作');

    await expect(runtime.executeMedia(cleanup, 'live')).resolves.toMatchObject({ status: 'succeeded' });
    const secondRequest = dependencies.executeManagedMediaEvent.mock.calls[1]?.[0];
    expect(secondRequest?.event).toMatchObject({ phase: 'stop', clipId: 'clip' });
    expect(runtime.takeCleanup().mediaEvents).toEqual([]);
  });

  it('旧素材停止失败后新类型素材仍启动时保留两者供最终清理', async () => {
    const dependencies = createDependencies();
    dependencies.executeManagedMediaEvent.mockImplementation(({ event: current }) => (
      current.phase === 'stop' && current.clipId === 'video-clip'
        ? Promise.reject(new Error('旧视频停止失败'))
        : Promise.resolve()
    ));
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);
    const videoStart = { ...event(), clipId: 'video-clip', sourceName: 'managed-video' };
    const videoStop: ManagedMediaEvent = { ...videoStart, id: 'video-stop', phase: 'stop', frameNumber: 30 };
    const imageStart: ManagedMediaEvent = {
      ...videoStart,
      id: 'image-start',
      clipId: 'image-clip',
      sourceName: 'managed-image',
      assetKind: 'image',
      assetName: 'still.png',
      relativePath: 'assets/reference-media/still.png'
    };

    await expect(runtime.executeMedia(videoStart, 'live')).resolves.toMatchObject({ status: 'succeeded' });
    await expect(runtime.executeMedia(videoStop, 'live')).resolves.toMatchObject({ status: 'failed' });
    await expect(runtime.executeMedia(imageStart, 'live')).resolves.toMatchObject({ status: 'succeeded' });
    expect(runtime.takeCleanup().mediaEvents.map((current) => current.sourceName)).toEqual([
      'managed-video',
      'managed-image'
    ]);
  });

  it('停止请求等待已排队的 OBS 启动完成后再采集清理列表', async () => {
    let startRequested = false;
    let releaseStart = (): void => { throw new Error('测试未进入 OBS 启动动作'); };
    const dependencies = createDependencies();
    dependencies.executeManagedMediaEvent.mockImplementation(({ event: current }) => (
      current.phase === 'start'
        ? new Promise<void>((resolve) => { startRequested = true; releaseStart = resolve; })
        : Promise.resolve()
    ));
    const runtime = new ManagedOutputRuntime(createEmptyLinkProject('测试'), 'C:\\show\\test.tblink', dependencies);
    const pendingStart = runtime.executeMedia(event(), 'live').then(() => undefined);
    const pendingCleanup = collectManagedOutputCleanupAfter(pendingStart, runtime);

    await vi.waitFor(() => expect(startRequested).toBe(true));
    releaseStart();

    await expect(pendingCleanup).resolves.toMatchObject({
      mediaEvents: [{ phase: 'stop', clipId: 'clip' }]
    });
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

  it('机位切换隐藏失败时保留全部活动来源供停止清理，重试成功后同步移除旧来源', () => {
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
    runtime.applyRetriedVisualAction(second.id, hidePrevious, 'succeeded');
    expect(runtime.takeCleanup().cameraCues.map((cue) => cue.actions[0])).toMatchObject([
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
