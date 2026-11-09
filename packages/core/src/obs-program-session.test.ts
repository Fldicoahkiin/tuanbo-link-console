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
  const actions: LinkAction[] = [], reports: CueExecutionReport[] = [], states: RuntimeUpdate[] = [], faults: string[] = [];
  const dependencies = { now: () => now, fault: (message: string) => faults.push(message), recordLog: vi.fn<LinkDesktopApi['recordLog']>(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now })), executeManagedMediaEvent: vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(() => Promise.resolve()),
    guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
    prepareOutputs: vi.fn(() => Promise.resolve()), releaseOutputs: vi.fn(() => Promise.resolve()),
    prepareUpcoming: vi.fn<NonNullable<import('./obs-program-session').ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve(null)),
    seekMedia: vi.fn<import('./obs-program-session').ObsProgramSessionDependencies['seekMedia']>(() => Promise.resolve()), mediaReport: vi.fn(), cueReport: (report: CueExecutionReport) => reports.push(report),
    state: (state: RuntimeUpdate) => states.push(state),
    executor: { id: 'obs-test', supports: (action: LinkAction) => action.kind.startsWith('obs.'),
      execute: async (action: LinkAction) => { actions.push(action); await execute?.(action); } } };
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', dependencies);
  const advance = async (from: number, through: number) => {
    for (let time = from; time <= through; time += 100) { now = time; session.clock(time); await session.settled(); }
  };
  return { session, actions, reports, states, faults, dependencies, advance, time: (value: number) => { now = value; } };
}

it('后台预备最多一个在途，停止使其失效并等待完成再清理', async () => {
  const test = setup();
  let release = (): void => { throw new Error('测试未初始化'); };
  test.dependencies.prepareUpcoming.mockImplementation(async (_frame, assertCurrent) => {
    await new Promise<void>(resolve => { release = resolve; }); assertCurrent(); return null;
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

it('直播中后台预备失败标红，不重试，后续画面动作照常执行', async () => {
  const test = setup(); test.dependencies.prepareUpcoming.mockRejectedValueOnce(new Error('下一视频不能解码'));
  await test.session.prepare(0); await test.advance(0, 3000);
  expect(test.session.error).toBeNull();
  expect(test.faults[0]).toContain('下一视频不能解码');
  expect(test.dependencies.prepareUpcoming.mock.calls.filter(call => call[0] === 0)).toHaveLength(1);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2', 'action-3']);
  await test.session.stop(); expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
});

it('原生时钟驱动节目顺序，不需要界面回调；重复设备位置不重复触发', async () => {
  const test = setup(); await test.session.prepare(0);
  expect(test.actions).toEqual([]);
  await test.advance(0, 3000); test.session.clock(3000); await test.session.settled();
  expect(test.actions.map(action => action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind)).toEqual(['场景 0', '场景 1', '场景 2', '场景 3']);
  expect(test.session.error).toBeNull(); expect(test.session.pendingCount).toBe(0);
});

it('每个画面动作只记一条结果日志，带耗时；排队和执行中不写日志', async () => {
  const test = setup(); await test.session.prepare(0);
  await test.advance(0, 3000); await test.session.settled();
  const actionLogs = test.dependencies.recordLog.mock.calls.map(([entry]) => entry).filter(entry => entry.category === 'action');
  expect(actionLogs.map(entry => entry.message)).toEqual(['切机位 · succeeded', '切机位 · succeeded', '切机位 · succeeded', '切机位 · succeeded']);
  expect(actionLogs.every(entry => typeof entry.details?.['durationMs'] === 'number')).toBe(true);
});

it('画面动作失败时日志写明原因，记为错误', async () => {
  const test = setup(undefined, action => action.kind === 'obs.setProgramScene' && action.sceneName === '场景 1' ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 1000); await test.session.settled();
  const failed = test.dependencies.recordLog.mock.calls.map(([entry]) => entry).filter(entry => entry.result === 'failed');
  expect(failed).toEqual([expect.objectContaining({ level: 'error', message: '切机位 · failed：OBS 无响应' })]);
});

const lateLogs = (test: ReturnType<typeof setup>): string[] => test.dependencies.recordLog.mock.calls.map(([entry]) => entry)
  .filter(entry => entry.level === 'warning').map(entry => entry.message);

it('管道中积压的位置晚到也照常执行：越过的画面动作现在发出并记晚到日志，之后照常（2026-11-09 不能漏切）', async () => {
  const test = setup(); await test.session.prepare(0);
  test.time(200); test.session.clock(0, 0); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
  expect(lateLogs(test)).toEqual(['画面动作晚了 200 ms 才发出：机位 0。电脑或 OBS 当时太忙，画面已经按时间线切过去了']);
  test.time(250); test.session.clock(250, 250); await test.session.settled();
  for (let at = 300; at <= 1000; at += 100) { test.time(at); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
});

it('位置更新中断超过 100ms 按当前位置重建画面并标红：间隔内的机位此刻切换，后续动作继续', async () => {
  const test = setup(); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1100); test.session.clock(1100); await test.session.settled();
  expect(test.faults).toEqual(['播放位置更新中断了 200 ms，画面已按当前位置恢复']);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
  expect(test.session.error).toBeNull();
  await test.advance(1200, 2000);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2']);
});

it('设备观察年龄和本机排队耗时都算晚到：晚了照样切过去并记日志，不会停在上一个机位', async () => {
  const test = setup(); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1060); test.session.clock(1000, 1000);
  test.time(1110); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
  expect(lateLogs(test)).toEqual([expect.stringContaining('晚了 110 ms 才发出：机位 1')]);
  await test.advance(1200, 2000);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2']);
});

it('从中间准备只恢复当前画面，不补发已越过的历史动作，未来事件继续一次', async () => {
  const test = setup(); await test.session.prepare(1500);
  expect(test.actions.map(action => action.id)).toEqual(['action-1']);
  test.time(20000); test.session.clock(1500); await test.session.settled();
  for (let at = 1600; at <= 3000; at += 100) { test.time(20000 + at - 1500); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-1', 'action-2', 'action-3']);
  expect(test.session.error).toBeNull();
});

it('暂停时还没发出的切换，继续时按当前位置补上，暂停的时间不算晚到（继续时再恢复当前有效画面）', async () => {
  const test = setup(); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await test.session.pause();
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  test.time(5000); test.session.clock(1000); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
  for (let at = 1100; at <= 2000; at += 100) { test.time(5000 + at - 1000); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2']);
  expect(lateLogs(test)).toEqual([]); expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

it('暂停时正在发的切换照常发完：继续时按当前位置接着切，已发出的点 Cue 不重发', async () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台画面'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-top', name: '特写' }, { id: 'layer-base', name: '全景' }], cues: [
      { id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'base', kind: 'obs.setProgramScene', label: '切机位', sceneName: '全景' }] },
      { id: 'cue-close', name: '特写', layerId: 'layer-top', durationMs: 100, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
        actions: [{ id: 'close', kind: 'obs.setProgramScene', label: '切机位', sceneName: '特写' },
          { id: 'filter', kind: 'obs.setSourceFilterEnabled', label: '滤镜', sourceName: '特写', filterName: '调色', enabled: true }] }] }] });
  let release = (): void => { throw new Error('测试未初始化'); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const test = setup(project, action => action.id === 'close' ? gate : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(test.actions.map(action => action.id)).toEqual(['base', 'filter', 'close']));
  const pausing = test.session.pause(); release(); await pausing;
  // Resumed 100 ms later, after the close-up ended: OBS shows it, the timeline shows the wide shot.
  test.time(5000); test.session.clock(1100); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['base', 'filter', 'close', 'base']);
  for (let at = 1200; at <= 2000; at += 100) { test.time(5000 + at - 1100); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['base', 'filter', 'close', 'base']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
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

it('排队拖延超过 1 秒的画面动作仍然发出并标红，通道继续执行后续画面', async () => {
  const test = setup(); await test.session.prepare(0);
  test.session.clock(0); test.time(1500); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  expect(test.faults).toEqual(['画面动作晚了 1500 ms 才发出：机位 0。电脑或 OBS 当时太忙，画面已经按时间线切过去了']); expect(test.session.error).toBeNull();
  expect(test.reports[0]?.results.map(result => result.status)).toEqual(['succeeded']);
  await test.advance(200, 1000);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
});

it('直播中 OBS 动作失败标红并继续后续动作，失败动作不自动重试', async () => {
  const project = fixture(); project.rundown[0]!.cues[0]!.actions.push({ id: 'next', label: '滤镜', kind: 'obs.setSourceFilterEnabled', sourceName: '机位', filterName: '调整', enabled: true });
  const test = setup(project, action => action.id === 'action-0' ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve());
  await test.session.prepare(0); test.session.clock(0); await test.session.settled();
  expect(test.actions.map(action => action.id).sort()).toEqual(['action-0', 'next']);
  expect(test.reports.flatMap(report => report.results).map(result => [result.actionId, result.status]).sort()).toEqual([['action-0', 'failed'], ['next', 'succeeded']]);
  expect(test.session.error).toBeNull();
  await test.advance(100, 2000);
  expect(test.actions.map(action => action.id).slice(2)).toEqual(['action-1', 'action-2']);
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

function videoFixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('视频'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 10000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'video-layer', name: '视频' }], referenceMediaClips: [{ id: 'clip', assetId: 'video', layerId: 'video-layer', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 10000 }], cues: [] }] });
}

