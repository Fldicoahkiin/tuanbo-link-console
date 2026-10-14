import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject } from '@tb/schema';
import { ObsProgramSession } from './obs-program-session';
import type { CueExecutionReport } from './cue-action-runner';
import type { RuntimeUpdate } from './cue-runtime';
import type { LinkDesktopApi } from './link-desktop-contract';

function fixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('后台画面'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues: [0, 1, 2, 3].map(seconds => ({ id: `cue-${seconds}`, name: `机位 ${seconds}`,
      timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, actions: [
        { id: `action-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `场景 ${seconds}` }
      ] })) }] });
}
function setup(project = fixture(), execute?: (action: LinkAction) => Promise<void>) {
  let now = 0;
  const actions: LinkAction[] = [], reports: CueExecutionReport[] = [], states: RuntimeUpdate[] = [];
  const dependencies = { now: () => now, recordLog: vi.fn<LinkDesktopApi['recordLog']>(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now })), executeManagedMediaEvent: vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(() => Promise.resolve()),
    guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
    prepareOutputs: vi.fn(() => Promise.resolve()), releaseOutputs: vi.fn(() => Promise.resolve()),
    prepareUpcoming: vi.fn<NonNullable<import('./obs-program-session').ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve()),
    seekMedia: vi.fn(() => Promise.resolve()), mediaReport: vi.fn(), cueReport: (report: CueExecutionReport) => reports.push(report),
    state: (state: RuntimeUpdate) => states.push(state),
    executor: { id: 'obs-test', supports: (action: LinkAction) => action.kind.startsWith('obs.'),
      execute: async (action: LinkAction) => { actions.push(action); await execute?.(action); } } };
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', dependencies);
  const advance = async (from: number, through: number) => {
    for (let time = from; time <= through; time += 100) { now = time; session.clock(time); await session.settled(); }
  };
  return { session, actions, reports, states, dependencies, advance, time: (value: number) => { now = value; } };
}

it('后台预备最多一个在途，停止使其失效并等待完成再清理', async () => {
  const test = setup();
  let release = (): void => { throw new Error('测试未初始化'); };
  test.dependencies.prepareUpcoming.mockImplementation(async (_frame, assertCurrent) => {
    await new Promise<void>(resolve => { release = resolve; }); assertCurrent();
  });
  await test.session.prepare(0); await test.advance(0, 500);
  expect(test.dependencies.prepareUpcoming).toHaveBeenCalledTimes(1);
  const stopped = test.session.stop();
  await Promise.resolve(); expect(test.dependencies.releaseOutputs).not.toHaveBeenCalled();
  release(); await stopped;
  expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
  expect(test.session.error).toBeNull();
  test.time(1000); test.session.clock(1000);
  expect(test.dependencies.prepareUpcoming).toHaveBeenCalledTimes(1);
});

it('后台预备失败结束画面通道，不重试，不补发后续动作', async () => {
  const test = setup(); test.dependencies.prepareUpcoming.mockRejectedValue(new Error('下一视频不能解码'));
  await test.session.prepare(0); await test.advance(0, 3000);
  expect(test.session.error?.message).toBe('下一视频不能解码');
  expect(test.dependencies.prepareUpcoming).toHaveBeenCalledTimes(1);
  expect(test.actions.some(action => action.id === 'action-1')).toBe(false);
  await test.session.stop(); expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
});

it('原生时钟驱动节目顺序，不需要界面回调；重复设备位置不重复触发', async () => {
  const test = setup(); await test.session.prepare(0);
  expect(test.actions).toEqual([]);
  await test.advance(0, 3000); test.session.clock(3000); await test.session.settled();
  expect(test.actions.map(action => action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind)).toEqual(['场景 0', '场景 1', '场景 2', '场景 3']);
  expect(test.session.error).toBeNull(); expect(test.session.pendingCount).toBe(0);
});

it('管道中积压的位置不能按收到时刻重新获得执行窗口', async () => {
  const test = setup(); await test.session.prepare(0);
  test.time(200); test.session.clock(0, 0); await test.session.settled();
  expect(test.actions).toEqual([]);
  expect(test.session.error?.message).toContain('100ms');
  test.time(250); test.session.clock(250, 250); await test.session.settled();
  expect(test.actions).toEqual([]);
});

it('设备观察年龄和本机排队耗时共同计入画面执行边界', async () => {
  const test = setup(); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1060); test.session.clock(1000, 1000);
  test.time(1110); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  expect(test.session.error?.message).toContain('100ms');
});

it('从中间准备只恢复当前画面，不补发已越过的历史动作，未来事件继续一次', async () => {
  const test = setup(); await test.session.prepare(1500);
  expect(test.actions.map(action => action.id)).toEqual(['action-1']);
  test.time(20000); test.session.clock(1500); await test.session.settled();
  for (let at = 1600; at <= 3000; at += 100) { test.time(20000 + at - 1500); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-1', 'action-2', 'action-3']);
  expect(test.session.error).toBeNull();
});

it('暂停即作废排队动作；恢复从实际音频位置继续', async () => {
  const test = setup(); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await test.session.pause();
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  test.time(5000); test.session.clock(1000); await test.session.settled();
  for (let at = 1100; at <= 2000; at += 100) { test.time(5000 + at - 1000); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-2']);
  expect(test.session.error).toBeNull();
});

it('停止先使旧代数失效，在途动作完成后不再发送队列里的下一条', async () => {
  let release: () => void = () => { throw new Error('测试未开始'); };
  let sent: () => void = () => { throw new Error('测试未初始化'); };
  const started = new Promise<void>(resolve => { sent = resolve; });
  const test = setup(fixture(), () => new Promise<void>(resolve => { release = resolve; sent(); }));
  await test.session.prepare(0); test.session.clock(0);
  await started;
  const stopping = test.session.stop(); release(); await stopping;
  test.time(1000); test.session.clock(1000); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  expect(test.states.at(-1)?.state).toBe('idle');
});

it('请求拖延后不补发过时画面，并明确标识该通道失败', async () => {
  const test = setup(); await test.session.prepare(0);
  test.session.clock(0); test.time(101); await test.session.settled();
  expect(test.actions).toEqual([]);
  expect(test.session.error?.message).toContain('100ms');
  test.time(1000); test.session.clock(1000); await test.session.settled();
  expect(test.actions).toEqual([]);
});

it('OBS 失败不继续该通道的后续动作，不自动重试', async () => {
  const project = fixture(); project.rundown[0]!.cues[0]!.actions.push({ id: 'next', label: '滤镜', kind: 'obs.setSourceFilterEnabled', sourceName: '机位', filterName: '调整', enabled: true });
  const test = setup(project, () => Promise.reject(new Error('OBS 无响应')));
  await test.session.prepare(0); test.session.clock(0); await test.session.settled();
  expect(test.actions).toHaveLength(1); expect(test.session.error?.message).toContain('OBS 无响应');
  await test.advance(100, 2000); expect(test.actions).toHaveLength(1);
});

it('无效或跳变的实际音频位置会冻结通道，不猜测补发', async () => {
  for (const position of [NaN, -1, 86400000, 5000]) {
    const test = setup(); await test.session.prepare(0); await test.advance(0, 0);
    test.time(10); test.session.clock(position); await test.session.settled();
    expect(test.session.error).not.toBeNull(); expect(test.actions).toHaveLength(1);
  }
});

it('准备期间取消，迟到场景确认不会继续后续初始化', async () => {
  let release: () => void = () => { throw new Error('测试未开始'); };
  let sent: () => void = () => { throw new Error('测试未初始化'); };
  const started = new Promise<void>(resolve => { sent = resolve; });
  const test = setup(fixture(), () => new Promise<void>(resolve => { release = resolve; sent(); }));
  const preparing = expect(test.session.prepare(1500)).rejects.toThrow('已取消');
  await started;
  const stopping = test.session.stop(); release(); await preparing; await stopping;
  expect(test.dependencies.seekMedia).not.toHaveBeenCalled(); expect(test.states.at(-1)?.state).toBe('idle');
});

it('晚收到设备时钟也按事件原定位置计算延迟，不将收包时间当作事件时间', async () => {
  const test = setup(); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1150); test.session.clock(1150); await test.session.settled();
  expect(test.session.error?.message).toContain('100ms');
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
});

function videoFixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('视频'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 10000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'video-layer', name: '视频' }], referenceMediaClips: [{ id: 'clip', assetId: 'video', layerId: 'video-layer', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 10000 }], cues: [] }] });
}

it.each([0, 150])('机位覆盖结束只恢复叠加显隐，持续播放的视频不重发；应答耗时 %i ms', async latency => {
  const project = videoFixture(), item = project.rundown[0]!;
  project.mediaAssets.push({ ...project.mediaAssets[0]!, id: 'overlay', kind: 'image', name: '叠加', relativePath: 'assets/overlay.png' });
  item.visualLayers.unshift({ id: 'overlay', name: '叠加', visible: true, locked: false }, { id: 'camera', name: '机位', visible: true, locked: false });
  item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'overlay', assetId: 'overlay', layerId: 'overlay' });
  item.cues.push({ id: 'camera', name: '覆盖', notes: '', enabled: true, layerId: 'camera', durationMs: 200,
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, actions: [{ id: 'camera', label: '机位', kind: 'obs.setProgramScene', sceneName: '机位' }] });
  let compositions = 0;
  const test = setup(project, () => { if (++compositions === 3) test.time(1200 + latency); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1200); await test.advance(1400, 2000);
  expect(test.session.error).toBeNull();
  expect(test.dependencies.executeManagedMediaEvent.mock.calls.map(call => call[0].event.clipId)).toEqual(['overlay', 'clip']);
  await test.session.stop();
  expect(test.dependencies.executeManagedMediaEvent.mock.calls.filter(call => call[0].event.phase === 'stop')).toHaveLength(2);
});

it('单路视频被全屏机位覆盖后只切回素材场景，清理仍能关闭活动素材', async () => {
  const project = videoFixture(), item = project.rundown[0]!;
  item.visualLayers.unshift({ id: 'camera', name: '机位', visible: true, locked: false });
  item.cues.push({ id: 'camera', name: '覆盖', notes: '', enabled: true, layerId: 'camera', durationMs: 200,
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, actions: [{ id: 'camera', label: '机位', kind: 'obs.setProgramScene', sceneName: '机位' }] });
  const test = setup(project); await test.session.prepare(0); await test.advance(0, 2000);
  expect(test.session.error).toBeNull();
  expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledTimes(1);
  expect(test.actions.at(-1)).toMatchObject({ kind: 'obs.setProgramScene', sceneName: test.dependencies.executeManagedMediaEvent.mock.calls[0]![0].event.sceneName });
  await test.session.stop(); expect(test.dependencies.executeManagedMediaEvent.mock.calls.at(-1)?.[0].event.phase).toBe('stop');
});

it('同帧叠加视频并行启动，停止等待全部在途结果后逐一清理且不重发', async () => {
  const project = videoFixture(), item = project.rundown[0]!, original = item.referenceMediaClips[0]!;
  for (let index = 1; index < 4; index++) {
    project.mediaAssets.push({ ...project.mediaAssets[0]!, id: `video-${index}`, name: `视频 ${index}` });
    item.visualLayers.push({ id: `layer-${index}`, name: `层 ${index}`, visible: true, locked: false });
    item.referenceMediaClips.push({ ...original, id: `clip-${index}`, assetId: `video-${index}`, layerId: `layer-${index}` });
  }
  const test = setup(parseLinkProject(project)), started: string[] = [];
  let release = (): void => { throw new Error('测试未初始化'); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  test.dependencies.executeManagedMediaEvent.mockImplementation(async payload => {
    if (payload.event.phase === 'start') { started.push(payload.event.assetId); await gate; }
  });
  await test.session.prepare(0); test.session.clock(0);
  await vi.waitFor(() => expect(started).toHaveLength(4));
  const stopping = test.session.stop(); release(); await stopping;
  expect(test.dependencies.executeManagedMediaEvent.mock.calls.filter(call => call[0].event.phase === 'stop')).toHaveLength(4);
  test.time(1000); test.session.clock(1000); await test.session.settled();
  expect(started).toHaveLength(4);
});

it('同帧自有叠加确认在途不挡住媒体启动，停止仍等待所有在途请求', async () => {
  const project = videoFixture(), item = project.rundown[0]!;
  project.mediaAssets.push({ ...project.mediaAssets[0]!, id: 'second', name: '第二路' });
  item.visualLayers.push({ id: 'second', name: '第二层', visible: true, locked: false });
  item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'second', assetId: 'second', layerId: 'second' });
  let release = (): void => { throw new Error('尚未开始'); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const test = setup(project, () => gate);
  await test.session.prepare(0); test.session.clock(0);
  await vi.waitFor(() => expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledTimes(2));
  let stopped = false; const stopping = test.session.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  release(); await stopping;
  expect(test.dependencies.executeManagedMediaEvent.mock.calls.filter(call => call[0].event.phase === 'stop')).toHaveLength(2);
});

it('素材动作日志等待期间过期，不在日志返回后补发媒体启动', async () => {
  const test = setup(videoFixture());
  test.dependencies.recordLog.mockImplementation(entry => {
    if (entry.result === 'running') test.time(101);
    return Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: 101 });
  });
  await test.session.prepare(0); test.session.clock(0); await test.session.settled();
  expect(test.dependencies.executeManagedMediaEvent).not.toHaveBeenCalled();
  expect(test.session.error?.message).toContain('100ms');
});

it('暂停和继续只改变活动视频播放状态，不重建片段或从头重播', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0); await test.advance(0, 1000);
  await test.session.pause(); test.time(5000); test.session.clock(1000); await test.session.settled();
  expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledTimes(1);
  expect(test.actions.map(action => action.kind === 'obs.mediaAction' ? action.action : action.kind)).toEqual(['pause', 'start']);
  await Promise.all([test.session.stop(), test.session.stop()]);
  expect(test.dependencies.executeManagedMediaEvent.mock.calls.map(call => call[0].event.phase)).toEqual(['start', 'stop']);
});

it('恢复媒体也遵守设备观察的截止时间，排队过期不会迟到启动', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0); await test.advance(0, 1000);
  await test.session.pause();
  test.time(5060); test.session.clock(1000, 5000); test.time(5110); await test.session.settled();
  expect(test.actions.map(action => action.kind === 'obs.mediaAction' ? action.action : action.kind)).toEqual(['pause']);
  expect(test.session.error?.message).toContain('100ms');
});