it('素材预备晚于播放边界：起播失败标红，预备完成后按当前位置起播一次并标红，同一片段不再重复', async () => {
  const project = videoFixture(); project.rundown[0]!.referenceMediaClips[0]!.startTimecode.seconds = 1;
  const test = setup(project), calls = test.dependencies.executeManagedMediaEvent.mock.calls;
  test.dependencies.executeManagedMediaEvent.mockRejectedValueOnce(new Error('下一素材未在播放边界前准备完成：视频'));
  await test.session.prepare(0); await test.advance(0, 1100);
  expect(calls).toHaveLength(1); const overdue = calls[0]![0].event;
  test.dependencies.prepareUpcoming.mockResolvedValueOnce(overdue); await test.advance(1200, 1600);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  const late = calls[1]![0].event, lateMs = late.sourceOffsetMs;
  expect(late).toMatchObject({ clipId: overdue.clipId, phase: 'start' }); expect(lateMs).toBeGreaterThanOrEqual(200);
  expect(test.faults).toContain(`素材准备得晚了，已按当前位置开始播放：视频（晚了 ${lateMs} ms）`);
  test.dependencies.prepareUpcoming.mockResolvedValueOnce(overdue); await test.advance(1700, 2400); await test.session.settled();
  expect(calls).toHaveLength(2); expect(test.session.error).toBeNull();
});

it('OBS 重新连接后先重新准备场景，再按当前位置重建：素材定位到对齐位置后统一播放，不走预热起播', async () => {
  const project = videoFixture(); project.rundown[0]!.referenceMediaClips[0]!.startTimecode.seconds = 1;
  const test = setup(project), calls = test.dependencies.executeManagedMediaEvent.mock.calls, order: string[] = [];
  test.dependencies.executeManagedMediaEvent.mockRejectedValueOnce(new Error('OBS 未连接'));
  await test.session.prepare(0); await test.advance(0, 1500);
  expect(calls.map(call => call[0].event.phase)).toEqual(['start']);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  expect(await test.session.rebuild(() => { order.push('restore'); return Promise.resolve(); })).toEqual({ sent: 1, failure: null });
  expect(order).toEqual(['restore', 'seek 500']);
  expect(test.actions.at(-1)).toMatchObject({ kind: 'obs.mediaAction', action: 'start' });
  await test.advance(1600, 2000); expect(calls).toHaveLength(1); expect(test.session.error).toBeNull();
  await test.session.stop(); expect(calls.at(-1)?.[0].event.phase).toBe('stop');
});

it('重建失败交给调用方报告，画面照常按当前位置重建；尚未开始时不重建，暂停时等继续再重新准备场景、按当前位置重建', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0);
  const restore = vi.fn(() => Promise.resolve());
  expect(await test.session.rebuild(restore)).toEqual({ sent: 0, failure: null }); expect(restore).not.toHaveBeenCalled();
  await test.advance(0, 500);
  expect(await test.session.rebuild(() => Promise.reject(new Error('素材文件不可读')))).toEqual({ sent: 1, failure: '素材文件不可读' });
  expect(test.dependencies.seekMedia.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([500]);
  expect(test.session.error).toBeNull(); await test.advance(600, 800);
  await test.session.pause(); const sent = test.actions.length;
  expect(await test.session.rebuild(restore)).toBeNull(); expect(restore).not.toHaveBeenCalled();
  expect(test.actions).toHaveLength(sent); expect(test.dependencies.seekMedia).toHaveBeenCalledOnce();
  test.time(5000); test.session.clock(800); await test.session.settled();
  expect(restore).toHaveBeenCalledOnce();
  expect(test.dependencies.seekMedia.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([500, 800]);
  expect(test.actions.at(-1)).toMatchObject({ kind: 'obs.mediaAction', action: 'start' });
  expect(test.session.error).toBeNull(); await test.session.stop();
});

it('长片段每 5 秒按当前位置检查一次漂移，校正时标红；起播、定位后 1 秒内不检查', async () => {
  const test = setup(videoFixture()), correct = vi.fn<(event: import('./managed-media-timeline').ManagedMediaEvent) => Promise<number | null>>(() => Promise.resolve(null));
  const drift = { ...test.dependencies, correctMediaDrift: correct };
  const session = new ObsProgramSession(videoFixture(), 'C:/shows/test.tblink', 'song', drift);
  await session.prepare(0);
  for (let time = 0; time <= 5000; time += 100) { test.time(time); session.clock(time); await session.settled(); }
  expect(correct.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([5000]);
  correct.mockResolvedValueOnce(450);
  for (let time = 5100; time <= 10000; time += 100) { test.time(time); session.clock(time); await session.settled(); }
  expect(correct.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([5000, 10000]);
  expect(test.faults).toEqual(['素材和音乐差了 450 ms，已按当前位置校正：视频']);
  await session.stop();
  const seeked = new ObsProgramSession(videoFixture(), 'C:/shows/test.tblink', 'song', drift); correct.mockClear();
  test.time(20000); await seeked.prepare(4500);
  for (let time = 4500; time <= 5600; time += 100) { test.time(20000 + time); seeked.clock(time); await seeked.settled(); }
  expect(correct.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([5500]); await seeked.stop();
});

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

it('素材启动前不写日志：日志写入再慢也不推迟媒体启动，结果日志在执行之后', async () => {
  const test = setup(videoFixture());
  const order: string[] = [];
  test.dependencies.executeManagedMediaEvent.mockImplementation(() => { order.push('execute'); return Promise.resolve(); });
  test.dependencies.recordLog.mockImplementation(entry => {
    if (entry.category === 'action') { order.push(`log ${String(entry.result)}`); test.time(101); }
    return Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: 101 });
  });
  await test.session.prepare(0); test.session.clock(0); await test.session.settled();
  expect(order).toEqual(['execute', 'log succeeded']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

it('暂停和继续只改变活动视频播放状态，不重建片段或从头重播', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0); await test.advance(0, 1000);
  await test.session.pause(); test.time(5000); test.session.clock(1000); await test.session.settled();
  expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledTimes(1);
  expect(test.actions.map(action => action.kind === 'obs.mediaAction' ? action.action : action.kind)).toEqual(['pause', 'start']);
  await Promise.all([test.session.stop(), test.session.stop()]);
  expect(test.dependencies.executeManagedMediaEvent.mock.calls.map(call => call[0].event.phase)).toEqual(['start', 'stop']);
});

it('恢复媒体晚到也照样继续播放并记日志，素材不会一直停着', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0); await test.advance(0, 1000);
  await test.session.pause();
  test.time(5060); test.session.clock(1000, 5000); test.time(5110); await test.session.settled();
  expect(test.actions.map(action => action.kind === 'obs.mediaAction' ? action.action : action.kind)).toEqual(['pause', 'start']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
  expect(lateLogs(test)).toEqual([expect.stringContaining('晚了 110 ms 才发出：素材继续播放')]);
});

it('动作按时开始发送后，后续子请求不被截止打断：切场景与播放要么都发送，要么都不发送', async () => {
  const project = videoFixture();
  const test = setup(project), sent: string[] = [];
  let guard: { canSend: () => boolean; dispatched?: () => void } | null = null;
  test.dependencies.guardOutput = <T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void) => {
    const previous = guard; guard = { canSend, ...(dispatched ? { dispatched } : {}) };
    return operation().finally(() => { guard = previous; });
  };
  const send = (label: string): void => {
    if (!guard?.canSend()) throw new Error(`尚未发送：${label}`);
    guard.dispatched?.(); sent.push(label);
  };
  test.dependencies.executeManagedMediaEvent.mockImplementation(payload => {
    if (payload.event.phase !== 'start') return Promise.resolve();
    send('切换素材场景'); test.time(150); send('播放');
    return Promise.resolve();
  });
  await test.session.prepare(0); test.session.clock(0); await test.session.settled();
  expect(sent).toEqual(['切换素材场景', '播放']);
  expect(test.faults).toEqual([]);
});

it('OBS 卡住期间积压的切换，放开后合并成此刻应有的画面一次发出，不逐个闪过中间机位；晚到标红', async () => {
  const project = fixture();
  project.rundown[0]!.cues.push({ id: 'cue-4', name: '机位 4', notes: '', enabled: true, timecode: { hours: 0, minutes: 0, seconds: 4, frames: 0 },
    actions: [{ id: 'action-4', kind: 'obs.setProgramScene', label: '切机位', sceneName: '场景 4' }] });
  let release = (): void => { throw new Error('测试未初始化'); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const test = setup(parseLinkProject(project), action => action.id === 'action-1' ? gate : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 900);
  // OBS has not answered the switch at 1 s; the music goes on to 3.6 s.
  for (let at = 1000; at <= 3600; at += 100) { test.time(at); test.session.clock(at); await Promise.resolve(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
  release(); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-3']);
  expect(test.faults).toEqual(['画面晚了 1600 ms：电脑或 OBS 当时太忙，积压的 2 批画面动作已合并，直接切到了现在该有的画面']);
  await test.advance(3700, 4000);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-3', 'action-4']);
  expect(test.session.error).toBeNull(); expect(test.session.pendingCount).toBe(0);
});

it('画面队列长时间积压也不丢弃、不结束画面通道：放开后只发最后的机位，之后照常', async () => {
  let release = (): void => { throw new Error('测试未初始化'); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const project = fixture();
  // One cue every 100 ms at 30 fps; each observation crosses exactly one.
  project.rundown[0]!.cues = Array.from({ length: 81 }, (_value, index) => ({ id: `cue-${index}`, name: `机位 ${index}`, notes: '', enabled: true,
    timecode: { hours: 0, minutes: 0, seconds: Math.floor(index / 10), frames: (index % 10) * 3 },
    actions: [{ id: `action-${index}`, kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: `场景 ${index}` }] }));
  const test = setup(parseLinkProject(project), action => action.id === 'action-0' ? gate : Promise.resolve());
  await test.session.prepare(0); test.session.clock(0);
  await vi.waitFor(() => expect(test.actions.map(action => action.id)).toEqual(['action-0']));
  for (let index = 1; index < 80; index++) { test.time(index * 100); test.session.clock(index * 100); }
  expect(test.faults).toEqual([]); expect(test.session.pendingCount).toBe(2);
  release(); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-79']);
  expect(test.faults).toEqual([expect.stringContaining('积压的 79 批画面动作已合并')]);
  test.time(8000); test.session.clock(8000); await test.session.settled();
  expect(test.session.error).toBeNull(); expect(test.actions.at(-1)?.id).toBe('action-80');
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const scenes = (test: ReturnType<typeof setup>): string[] => test.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : []);
const outputs = (test: ReturnType<typeof setup>): string[] => test.actions.map(action => action.kind === 'obs.mediaAction' ? action.action
  : action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind);
const results = (test: ReturnType<typeof setup>, actionId?: string): string[][] => test.reports.flatMap(report => report.results)
  .filter(result => actionId === undefined || result.actionId === actionId).map(result => [result.actionId, result.status]);

/** A 0.1 s close-up camera at 1 s on the top track, over a wide camera or a video. */
function closeUpFixture(base: 'camera' | 'video'): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('重连'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: base === 'video' ? [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 10000, width: 1920, height: 1080 }] : [],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-top', name: '特写' }, { id: 'layer-base', name: '全景' }],
      referenceMediaClips: base === 'video' ? [{ id: 'clip', assetId: 'video', layerId: 'layer-base', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 10000 }] : [],
      cues: [
        ...base === 'camera' ? [{ id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
          actions: [{ id: 'base', kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: '全景' }] }] : [],
        { id: 'cue-close', name: '特写', layerId: 'layer-top', durationMs: 100, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
          actions: [{ id: 'close', kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: '特写' }] }] }] });
}

it.each(['camera', 'video'] as const)('OBS 重连恢复画面期间又越过两个边界：恢复后按此刻的完整画面补发，特写结束照常切回（底层：%s）', async base => {
  const restoring = deferred(), sending = deferred();
  let gated = false;
  const test = setup(closeUpFixture(base), action => {
    if (action.kind !== 'obs.setProgramScene' || action.sceneName !== '特写' || gated) return Promise.resolve();
    gated = true; return sending.promise;
  });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(950); test.session.clock(950); await test.session.settled();
  const rebuilding = test.session.rebuild(() => restoring.promise);
  // The close-up starts while the owned scenes are prepared again, and ends while the rebuild sends it.
  test.time(1000); test.session.clock(1000); restoring.release();
  await vi.waitFor(() => expect(scenes(test).at(-1)).toBe('特写'));
  test.time(1050); test.session.clock(1050); test.time(1100); test.session.clock(1100);
  sending.release(); expect(await rebuilding).toEqual({ sent: 1, failure: null }); await test.session.settled();
  for (let at = 1200; at <= 2000; at += 100) { test.time(at); test.session.clock(at); await test.session.settled(); }
  if (base === 'camera') expect(scenes(test)).toEqual(['全景', '特写', '全景']);
  else expect(test.dependencies.executeManagedMediaEvent.mock.calls.map(call => [call[0].event.phase, call[0].event.sourceOffsetMs])).toEqual([['start', 0], ['start', 1100]]);
  expect(test.session.error).toBeNull();
});

function stickerFixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('贴纸'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-sticker', name: '贴纸' }, { id: 'layer-base', name: '全景' }], cues: [
      { id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'base', kind: 'obs.setProgramScene', label: '切机位', sceneName: '全景' }] },
      { id: 'show', name: '贴纸', layerId: 'layer-sticker', durationMs: 100, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
        actions: [{ id: 'sticker', kind: 'obs.setSceneItemEnabled', label: '显示贴纸', sceneName: '全景', sourceName: '贴纸', enabled: true }] }] }] });
}
const sticker = (test: ReturnType<typeof setup>): boolean[] => test.actions.flatMap(action => action.kind === 'obs.setSceneItemEnabled' && action.sourceName === '贴纸' ? [action.enabled] : []);

it('暂停时正在显示的来源照常发完，继续后到点照常隐藏，不会一直留在画面上', async () => {
  const showing = deferred();
  const test = setup(stickerFixture(), action => action.kind === 'obs.setSceneItemEnabled' && action.enabled ? showing.promise : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(sticker(test)).toEqual([true]));
  const pausing = test.session.pause(); showing.release(); await pausing;
  test.time(5000); test.session.clock(1100); await test.session.settled();
  for (let at = 1200; at <= 3000; at += 100) { test.time(5000 + at - 1100); test.session.clock(at); await test.session.settled(); }
  expect(sticker(test)).toEqual([true, false]);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

it('OBS 重连恢复时重新显示的来源：排队的显示和隐藏合并补发时照常隐藏', async () => {
  const restoring = deferred(), showing = deferred();
  let gated = false;
  const test = setup(stickerFixture(), action => {
    if (action.kind !== 'obs.setSceneItemEnabled' || !action.enabled || gated) return Promise.resolve();
    gated = true; return showing.promise;
  });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(950); test.session.clock(950); await test.session.settled();
  const rebuilding = test.session.rebuild(() => restoring.promise);
  test.time(1000); test.session.clock(1000); restoring.release();
  await vi.waitFor(() => expect(sticker(test)).toEqual([true]));
  test.time(1100); test.session.clock(1100);
  showing.release(); expect(await rebuilding).toEqual({ sent: 2, failure: null }); await test.session.settled();
  for (let at = 1200; at <= 3000; at += 100) { test.time(at); test.session.clock(at); await test.session.settled(); }
  expect(sticker(test).at(-1)).toBe(false); expect(scenes(test).at(-1)).toBe('全景');
  expect(test.session.error).toBeNull();
});

it.each([false, true])('暂停时正在发的点动作只发一次：继续时不重发，失败的也不自动重试（OBS 拒绝：%s）', async rejected => {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台画面'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-top', name: '特写' }, { id: 'layer-base', name: '全景' }], cues: [
      { id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'base', kind: 'obs.setProgramScene', label: '切机位', sceneName: '全景' }] },
      { id: 'cue-close', name: '特写', layerId: 'layer-top', durationMs: 100, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
        actions: [{ id: 'close', kind: 'obs.setProgramScene', label: '切机位', sceneName: '特写' },
          { id: 'filter', kind: 'obs.setSourceFilterEnabled', label: '滤镜', sourceName: '特写', filterName: '调色', enabled: true }] }] }] });
  const filtering = deferred();
  const test = setup(project, action => action.id !== 'filter' ? Promise.resolve()
    : filtering.promise.then(() => { if (rejected) throw new Error('OBS 拒绝'); }));
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(test.actions.map(action => action.id)).toEqual(['base', 'filter']));
  // The filter is in flight; the camera after it has not gone out.
  const pausing = test.session.pause(); filtering.release(); await pausing;
  test.time(5000); test.session.clock(1000); await test.session.settled();
  for (let at = 1100; at <= 2000; at += 100) { test.time(5000 + at - 1000); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['base', 'filter', 'close', 'base']);
  expect(results(test, 'filter')).toEqual([['filter', rejected ? 'failed' : 'succeeded']]);
  expect(test.session.error).toBeNull();
});

it('OBS 回应慢的画面动作不按 2 秒报超时：等它真正结束再发下一个，晚到的机位不会盖掉新机位', async () => {
  vi.useFakeTimers();
  try {
    const answering = deferred();
    const test = setup(fixture(), action => action.id === 'action-1' ? answering.promise : Promise.resolve());
    await test.session.prepare(0); await test.advance(0, 900);
    test.time(1000); test.session.clock(1000);
    await vi.advanceTimersByTimeAsync(3000);
    for (let at = 1100; at <= 2000; at += 100) { test.time(at); test.session.clock(at); await Promise.resolve(); }
    expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
    answering.release(); await test.session.settled();
    expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2']);
    expect(results(test)).toEqual([['action-0', 'succeeded'], ['action-1', 'succeeded'], ['action-2', 'succeeded']]);
    expect(test.session.error).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('从中间开播时一个机位失败只标红这一个：画面照常准备，后面的机位照常切', async () => {
  const test = setup(fixture(), action => action.id === 'action-1' ? Promise.reject(new Error('场景不存在')) : Promise.resolve());
  await test.session.prepare(1500);
  expect(results(test)).toEqual([['action-1', 'failed']]);
  test.time(20000); test.session.clock(1500); await test.session.settled();
  for (let at = 1600; at <= 3000; at += 100) { test.time(20000 + at - 1500); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-1', 'action-2', 'action-3']);
  expect(test.session.error).toBeNull();
});

it('从中间开播时素材没对准开始的位置：标红，画面照常准备和播放', async () => {
  const test = setup(videoFixture()); test.dependencies.seekMedia.mockRejectedValueOnce(new Error('定位没有确认'));
  await test.session.prepare(1500);
  expect(test.faults).toEqual(['素材没有对准开始的位置：视频：定位没有确认。音乐照常播放，这个素材的画面可能和音乐对不上']);
  test.time(20000); test.session.clock(1500); await test.session.settled();
  expect(test.session.error).toBeNull();
  await test.session.stop(); expect(test.dependencies.executeManagedMediaEvent.mock.calls.at(-1)?.[0].event.phase).toBe('stop');
});

it('OBS 重连恢复画面时按了暂停：继续时按继续的位置重建画面，素材先定位再统一播放', async () => {
  const restoring = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  const rebuilding = test.session.rebuild(() => restoring.promise);
  const pausing = test.session.pause(); restoring.release();
  expect(await rebuilding).toBeNull(); await pausing;
  test.time(5000); test.session.clock(1500); await test.session.settled();
  expect(order).toEqual(['pause', 'seek 1500', 'start']);
  expect(test.faults).toEqual(['画面已按继续播放的位置恢复（1 项）']);
  for (let at = 1600; at <= 2000; at += 100) { test.time(5000 + at - 1500); test.session.clock(at); await test.session.settled(); }
  expect(order).toHaveLength(3); expect(test.session.error).toBeNull();
});

it('OBS 重连恢复画面定位素材时按了暂停：继续时重新定位再播放，不从没对准的位置播', async () => {
  const seeking = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  let first = true;
  test.dependencies.seekMedia.mockImplementation(async event => {
    order.push(`seek ${event.sourceOffsetMs}`);
    if (first) { first = false; await seeking.promise; }
  });
  const rebuilding = test.session.rebuild(() => Promise.resolve());
  await vi.waitFor(() => expect(order).toEqual(['seek 1500']));
  const pausing = test.session.pause(); seeking.release();
  expect(await rebuilding).toBeNull(); await pausing;
  test.time(5000); test.session.clock(1500); await test.session.settled();
  expect(order).toEqual(['seek 1500', 'pause', 'seek 1500', 'start']);
  expect(test.session.error).toBeNull();
});

it('暂停前已经发出但失败的素材停止，继续时不再重发，也不让这段素材接着播', async () => {
  const project = videoFixture(), item = project.rundown[0]!;
  item.referenceMediaClips[0]!.durationMs = 1000;
  item.visualLayers.push({ id: 'camera-layer', name: '机位', visible: true, locked: false });
  item.cues.push({ id: 'camera', name: '机位', notes: '', enabled: true, layerId: 'camera-layer', durationMs: 5000,
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, actions: [{ id: 'camera-scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '机位' }] });
  const stopping = deferred();
  const test = setup(parseLinkProject(project));
  const phases = (): string[] => test.dependencies.executeManagedMediaEvent.mock.calls.map(call => call[0].event.phase);
  test.dependencies.executeManagedMediaEvent.mockImplementation(async payload => {
    if (payload.event.phase === 'stop') { await stopping.promise; throw new Error('OBS 拒绝'); }
  });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(phases()).toEqual(['start', 'stop']));
  const pausing = test.session.pause(); stopping.release(); await pausing;
  test.time(5000); test.session.clock(1000); await test.session.settled();
  for (let at = 1100; at <= 2000; at += 100) { test.time(5000 + at - 1000); test.session.clock(at); await test.session.settled(); }
  expect(phases()).toEqual(['start', 'stop']);
  expect(scenes(test)).toEqual(['机位']);
  expect(outputs(test).filter(output => output === 'pause' || output === 'start')).toEqual(['pause']);
  expect(test.session.error).toBeNull();
  // The song's stop still cleans it up; that it fails again is reported.
  await expect(test.session.stop()).rejects.toThrow('画面没有清理干净：OBS 拒绝'); expect(phases()).toEqual(['start', 'stop', 'stop']);
});

it('合并补发的晚到从第一步发出时算起，不把 OBS 回应的时间算进去', async () => {
  const project = fixture();
  project.rundown[0]!.cues = Array.from({ length: 21 }, (_value, index) => ({ id: `cue-${index}`, name: `机位 ${index}`, notes: '', enabled: true,
    timecode: { hours: 0, minutes: 0, seconds: Math.floor(index / 10), frames: (index % 10) * 3 },
    actions: [{ id: `action-${index}`, kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: `场景 ${index}` }] }));
  const answering = deferred();
  const test = setup(parseLinkProject(project), action => {
    if (action.id === 'action-10') return answering.promise;
    // OBS takes 900 ms to answer the merged switch.
    if (action.id === 'action-12') test.time(2150);
    return Promise.resolve();
  });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(test.actions.at(-1)?.id).toBe('action-10'));
  test.time(1100); test.session.clock(1100); test.time(1200); test.session.clock(1200);
  test.time(1250); answering.release(); await test.session.settled();
  expect(test.actions.map(action => action.id).slice(-2)).toEqual(['action-10', 'action-12']);
  expect(test.faults).toEqual([]);
  expect(lateLogs(test)).toEqual(['画面晚了 150 ms：电脑或 OBS 当时太忙，积压的 2 批画面动作已合并，直接切到了现在该有的画面']);
});

it('暂停前已经晚了的切换，继续后照样记晚到，暂停的时间不算', async () => {
  const holding = deferred();
  const test = setup(fixture(), action => action.id === 'action-0' ? holding.promise : Promise.resolve());
  await test.session.prepare(0); test.session.clock(0);
  for (let at = 100; at <= 1900; at += 100) { test.time(at); test.session.clock(at); await Promise.resolve(); }
  const pausing = test.session.pause(); holding.release(); await pausing;
  expect(test.actions.map(action => action.id)).toEqual(['action-0']);
  test.time(5000); test.session.clock(1900); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1']);
  expect(lateLogs(test)).toEqual(['画面动作晚了 900 ms 才发出：机位 1。电脑或 OBS 当时太忙，画面已经按时间线切过去了']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

it('继续时 OBS 回应慢，排在后面的切换照样记晚到并标红', async () => {
  const project = videoFixture(), item = project.rundown[0]!;
  item.visualLayers.unshift({ id: 'camera', name: '机位', visible: true, locked: false });
  item.cues.push({ id: 'camera', name: '覆盖', notes: '', enabled: true, layerId: 'camera', durationMs: 2000,
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, actions: [{ id: 'camera', label: '机位', kind: 'obs.setProgramScene', sceneName: '机位' }] });
  // OBS answers the resume of the video 1.5 s after the music resumed.
  const test = setup(project, action => { if (action.kind === 'obs.mediaAction' && action.action === 'start') test.time(10500); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000); await test.session.pause();
  test.time(9000); test.session.clock(1000, 9000); await test.session.settled();
  expect(outputs(test)).toEqual(['pause', 'start', '机位']);
  expect(test.faults).toEqual(['画面动作晚了 1500 ms 才发出：覆盖。电脑或 OBS 当时太忙，画面已经按时间线切过去了']);
  expect(test.session.error).toBeNull();
});

it('合并补发的每一步都按积压最早的到期时间算晚到：前一步 OBS 回应慢拖晚了后面的点 Cue，照样标红', async () => {
  const project = fixture(), item = project.rundown[0]!;
  item.cues = [
    { id: 'cue-a', name: '机位 A', notes: '', enabled: true, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'a', kind: 'obs.setProgramScene', label: '切机位', sceneName: 'A' }] },
    { id: 'cue-b', name: '机位 B', notes: '', enabled: true, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, actions: [{ id: 'b', kind: 'obs.setProgramScene', label: '切机位', sceneName: 'B' }] },
    { id: 'cue-p', name: '滤镜', notes: '', enabled: true, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 6 }, actions: [{ id: 'p', kind: 'obs.setSourceFilterEnabled', label: '滤镜', sourceName: 'B', filterName: '调色', enabled: true }] },
    { id: 'cue-c', name: '机位 C', notes: '', enabled: true, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 9 }, actions: [{ id: 'c', kind: 'obs.setProgramScene', label: '切机位', sceneName: 'C' }] }];
  const answering = deferred(), sentAt: Record<string, number> = {};
  let now = 0;
  const test = setup(parseLinkProject(project), action => {
    sentAt[action.id] = now;
    if (action.id === 'b') return answering.promise;
    // OBS takes 1.9 s to answer the merged camera, within the request limit.
    if (action.id === 'c') { now = 3300; test.time(now); }
    return Promise.resolve();
  });
  const at = (time: number): void => { now = time; test.time(time); test.session.clock(time); };
  await test.session.prepare(0);
  for (let time = 0; time <= 900; time += 100) { at(time); await test.session.settled(); }
  at(1000); await vi.waitFor(() => expect(test.actions.at(-1)?.id).toBe('b'));
  at(1100); at(1200); at(1300);
  now = 1400; test.time(1400); answering.release(); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['a', 'b', 'c', 'p']);
  expect(sentAt).toMatchObject({ c: 1400, p: 3300 });
  expect(test.faults).toEqual(['画面晚了 2100 ms：电脑或 OBS 当时太忙，积压的 2 批画面动作已合并，直接切到了现在该有的画面']);
  expect(test.session.error).toBeNull();
});

/** A video from 0 s under a camera that covers it at 1 s. */
function coveredVideoFixture(): LinkProject {
  const project = videoFixture(), item = project.rundown[0]!;
  item.visualLayers.unshift({ id: 'camera-layer', name: '机位', visible: true, locked: false });
  item.cues.push({ id: 'camera', name: '特写', notes: '', enabled: true, layerId: 'camera-layer', durationMs: 3000,
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, actions: [{ id: 'close', label: '机位', kind: 'obs.setProgramScene', sceneName: '特写' }] });
  return parseLinkProject(project);
}

it('暂停时正在发的一步照常发完，但视频立刻跟着音乐暂停，不等这一步发完', async () => {
  const switching = deferred();
  const test = setup(coveredVideoFixture(), action => action.id === 'close' ? switching.promise : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(outputs(test)).toEqual(['特写']));
  test.time(1050); const pausing = test.session.pause();
  await vi.waitFor(() => expect(outputs(test)).toEqual(['特写', 'pause']));
  test.time(4100); switching.release(); await pausing;
  expect(outputs(test)).toEqual(['特写', 'pause']);
  expect(lateLogs(test)).toEqual([]);
  test.time(9000); test.session.clock(1050, 9000); await test.session.settled();
  expect(outputs(test)).toEqual(['特写', 'pause', 'start']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

it('暂停时正在开播的视频：这一步发完后马上补一次暂停，暂停晚了照样记下；继续时一起播放', async () => {
  const project = videoFixture(); project.rundown[0]!.referenceMediaClips[0]!.startTimecode.seconds = 1;
  const starting = deferred();
  const test = setup(project);
  test.dependencies.executeManagedMediaEvent.mockImplementation(async payload => { if (payload.event.phase === 'start') await starting.promise; });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledOnce());
  test.time(1050); const pausing = test.session.pause();
  await Promise.resolve(); expect(outputs(test)).toEqual([]);
  test.time(2300); starting.release(); await pausing;
  expect(outputs(test)).toEqual(['pause']);
  expect(test.faults).toEqual(['素材暂停晚了 1250 ms：电脑或 OBS 当时太忙，音乐停了素材还多播了一会儿。继续播放后会按音乐的位置校正']);
  test.time(9000); test.session.clock(1050, 9000); await test.session.settled();
  expect(outputs(test)).toEqual(['pause', 'start']);
  expect(test.session.error).toBeNull();
});

it('暂停时开播的一步还没发完就继续了：不再补暂停，素材照常播放', async () => {
  const project = videoFixture(); project.rundown[0]!.referenceMediaClips[0]!.startTimecode.seconds = 1;
  const starting = deferred();
  const test = setup(project);
  test.dependencies.executeManagedMediaEvent.mockImplementation(async payload => { if (payload.event.phase === 'start') await starting.promise; });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000);
  await vi.waitFor(() => expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledOnce());
  test.time(1050); void test.session.pause();
  test.time(1200); test.session.clock(1050, 1200);
  starting.release(); await test.session.settled();
  expect(outputs(test)).toEqual(['start']);
  expect(test.session.error).toBeNull();
});

it('OBS 重连准备场景时按了暂停（准备因暂停中断）：继续时先重新准备场景，再按继续的位置重建，不标“恢复失败”', async () => {
  const restoring = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  let paused = false;
  // Like the host: the scenes are prepared again step by step, and a pause refuses the next step.
  const restore = vi.fn(async () => { order.push('restore'); await restoring.promise; if (paused) throw new Error('画面状态已变，没有恢复'); });
  const rebuilding = test.session.rebuild(restore);
  await vi.waitFor(() => expect(order).toEqual(['restore']));
  paused = true; const pausing = test.session.pause(); restoring.release();
  expect(await rebuilding).toBeNull(); await pausing;
  expect(order).toEqual(['restore', 'pause']);
  paused = false; test.time(5000); test.session.clock(1500); await test.session.settled();
  expect(order).toEqual(['restore', 'pause', 'restore', 'seek 1500', 'start']);
  expect(test.faults).toEqual(['画面已按继续播放的位置恢复（1 项）']);
  expect(test.session.error).toBeNull();
});

it('OBS 重连准备场景时暂停又继续：继续时不会先让没对准的素材开播，场景准备好后按当前位置定位再播放', async () => {
  const restoring = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  const rebuilding = test.session.rebuild(() => restoring.promise);
  void test.session.pause();
  test.time(5000); test.session.clock(1500);
  test.time(5100); test.session.clock(1600);
  expect(order).toEqual([]);
  restoring.release(); expect(await rebuilding).toEqual({ sent: 1, failure: null }); await test.session.settled();
  expect(order).toEqual(['seek 1600', 'start']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

/** A wide camera all song, a close-up from 1.2 s for 0.3 s, and a sticker shown from 1 s for 2 s. */
function stickerSpanFixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('贴纸'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-sticker', name: '贴纸' }, { id: 'layer-close', name: '特写' }, { id: 'layer-base', name: '全景' }], cues: [
      { id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'base', kind: 'obs.setProgramScene', label: '切机位', sceneName: '全景' }] },
      { id: 'cue-close', name: '特写', layerId: 'layer-close', durationMs: 300, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 6 },
        actions: [{ id: 'close', kind: 'obs.setProgramScene', label: '切机位', sceneName: '特写' }] },
      { id: 'show', name: '贴纸', layerId: 'layer-sticker', durationMs: 2000, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
        actions: [{ id: 'sticker', kind: 'obs.setSceneItemEnabled', label: '显示贴纸', sceneName: '全景', sourceName: '贴纸', enabled: true }] }] }] });
}

it('OBS 重连恢复时已经重新显示的来源，排队里的同一个显示不再发第二次，到点照常隐藏', async () => {
  const restoring = deferred(), showing = deferred();
  let gated = false;
  const test = setup(stickerSpanFixture(), action => {
    if (action.kind !== 'obs.setSceneItemEnabled' || !action.enabled || gated) return Promise.resolve();
    gated = true; return showing.promise;
  });
  await test.session.prepare(0); await test.advance(0, 900);
  test.time(950); test.session.clock(950); await test.session.settled();
  const rebuilding = test.session.rebuild(() => restoring.promise);
  // The show is crossed while the owned scenes are prepared again, the close-up while the rebuild shows it.
  test.time(1000); test.session.clock(1000); restoring.release();
  await vi.waitFor(() => expect(sticker(test)).toEqual([true]));
  test.time(1200); test.session.clock(1200); test.time(1300); test.session.clock(1300);
  showing.release(); expect(await rebuilding).toEqual({ sent: 2, failure: null }); await test.session.settled();
  for (let at = 1400; at <= 3200; at += 100) { test.time(at); test.session.clock(at); await test.session.settled(); }
  expect(sticker(test)).toEqual([true, false]);
  expect(scenes(test).at(-1)).toBe('全景'); expect(test.session.error).toBeNull();
});

it('从中间开始播落在显示来源的时长里：切机位后马上显示，到点照常隐藏', async () => {
  const test = setup(stickerSpanFixture());
  await test.session.prepare(2000);
  expect(outputs(test)).toEqual(['全景', 'obs.setSceneItemEnabled']); expect(sticker(test)).toEqual([true]);
  for (let at = 2000; at <= 3200; at += 100) { test.time(10000 + at); test.session.clock(at); await test.session.settled(); }
  expect(sticker(test)).toEqual([true, false]);
  await test.session.stop(); expect(sticker(test)).toEqual([true, false]);
  expect(test.session.error).toBeNull();
});

it('显示来源的时长内停止或拖动进度：旧的画面停止时把它隐藏，拖到时长外的新位置不再显示', async () => {
  const first = setup(stickerSpanFixture());
  await first.session.prepare(0); await first.advance(0, 2000);
  expect(sticker(first)).toEqual([true]);
  await first.session.stop();
  expect(sticker(first)).toEqual([true, false]); expect(first.dependencies.releaseOutputs).toHaveBeenCalledOnce();
  const second = setup(stickerSpanFixture());
  await second.session.prepare(5000);
  expect(sticker(second)).toEqual([]);
  // A show OBS refused is not hidden again at the stop.
  const refused = setup(stickerSpanFixture(), action => action.kind === 'obs.setSceneItemEnabled' ? Promise.reject(new Error('当前直播场景里没有“贴纸”来源')) : Promise.resolve());
  await refused.session.prepare(0); await refused.advance(0, 2000); await refused.session.stop();
  expect(sticker(refused)).toEqual([true]); expect(refused.session.error).toBeNull();
});

it('OBS 重连准备场景时暂停又继续，准备因那次暂停中断：照常重新准备一次再重建，不当成准备失败', async () => {
  const restoring = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  let interrupted = false;
  const restore = vi.fn(async () => { order.push('restore'); if (restore.mock.calls.length > 1) return; await restoring.promise; if (interrupted) throw new Error('画面状态已变，没有恢复'); });
  const rebuilding = test.session.rebuild(restore);
  await vi.waitFor(() => expect(order).toEqual(['restore']));
  interrupted = true; void test.session.pause();
  test.time(5000); test.session.clock(1500);
  restoring.release(); expect(await rebuilding).toEqual({ sent: 1, failure: null }); await test.session.settled();
  expect(order).toEqual(['restore', 'restore', 'seek 1500', 'start']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});
