import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject, type ObsPictureItem } from '@tb/schema';
import { MediaPreparationFailed, ObsProgramSession, obsRecoveryText, type ObsProgramSessionDependencies, type PictureReadRequest } from './obs-program-session';
import type { PictureReading } from './picture-follow';
import { compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import type { ManagedMediaOutcome } from './managed-output-runtime';
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
/** `online`: whether OBS is connected, for a test that takes OBS away (nothing is repaired then). */
function setup(project = fixture(), execute?: (action: LinkAction) => Promise<void>, online?: () => boolean) {
  let now = 0;
  const actions: LinkAction[] = [], reports: CueExecutionReport[] = [], states: RuntimeUpdate[] = [], faults: string[] = [];
  const dependencies = { now: () => now, fault: (message: string) => faults.push(message), recordLog: vi.fn<LinkDesktopApi['recordLog']>(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now })), executeManagedMediaEvent: vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(() => Promise.resolve()),
    guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
    prepareOutputs: vi.fn(() => Promise.resolve()), holdOutputs: vi.fn<import('./obs-program-session').ObsProgramSessionDependencies['holdOutputs']>(() => Promise.resolve()), releaseOutputs: vi.fn(() => Promise.resolve()),
    prepareUpcoming: vi.fn<NonNullable<import('./obs-program-session').ObsProgramSessionDependencies['prepareUpcoming']>>(() => Promise.resolve(null)),
    seekMedia: vi.fn<import('./obs-program-session').ObsProgramSessionDependencies['seekMedia']>(() => Promise.resolve()), mediaReport: vi.fn(), cueReport: (report: CueExecutionReport) => reports.push(report),
    state: (state: RuntimeUpdate) => states.push(state), ...(online ? { connected: online } : {}),
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
  const stopped = test.session.release();
  await Promise.resolve(); expect(test.dependencies.releaseOutputs).not.toHaveBeenCalled();
  release(); await stopped;
  expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
  expect(test.session.error).toBeNull();
  test.time(1000); test.session.clock(1000);
  expect(test.dependencies.prepareUpcoming).toHaveBeenCalledTimes(1);
});

// 2026-11-10 第 2 题：后台预备失败自动再准备一次，记进次数，到上限才停（以前是“不重试”）。
it('直播中后台预备失败标红并自动再准备一次，再失败就不再准备，后续画面动作照常执行（2026-11-10 第 2 题）', async () => {
  const test = setup(), clip = compileManagedMediaTimeline(videoFixture(), 'song').events[0]!, prepareAgain = vi.fn();
  const session = new ObsProgramSession(fixture(), 'C:/shows/test.tblink', 'song', { ...test.dependencies, prepareAgain });
  test.dependencies.prepareUpcoming.mockRejectedValueOnce(new MediaPreparationFailed(clip, '下一视频不能解码'))
    .mockRejectedValueOnce(new MediaPreparationFailed(clip, '下一视频还是不能解码'));
  await session.prepare(0);
  for (let time = 0; time <= 3000; time += 100) { test.time(time); session.clock(time); await session.settled(); }
  expect(session.error).toBeNull();
  expect(prepareAgain.mock.calls).toEqual([[clip.clipId]]);
  expect(test.faults).toEqual(['准备后面的素材没成功：视频。原因：下一视频不能解码。已自动再准备一次（这首歌第 1 次，最多 20 次），准备好了就不用处理',
    '准备后面的素材没成功：视频。原因：下一视频还是不能解码。已经自动再准备过一次，不再准备，到时候这个素材可能播不出来。请检查这个素材文件和 OBS 是否卡顿']);
  const logs = test.dependencies.recordLog.mock.calls.map(([entry]) => entry).filter(entry => entry.category === 'device');
  expect(logs.map(entry => [entry.level, entry.details])).toEqual([
    ['warning', { channel: 'obs', item: `preload:${clip.clipId}`, recoveries: [{ row: 'picture.element', key: `preload:${clip.clipId}@ready`, count: 1, max: 1 }, { row: 'picture.song', key: 'song', count: 1, max: 20 }] }],
    ['error', { channel: 'obs', item: `preload:${clip.clipId}`, recoveries: [{ row: 'picture.element', key: `preload:${clip.clipId}@ready`, count: 1, max: 1 }] }]]);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2', 'action-3']);
  await session.release(); expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
});

it('后台预备失败但说不出是哪个素材：照旧标红，不再准备', async () => {
  const test = setup(); test.dependencies.prepareUpcoming.mockRejectedValueOnce(new Error('下一视频不能解码'));
  await test.session.prepare(0); await test.advance(0, 3000);
  expect(test.session.error).toBeNull();
  expect(test.faults).toEqual(['准备后面的素材失败：下一视频不能解码；不会重试，到时候这个素材可能播不出来']);
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-2', 'action-3']);
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
  const stopping = test.session.release(); release(); await stopping;
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

// 2026-11-10 第 2 题：失败的机位按现在该有的画面补发一次（以前是“不自动重试”）；点 Cue（滤镜）发过就不再发。
it('直播中 OBS 动作失败标红并继续后续动作：失败的机位补发一次，点 Cue 不重发（2026-11-10 第 2 题）', async () => {
  const project = fixture(); project.rundown[0]!.cues[0]!.actions.push({ id: 'next', label: '滤镜', kind: 'obs.setSourceFilterEnabled', sourceName: '机位', filterName: '调整', enabled: true });
  const test = setup(project, action => action.id === 'action-0' ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve());
  await test.session.prepare(0); test.session.clock(0); await test.session.settled();
  expect(test.actions.map(action => action.id).sort()).toEqual(['action-0', 'next']);
  expect(test.reports.flatMap(report => report.results).map(result => [result.actionId, result.status]).sort()).toEqual([['action-0', 'failed'], ['next', 'succeeded']]);
  expect(test.session.error).toBeNull();
  await test.advance(100, 2000);
  expect(test.actions.map(action => action.id).slice(2)).toEqual(['action-0', 'action-1', 'action-2']);
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
  const stopping = test.session.release(); release(); await preparing; await stopping;
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
  expect(await test.session.recover(() => { order.push('restore'); return Promise.resolve(); })).toEqual({ sent: 1, succeeded: 1, failed: [], failure: null });
  expect(order).toEqual(['restore', 'seek 500']);
  expect(test.actions.at(-1)).toMatchObject({ kind: 'obs.mediaAction', action: 'start' });
  await test.advance(1600, 2000); expect(calls).toHaveLength(1); expect(test.session.error).toBeNull();
  await test.session.release(); expect(calls.at(-1)?.[0].event.phase).toBe('stop');
});

// R7（设计 01 §4.7，第 2 题“按当前位置恢复”）：暂停中重连不再等继续，马上按暂停的位置恢复，素材定位后保持暂停。
it('重建失败交给调用方报告，画面照常按当前位置重建；尚未开始时不重建；暂停时马上重新准备场景、素材定位到暂停的位置并保持暂停，继续时只播放', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0);
  const restore = vi.fn(() => Promise.resolve());
  expect(await test.session.recover(restore)).toEqual({ sent: 0, succeeded: 0, failed: [], failure: null }); expect(restore).not.toHaveBeenCalled();
  await test.advance(0, 500);
  expect(await test.session.recover(() => Promise.reject(new Error('素材文件不可读')))).toEqual({ sent: 1, succeeded: 1, failed: [], failure: '素材文件不可读' });
  expect(test.dependencies.seekMedia.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([500]);
  expect(test.session.error).toBeNull(); await test.advance(600, 800);
  await test.session.pause(); const sent = test.actions.length;
  expect(await test.session.recover(restore)).toEqual({ sent: 1, succeeded: 1, failed: [], failure: null }); expect(restore).toHaveBeenCalledOnce();
  expect(test.dependencies.seekMedia.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([500, 800]);
  expect(test.actions.slice(sent).filter(action => action.kind === 'obs.mediaAction')).toEqual([]);
  test.time(5000); test.session.clock(800); await test.session.settled();
  expect(restore).toHaveBeenCalledOnce();
  expect(test.dependencies.seekMedia).toHaveBeenCalledTimes(2);
  expect(test.actions.at(-1)).toMatchObject({ kind: 'obs.mediaAction', action: 'start' });
  expect(test.session.error).toBeNull(); await test.session.release();
});

/** A read-back (R8) that finds the program on `scene` and every material it is asked for playing, `drift(now)` ms off the
 * music. `asked`: each reading's materials, with where the music has them when OBS answers. */
function reader(now: () => number, drift: (at: number) => number = () => 0, scene = '画面') {
  const asked: { at: number; decoders: string[] }[] = [];
  const readPicture = vi.fn((request: PictureReadRequest): Promise<PictureReading> => {
    asked.push({ at: now(), decoders: request.decoders.map(decoder => `${decoder.sourceName} ${Math.round(decoder.positionAt(now()))}`) });
    return Promise.resolve({ kind: 'read', programScene: scene, transitioning: false, music: { kind: 'not-used' },
      decoders: request.decoders.map(decoder => ({ sourceName: decoder.sourceName, state: 'playing', driftMs: drift(now()) })) });
  });
  return { readPicture, asked, withMaterials: () => asked.filter(entry => entry.decoders.length) };
}
/** The material input a clip plays on. */
function source(project: LinkProject, clipId: string): string {
  return compileManagedMediaTimeline(project, 'song').events.find(event => event.clipId === clipId)!.sourceName;
}
/** A clock step, then the picture session's queue twice: a drift correction the read-back queued runs in this step. */
async function step(session: ObsProgramSession, test: { time: (value: number) => void }, time: number, position = time): Promise<void> {
  test.time(time); session.clock(position); await session.settled(); await session.settled();
}

// R8 (design 01 §4.8): the drift check is part of the read-back, once a second, instead of a loop of its own every 5 s.
it('长片段的漂移跟着画面读回查：每秒读一次，差 300 ms 以上才校正并标红；起播、定位后 1 秒内不读素材（R8）', async () => {
  const project = videoFixture(), test = setup(project), correct = vi.fn<(event: import('./managed-media-timeline').ManagedMediaEvent) => Promise<number | null>>(() => Promise.resolve(450));
  const read = reader(test.dependencies.now, at => at === 5000 ? 450 : 0);
  const drift = { ...test.dependencies, correctMediaDrift: correct, readPicture: read.readPicture };
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', drift);
  await session.prepare(0);
  for (let time = 0; time <= 10000; time += 100) await step(session, test, time);
  expect(read.asked.map(entry => entry.at)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  // The clip ends at 10 s: that reading compares no material.
  expect(read.withMaterials().map(entry => entry.at)).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
  expect(read.withMaterials()[4]!.decoders).toEqual([`${source(project, 'clip')} 5000`]);
  expect(correct.mock.calls.map(call => call[0].sourceOffsetMs)).toEqual([5000]);
  expect(test.faults).toEqual(['素材和音乐差了 450 ms，已按当前位置校正：视频']);
  await session.release();
  const seeked = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', drift); read.asked.length = 0;
  test.time(20000); await seeked.prepare(4500);
  for (let time = 4500; time <= 5600; time += 100) await step(seeked, test, 20000 + time, time);
  expect(read.withMaterials().map(entry => entry.decoders)).toEqual([[`${source(project, 'clip')} 5500`]]); await seeked.release();
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
  await test.session.release();
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
  await test.session.release(); expect(test.dependencies.executeManagedMediaEvent.mock.calls.at(-1)?.[0].event.phase).toBe('stop');
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
  const stopping = test.session.release(); release(); await stopping;
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
  let stopped = false; const stopping = test.session.release().then(() => { stopped = true; });
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
  await Promise.all([test.session.release(), test.session.release()]);
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
  const rebuilding = test.session.recover(() => restoring.promise);
  // The close-up starts while the owned scenes are prepared again, and ends while the rebuild sends it.
  test.time(1000); test.session.clock(1000); restoring.release();
  await vi.waitFor(() => expect(scenes(test).at(-1)).toBe('特写'));
  test.time(1050); test.session.clock(1050); test.time(1100); test.session.clock(1100);
  sending.release(); expect(await rebuilding).toEqual({ sent: 1, succeeded: 1, failed: [], failure: null }); await test.session.settled();
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
  const rebuilding = test.session.recover(() => restoring.promise);
  test.time(1000); test.session.clock(1000); restoring.release();
  await vi.waitFor(() => expect(sticker(test)).toEqual([true]));
  test.time(1100); test.session.clock(1100);
  showing.release(); expect(await rebuilding).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null }); await test.session.settled();
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

// 2026-11-10 第 2 题：失败的机位在开播后补发一次。
it('从中间开播时一个机位失败只标红这一个：画面照常准备，这个机位补发一次，后面的机位照常切（2026-11-10 第 2 题）', async () => {
  const test = setup(fixture(), action => action.id === 'action-1' ? Promise.reject(new Error('场景不存在')) : Promise.resolve());
  await test.session.prepare(1500);
  expect(results(test)).toEqual([['action-1', 'failed']]);
  test.time(20000); test.session.clock(1500); await test.session.settled();
  for (let at = 1600; at <= 3000; at += 100) { test.time(20000 + at - 1500); test.session.clock(at); await test.session.settled(); }
  expect(test.actions.map(action => action.id)).toEqual(['action-1', 'action-1', 'action-2', 'action-3']);
  expect(test.session.error).toBeNull();
});

it('从中间开播时素材没对准开始的位置：标红，画面照常准备和播放', async () => {
  const test = setup(videoFixture()); test.dependencies.seekMedia.mockRejectedValueOnce(new Error('定位没有确认'));
  await test.session.prepare(1500);
  expect(test.faults).toEqual(['素材没有对准开始的位置：视频：定位没有确认。音乐照常播放，这个素材的画面可能和音乐对不上']);
  test.time(20000); test.session.clock(1500); await test.session.settled();
  expect(test.session.error).toBeNull();
  await test.session.release(); expect(test.dependencies.executeManagedMediaEvent.mock.calls.at(-1)?.[0].event.phase).toBe('stop');
});

it('OBS 重连恢复画面时按了暂停：继续时按继续的位置重建画面，素材先定位再统一播放', async () => {
  const restoring = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  const rebuilding = test.session.recover(() => restoring.promise);
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
  const rebuilding = test.session.recover(() => Promise.resolve());
  await vi.waitFor(() => expect(order).toEqual(['seek 1500']));
  const pausing = test.session.pause(); seeking.release();
  expect(await rebuilding).toBeNull(); await pausing;
  test.time(5000); test.session.clock(1500); await test.session.settled();
  expect(order).toEqual(['seek 1500', 'pause', 'seek 1500', 'start']);
  expect(test.session.error).toBeNull();
});

// 2026-11-10 第 2 题：停止失败的素材按现在该有的画面补发一次停止（以前是“继续时不再重发”）。
it('暂停前已经发出但失败的素材停止，继续时补发一次停止，也不让这段素材接着播（2026-11-10 第 2 题）', async () => {
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
  expect(phases()).toEqual(['start', 'stop', 'stop']);
  expect(scenes(test)).toEqual(['机位']);
  expect(outputs(test).filter(output => output === 'pause' || output === 'start')).toEqual(['pause']);
  expect(test.session.error).toBeNull();
  // The song's stop still cleans it up; that it fails again is reported.
  await expect(test.session.release()).rejects.toThrow('画面没有清理干净：OBS 拒绝'); expect(phases()).toEqual(['start', 'stop', 'stop', 'stop']);
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
  // OBS answered the start: the clip plays, so the resume sends no second play.
  expect(outputs(test)).toEqual([]);
  expect(test.dependencies.executeManagedMediaEvent).toHaveBeenCalledOnce();
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
  const rebuilding = test.session.recover(restore);
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
  const rebuilding = test.session.recover(() => restoring.promise);
  void test.session.pause();
  test.time(5000); test.session.clock(1500);
  test.time(5100); test.session.clock(1600);
  expect(order).toEqual([]);
  restoring.release(); expect(await rebuilding).toEqual({ sent: 1, succeeded: 1, failed: [], failure: null }); await test.session.settled();
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
  const rebuilding = test.session.recover(() => restoring.promise);
  // The show is crossed while the owned scenes are prepared again, the close-up while the rebuild shows it.
  test.time(1000); test.session.clock(1000); restoring.release();
  await vi.waitFor(() => expect(sticker(test)).toEqual([true]));
  test.time(1200); test.session.clock(1200); test.time(1300); test.session.clock(1300);
  showing.release(); expect(await rebuilding).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null }); await test.session.settled();
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
  await test.session.release(); expect(sticker(test)).toEqual([true, false]);
  expect(test.session.error).toBeNull();
});

it('显示来源的时长内停止或拖动进度：旧的画面停止时把它隐藏，拖到时长外的新位置不再显示', async () => {
  const first = setup(stickerSpanFixture());
  await first.session.prepare(0); await first.advance(0, 2000);
  expect(sticker(first)).toEqual([true]);
  await first.session.release();
  expect(sticker(first)).toEqual([true, false]); expect(first.dependencies.releaseOutputs).toHaveBeenCalledOnce();
  const second = setup(stickerSpanFixture());
  await second.session.prepare(5000);
  expect(sticker(second)).toEqual([]);
  // A show OBS refused is shown once more (2026-11-10 第 2 题), and not hidden at the stop.
  const refused = setup(stickerSpanFixture(), action => action.kind === 'obs.setSceneItemEnabled' ? Promise.reject(new Error('当前直播场景里没有“贴纸”来源')) : Promise.resolve());
  await refused.session.prepare(0); await refused.advance(0, 2000); await refused.session.release();
  expect(sticker(refused)).toEqual([true, true]); expect(refused.session.error).toBeNull();
});

it('OBS 断线期间到点的隐藏没发出去：重新连上恢复画面时一起补发，来源不会一直留在画面上（2026-11-09）', async () => {
  let connected = true;
  const test = setup(stickerSpanFixture(), () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), () => connected);
  await test.session.prepare(0); await test.advance(0, 2000);
  expect(sticker(test)).toEqual([true]);
  // The hide at 3 s goes out while OBS is gone and fails.
  connected = false; await test.advance(2100, 3500);
  expect(sticker(test)).toEqual([true, false]);
  connected = true;
  expect(await test.session.recover(() => Promise.resolve())).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null });
  expect(sticker(test)).toEqual([true, false, false]); expect(scenes(test).at(-1)).toBe('全景');
  // Hidden for good: the stop has nothing left to hide.
  await test.advance(3600, 4000); await test.session.release();
  expect(sticker(test)).toEqual([true, false, false]); expect(test.session.error).toBeNull();
});

it('OBS 重连准备场景时到了隐藏的时间：隐藏随恢复的画面发出一次，排队里的同一个隐藏不再发第二次', async () => {
  const restoring = deferred();
  const test = setup(stickerSpanFixture());
  await test.session.prepare(0); await test.advance(0, 2000);
  expect(sticker(test)).toEqual([true]);
  const rebuilding = test.session.recover(() => restoring.promise);
  // The hide at 3 s is crossed while the owned scenes are prepared again.
  for (let at = 2100; at <= 3200; at += 100) { test.time(at); test.session.clock(at); }
  restoring.release(); expect(await rebuilding).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null }); await test.session.settled();
  await test.advance(3300, 3600);
  expect(sticker(test)).toEqual([true, false]); expect(scenes(test).at(-1)).toBe('全景');
  expect(test.session.error).toBeNull();
});

it('OBS 断线又重连时显示来源还在时长里：恢复画面只把它再显示一次，不补发隐藏（画面上不闪一下），到点照常隐藏一次', async () => {
  let connected = true;
  const test = setup(stickerSpanFixture(), () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), () => connected);
  await test.session.prepare(0); await test.advance(0, 1500);
  connected = false; await test.advance(1600, 2000);
  connected = true;
  expect(await test.session.recover(() => Promise.resolve())).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null });
  expect(sticker(test)).toEqual([true, true]);
  await test.advance(2100, 3500);
  expect(sticker(test)).toEqual([true, true, false]); expect(test.session.error).toBeNull();
});

/** A wide camera all song, and the same sticker shown twice back to back: 1–3 s, then 3–6 s. */
function backToBackStickerFixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('贴纸'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-sticker', name: '贴纸' }, { id: 'layer-base', name: '全景' }], cues: [
      { id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'base', kind: 'obs.setProgramScene', label: '切机位', sceneName: '全景' }] },
      ...[[1, 2000], [3, 3000]].map(([seconds, durationMs]) => ({ id: `show-${seconds}`, name: '贴纸', layerId: 'layer-sticker', durationMs,
        timecode: { hours: 0, minutes: 0, seconds: seconds!, frames: 0 },
        actions: [{ id: `sticker-${seconds}`, kind: 'obs.setSceneItemEnabled' as const, label: '显示贴纸', sceneName: '全景', sourceName: '贴纸', enabled: true }] }))] }] });
}

it('同一个来源前后两段紧挨着、OBS 断线跨过交界：恢复画面先补发前一段的隐藏，再显示后一段，后一段一直显示到 6 秒', async () => {
  let connected = true;
  const test = setup(backToBackStickerFixture(), () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), () => connected);
  await test.session.prepare(0); await test.advance(0, 2000);
  // The first span's hide and the second span's show at 3 s both fail while OBS is gone.
  connected = false; await test.advance(2100, 4000);
  connected = true;
  expect(await test.session.recover(() => Promise.resolve())).toEqual({ sent: 3, succeeded: 3, failed: [], failure: null });
  expect(sticker(test)).toEqual([true, false, true, false, true]);
  await test.advance(4100, 5900);
  expect(sticker(test).at(-1)).toBe(true);
  await test.advance(6000, 7000);
  expect(sticker(test)).toEqual([true, false, true, false, true, false]); expect(test.session.error).toBeNull();
});

/** A video all song, a sticker shown over it from 1 s for 2 s, and a filter turned on at 3 s. */
function stickerOverVideoFixture(): LinkProject {
  const project = videoFixture(), item = project.rundown[0]!;
  item.visualLayers.unshift({ id: 'layer-sticker', name: '贴纸', visible: true, locked: false });
  item.cues.push({ id: 'show', name: '贴纸', notes: '', enabled: true, layerId: 'layer-sticker', durationMs: 2000, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    actions: [{ id: 'sticker', kind: 'obs.setSceneItemEnabled', label: '显示贴纸', sceneName: '全景', sourceName: '贴纸', enabled: true }] },
  { id: 'cue-filter', name: '滤镜', notes: '', enabled: true, timecode: { hours: 0, minutes: 0, seconds: 3, frames: 0 },
    actions: [{ id: 'filter', kind: 'obs.setSourceFilterEnabled', label: '滤镜', sourceName: '视频', filterName: '调色', enabled: true }] });
  return parseLinkProject(project);
}

it('OBS 重新连上时前一刻越过的画面动作还在排队：画面只按这次重连恢复一次（素材只对准一次），不另报“继续播放”的恢复；排队的滤镜随后发出，隐藏不再发第二次', async () => {
  let connected = true;
  const test = setup(stickerOverVideoFixture(), () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), () => connected);
  const restore = vi.fn(() => Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 2000);
  connected = false; await test.advance(2100, 2900);
  // The hide and the filter at 3 s are crossed and their send queued; the reconnect comes before that send ran.
  test.time(3000); test.session.clock(3000);
  connected = true;
  expect(await test.session.recover(restore)).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null });
  await test.session.settled();
  expect(restore).toHaveBeenCalledOnce(); expect(test.dependencies.seekMedia).toHaveBeenCalledOnce();
  expect(test.faults).toEqual([]);
  // Sent after the rebuild without waiting for another position update.
  expect(test.actions.filter(action => action.kind === 'obs.setSourceFilterEnabled')).toHaveLength(1);
  await test.advance(3100, 3500);
  expect(sticker(test)).toEqual([true, false]); expect(test.session.error).toBeNull();
});

/** 全景 all song, 特写 2–3 s over it, and a sticker 1–3 s. */
function closeUpEndsWithStickerFixture(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('贴纸'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-sticker', name: '贴纸' }, { id: 'layer-close', name: '特写' }, { id: 'layer-base', name: '全景' }], cues: [
      { id: 'cue-base', name: '全景', layerId: 'layer-base', durationMs: 10000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'base', kind: 'obs.setProgramScene', label: '切全景', sceneName: '全景' }] },
      { id: 'cue-close', name: '特写', layerId: 'layer-close', durationMs: 1000, timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 },
        actions: [{ id: 'close', kind: 'obs.setProgramScene', label: '切特写', sceneName: '特写' }] },
      { id: 'show', name: '贴纸', layerId: 'layer-sticker', durationMs: 2000, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
        actions: [{ id: 'sticker', kind: 'obs.setSceneItemEnabled', label: '显示贴纸', sceneName: '全景', sourceName: '贴纸', enabled: true }] }] }] });
}

it('OBS 重新连上时，3 秒切回全景和贴纸到点的隐藏还在排队：画面只按这次重连恢复一次，全景只再切一次、隐藏只发一次，不另报“继续播放”的恢复（2026-11-09）', async () => {
  let connected = true;
  const test = setup(closeUpEndsWithStickerFixture(), () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), () => connected);
  await test.session.prepare(0); await test.advance(0, 2000);
  expect(scenes(test)).toEqual(['全景', '特写']); expect(sticker(test)).toEqual([true]);
  connected = false; await test.advance(2100, 2900);
  // At 3 s 特写 ends and the sticker's span too; that send is queued, and the reconnect comes before it ran.
  test.time(3000); test.session.clock(3000);
  connected = true;
  expect(await test.session.recover(() => Promise.resolve())).toEqual({ sent: 2, succeeded: 2, failed: [], failure: null });
  await test.session.settled();
  expect(scenes(test)).toEqual(['全景', '特写', '全景']); expect(sticker(test)).toEqual([true, false]);
  expect(test.faults).toEqual([]);
  await test.advance(3100, 4000);
  expect(scenes(test)).toEqual(['全景', '特写', '全景']); expect(sticker(test)).toEqual([true, false]); expect(test.session.error).toBeNull();
});

it('OBS 重连恢复的画面里有几项没完成：结果写明恢复了几项、哪几项没完成和原因，交给报告重连的一方说一次，自己不另外标红', async () => {
  let connected = true;
  const test = setup(stickerOverVideoFixture(), action => {
    if (!connected) return Promise.reject(new Error('OBS 连接已断开'));
    if (action.kind === 'obs.setSceneItemEnabled' && !action.enabled) return Promise.reject(new Error('当前直播场景“特写”里没有“贴纸”来源。'));
    return action.kind === 'obs.mediaAction' ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve();
  }, () => connected);
  await test.session.prepare(0); await test.advance(0, 2000);
  connected = false; await test.advance(2100, 3500);
  connected = true; test.faults.length = 0;
  test.dependencies.seekMedia.mockRejectedValueOnce(new Error('定位没有确认'));
  const rebuilt = await test.session.recover(() => Promise.resolve());
  // The owed hide, the clip's seek and its play did not come back; nothing did.
  expect(rebuilt).toEqual({ sent: 2, succeeded: 0, failure: null, failed: [
    { label: '隐藏来源 · 贴纸', reason: '当前直播场景“特写”里没有“贴纸”来源。' }, { label: '素材“视频”对准音乐的位置', reason: '定位没有确认' },
    { label: '素材“视频”继续播放', reason: 'OBS 无响应' }] });
  expect(test.faults).toEqual([]);
  expect(obsRecoveryText(rebuilt!, true)).toBe('OBS 已重新连接，画面没有按当前位置恢复，3 项没有完成：隐藏来源 · 贴纸（原因：当前直播场景“特写”里没有“贴纸”来源）；'
    + '素材“视频”对准音乐的位置（原因：定位没有确认）；素材“视频”继续播放（原因：OBS 无响应）。请在 OBS 里检查这几项，需要的话手动调好');
  // A part whose request could not even be queued is counted as not back, not shown on its own.
  let refuse = true;
  test.dependencies.guardOutput = <T>(_canSend: () => boolean, operation: () => Promise<T>): Promise<T> => {
    if (!refuse) return operation();
    refuse = false; return Promise.reject(new Error('OBS 请求太多，这一批没有发送'));
  };
  expect(await test.session.recover(() => Promise.resolve())).toEqual({ sent: 2, succeeded: 1, failure: null, failed: [
    { label: '结束 · 贴纸', reason: 'OBS 请求太多，这一批没有发送' }, { label: '素材“视频”继续播放', reason: 'OBS 无响应' }] });
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

it('重连恢复画面后说给操作员听的话：全都恢复时照旧报几项；有没完成的就说恢复了几项、哪项没完成、原因和怎么办，不说成全恢复了', () => {
  const miss = { label: '隐藏来源 · 贴纸', reason: '当前直播场景“特写”里没有“贴纸”来源。' };
  expect(obsRecoveryText({ sent: 2, succeeded: 2, failed: [], failure: null }, true)).toBe('OBS 已重新连接，画面已按当前位置恢复（2 项）');
  expect(obsRecoveryText({ sent: 2, succeeded: 2, failed: [], failure: null }, false)).toBe('画面已按继续播放的位置恢复（2 项）');
  expect(obsRecoveryText({ sent: 1, succeeded: 1, failed: [], failure: '素材文件不可读' }, true))
    .toBe('OBS 已重新连接，但素材场景没有重新准备好：素材文件不可读。机位已按当前位置恢复（1 项），素材可能播不出来');
  expect(obsRecoveryText({ sent: 1, succeeded: 1, failed: [], failure: '素材文件不可读' }, false))
    .toBe('OBS 重新连接后素材场景没有重新准备好：素材文件不可读。机位已按继续播放的位置恢复（1 项），素材可能播不出来');
  expect(obsRecoveryText({ sent: 2, succeeded: 1, failed: [miss], failure: null }, true))
    .toBe('OBS 已重新连接，画面按当前位置恢复了 1 项，隐藏来源 · 贴纸没有完成。原因：当前直播场景“特写”里没有“贴纸”来源。请在 OBS 里检查这一项，需要的话手动调好');
  expect(obsRecoveryText({ sent: 2, succeeded: 1, failed: [miss], failure: null }, false))
    .toBe('画面按继续播放的位置恢复了 1 项，隐藏来源 · 贴纸没有完成。原因：当前直播场景“特写”里没有“贴纸”来源。请在 OBS 里检查这一项，需要的话手动调好');
  expect(obsRecoveryText({ sent: 2, succeeded: 1, failed: [miss], failure: '素材文件不可读' }, true))
    .toBe('OBS 已重新连接，但素材场景没有重新准备好：素材文件不可读。机位按当前位置恢复了 1 项，隐藏来源 · 贴纸没有完成。原因：当前直播场景“特写”里没有“贴纸”来源。'
      + '素材可能播不出来，请在 OBS 里检查这一项，需要的话手动调好');
});

// R7（设计 01 §4.7）：暂停中重连马上按暂停的位置恢复，不再等继续播放。
it('OBS 暂停时重连马上按暂停的位置恢复画面：有一项没完成时写明哪项没完成，不说成全恢复了；继续播放时按第 2 题补发一次', async () => {
  let connected = true;
  const test = setup(stickerSpanFixture(), action => {
    if (!connected) return Promise.reject(new Error('OBS 连接已断开'));
    return action.kind === 'obs.setSceneItemEnabled' && !action.enabled ? Promise.reject(new Error('OBS 无响应')) : Promise.resolve();
  }, () => connected);
  await test.session.prepare(0); await test.advance(0, 2000);
  connected = false; await test.advance(2100, 3500);
  await test.session.pause();
  connected = true;
  const rebuilt = await test.session.recover(() => Promise.resolve());
  expect(rebuilt).toEqual({ sent: 2, succeeded: 1, failure: null, failed: [{ label: '隐藏来源 · 贴纸', reason: 'OBS 无响应' }] });
  expect(obsRecoveryText(rebuilt!, true)).toBe('OBS 已重新连接，画面按当前位置恢复了 1 项，隐藏来源 · 贴纸没有完成。原因：OBS 无响应。请在 OBS 里检查这一项，需要的话手动调好');
  test.faults.length = 0; test.time(9000); test.session.clock(3500); await test.session.settled();
  // The hide that did not come back is sent once more right after the resume (2026-11-10 第 2 题).
  expect(test.faults).toEqual(['隐藏来源 · 贴纸没有成功（OBS 无响应），已按现在该有的画面自动补发一次（这首歌第 1 次，最多 20 次）。补上了就不用处理']);
});

it('OBS 重连准备场景时暂停又继续，准备因那次暂停中断：照常重新准备一次再重建，不当成准备失败', async () => {
  const restoring = deferred(), order: string[] = [];
  const test = setup(videoFixture(), action => { if (action.kind === 'obs.mediaAction') order.push(action.action); return Promise.resolve(); });
  await test.session.prepare(0); await test.advance(0, 1500);
  test.dependencies.seekMedia.mockImplementation(event => { order.push(`seek ${event.sourceOffsetMs}`); return Promise.resolve(); });
  let interrupted = false;
  const restore = vi.fn(async () => { order.push('restore'); if (restore.mock.calls.length > 1) return; await restoring.promise; if (interrupted) throw new Error('画面状态已变，没有恢复'); });
  const rebuilding = test.session.recover(restore);
  await vi.waitFor(() => expect(order).toEqual(['restore']));
  interrupted = true; void test.session.pause();
  test.time(5000); test.session.clock(1500);
  restoring.release(); expect(await rebuilding).toEqual({ sent: 1, succeeded: 1, failed: [], failure: null }); await test.session.settled();
  expect(order).toEqual(['restore', 'restore', 'seek 1500', 'start']);
  expect(test.faults).toEqual([]); expect(test.session.error).toBeNull();
});

const mediaCalls = (test: ReturnType<typeof setup>): string[] => test.dependencies.executeManagedMediaEvent.mock.calls
  .map(call => `${call[0].event.phase} ${call[0].event.clipId}`);

it('OBS 回应慢时只发最新的画面：积压期间开始又结束的素材不再开播，只切到此刻的机位', async () => {
  const project = videoFixture(), item = project.rundown[0]!;
  // The video on top from 1.5 s to 2.5 s, over the fixture's cameras, which switch every second.
  Object.assign(item.referenceMediaClips[0]!, { startTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 15 }, durationMs: 1000 });
  item.visualLayers.push({ id: 'cameras', name: '机位', visible: true, locked: false });
  item.cues.push(...fixture().rundown[0]!.cues.map(cue => ({ ...cue, layerId: 'cameras' })));
  const answering = deferred();
  const test = setup(parseLinkProject(project), action => action.id === 'action-1' ? answering.promise : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 900);
  for (let at = 1000; at <= 3200; at += 100) { test.time(at); test.session.clock(at); await Promise.resolve(); }
  answering.release(); await test.session.settled();
  expect(test.actions.map(action => action.id)).toEqual(['action-0', 'action-1', 'action-3']);
  expect(mediaCalls(test)).toEqual([]);
  expect(test.session.error).toBeNull();
});

it('暂停立刻生效：视频马上跟着音乐暂停，没发的切换等继续时按当时的位置补上', async () => {
  const test = setup(coveredVideoFixture()); await test.session.prepare(0); await test.advance(0, 900);
  test.time(1000); test.session.clock(1000); const pausing = test.session.pause();
  // The switch crossed at 1 s has not gone out; the video pauses before it, not after it.
  await vi.waitFor(() => expect(outputs(test)).toEqual(['pause']));
  await pausing; expect(outputs(test)).toEqual(['pause']);
  test.time(6000); test.session.clock(1000, 6000); await test.session.settled();
  expect(outputs(test)).toEqual(['pause', 'start', '特写']);
  expect(lateLogs(test)).toEqual([]); expect(test.session.error).toBeNull();
});

it('播放位置跳了一下（按 Cue 定位、电脑卡顿）：已经在播的素材不重播，只按当前位置补上画面', async () => {
  const test = setup(coveredVideoFixture()); await test.session.prepare(0); await test.advance(0, 700);
  test.time(1500); test.session.clock(1500); await test.session.settled();
  expect(test.faults).toEqual(['播放位置更新中断了 800 ms，画面已按当前位置恢复']);
  expect(outputs(test)).toEqual(['特写']);
  await test.advance(1600, 4500);
  expect(mediaCalls(test)).toEqual(['start clip']); expect(test.dependencies.seekMedia).not.toHaveBeenCalled();
  expect(scenes(test)).toEqual(['特写', test.dependencies.executeManagedMediaEvent.mock.calls[0]![0].event.sceneName]);
  expect(test.session.error).toBeNull();
});

it('同一个素材切成两段接着播：后一段在切点照常上画面（交给同一个解码器，不停、不定位），前一段不停', async () => {
  const project = videoFixture(), item = project.rundown[0]!;
  item.referenceMediaClips[0]!.durationMs = 1000;
  item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'clip-b', startTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, sourceOffsetMs: 1000, durationMs: 1000 });
  const test = setup(parseLinkProject(project)); await test.session.prepare(0); await test.advance(0, 2500);
  expect(mediaCalls(test)).toEqual(['start clip', 'start clip-b', 'stop clip-b']);
  const later = test.dependencies.executeManagedMediaEvent.mock.calls[1]![0].event;
  expect(later).toMatchObject({ sourceOffsetMs: 1000, deferSceneSwitch: false });
  expect(test.dependencies.seekMedia).not.toHaveBeenCalled(); expect(test.session.error).toBeNull();
});

/** Cameras on one track: `[seconds, durationMs, scene]` each. */
function camerasFixture(cameras: [number, number, string][]): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('机位'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-camera', name: '机位' }], cues: cameras.map(([seconds, durationMs, sceneName], index) => ({
      id: `camera-${index}`, name: sceneName, layerId: 'layer-camera', durationMs, timecode: { hours: 0, minutes: 0, seconds, frames: 0 },
      actions: [{ id: `switch-${index}`, kind: 'obs.setProgramScene' as const, label: '切机位', sceneName }] })) }] });
}

it('接连两个机位片段切到同一个场景：后一个照样发切换（手动切走、切换被拒绝后，下一个机位片段把画面拿回来）', async () => {
  const project = camerasFixture([[0, 1000, '全景'], [1, 1000, '特写'], [2, 1000, '特写']]);
  const test = setup(project); await test.session.prepare(0); await test.advance(0, 3500);
  // The camera held after the last one ends is the same Cue: nothing more is sent.
  expect(scenes(test)).toEqual(['全景', '特写', '特写']);
  let refused = true;
  const again = setup(project, action => {
    if (action.kind !== 'obs.setProgramScene' || action.sceneName !== '特写' || !refused) return Promise.resolve();
    refused = false; return Promise.reject(new Error('OBS 拒绝了'));
  });
  // The refused switch is sent once more right after (2026-11-10 第 2 题); the next camera switches again all the same.
  await again.session.prepare(0); await again.advance(0, 1900);
  expect(scenes(again)).toEqual(['全景', '特写', '特写']);
  await again.advance(2000, 3500);
  expect(scenes(again)).toEqual(['全景', '特写', '特写', '特写']);
  expect(results(again, 'switch-2')).toEqual([['switch-2', 'succeeded']]); expect(again.session.error).toBeNull();
});

it('OBS 重连：确认隐藏过的来源，恢复画面和停歌时都不再隐藏；隐藏没成功的，恢复画面和停歌时照样隐藏', async () => {
  const test = setup(stickerFixture()); await test.session.prepare(0); await test.advance(0, 2000);
  expect(sticker(test)).toEqual([true, false]);
  await test.session.recover(() => Promise.resolve()); await test.advance(2100, 2500);
  await test.session.release();
  expect(sticker(test)).toEqual([true, false]);
  // OBS refuses every hide: the source may still be on air, so it is hidden once more (2026-11-10 第 2 题),
  // again after the reconnect and at stop.
  const refusing = setup(stickerFixture(), action => action.kind === 'obs.setSceneItemEnabled' && !action.enabled ? Promise.reject(new Error('OBS 拒绝了')) : Promise.resolve());
  await refusing.session.prepare(0); await refusing.advance(0, 2000);
  expect(sticker(refusing)).toEqual([true, false, false]);
  await refusing.session.recover(() => Promise.resolve());
  expect(sticker(refusing)).toEqual([true, false, false, false]);
  await refusing.advance(2100, 2500);
  await refusing.session.release().catch(() => undefined);
  expect(sticker(refusing)).toEqual([true, false, false, false, false]);
});

it('OBS 重连恢复画面让素材继续播放时按了暂停：继续以后素材照常播放，不会整首歌停着', async () => {
  const test = setup(videoFixture()); await test.session.prepare(0); await test.advance(0, 1500);
  let located = false, paused = false;
  test.dependencies.seekMedia.mockImplementation(() => { located = !paused; return Promise.resolve(); });
  // The real guard checks `canSend` when the request goes out and refuses after a pause.
  test.dependencies.guardOutput = async <T,>(canSend: () => boolean, operation: () => Promise<T>): Promise<T> => {
    if (located) { located = false; paused = true; void test.session.pause(); }
    if (!canSend()) throw new Error('画面已取消');
    return operation();
  };
  await test.session.recover(() => Promise.resolve()).catch(() => null);
  const before = outputs(test).length;
  test.time(4000); test.session.clock(1500, 4000); await test.session.settled();
  expect(outputs(test).slice(before)).toContain('start');
  expect(test.session.error).toBeNull();
});

/** Videos on their own tracks: [clip id, asset id, track, start s, length ms], the first track on top. */
function clipsFixture(clips: [string, string, string, number, number][], layers: string[]): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('素材'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [...new Set(clips.map(clip => clip[1]))].map(id => ({ id, name: id, kind: 'video', relativePath: `assets/${id}.mp4`, sha256: 'a'.repeat(64), byteLength: 1, durationMs: 20000, width: 1920, height: 1080 })),
    rundown: [{ id: 'song', title: '歌曲', cues: [], visualLayers: layers.map(id => ({ id, name: id })),
      referenceMediaClips: clips.map(([id, assetId, layerId, seconds, durationMs]) => ({ id, assetId, layerId, label: id, startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs })) }] });
}
const mediaSent = (test: ReturnType<typeof setup>): string[] => test.dependencies.executeManagedMediaEvent.mock.calls.map(([payload]) => `${payload.event.phase} ${payload.event.clipId}`);
const mediaLogs = (test: ReturnType<typeof setup>): string[] => test.dependencies.recordLog.mock.calls.map(([entry]) => entry.message).filter(message => message.includes('素材 ·'));

it('OBS 重连时已经结束的素材：恢复画面不再发它的停止，只记一条“没有成功启动”的跳过（2026-11-11 R3c 按账本判断）', async () => {
  const test = setup(clipsFixture([['a', 'va', 'track', 0, 1000], ['b', 'vb', 'track', 2, 3000]], ['track']));
  await test.session.prepare(0); await test.advance(0, 900);
  const restoring = deferred(), rebuilt = test.session.recover(() => restoring.promise);
  for (let at = 1000; at <= 1300; at += 100) { test.time(at); test.session.clock(at); }
  restoring.release(); await rebuilt; await test.advance(1400, 2500); await test.session.release();
  expect(mediaSent(test)).toEqual(['start a', 'start b', 'stop b']);
  expect(mediaLogs(test)).toEqual(['播放素材 · va · succeeded', '停止素材 · va · skipped：对应的片段这次没有成功启动', '播放素材 · vb · succeeded', '停止素材 · vb · succeeded']);
  expect(test.session.error).toBeNull();
});

it('几路素材同时在播：画面读回和停歌按最近一次开播的先后，同一个素材后一段从头再排（2026-11-11 R3c，R8 读回）', async () => {
  const project = clipsFixture([['a', 'va', 'upper', 0, 3000], ['b', 'vb', 'lower', 1, 15000], ['c', 'va', 'upper', 4, 12000]], ['upper', 'lower']);
  const test = setup(project), read = reader(test.dependencies.now);
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', { ...test.dependencies, readPicture: read.readPicture });
  await session.prepare(0);
  for (let time = 0; time <= 10000; time += 100) await step(session, test, time);
  const at = (time: number): string[] | undefined => read.asked.find(entry => entry.at === time)?.decoders;
  expect([at(5000), at(10000)]).toEqual([[`${source(project, 'b')} 4000`, `${source(project, 'c')} 1000`], [`${source(project, 'b')} 9000`, `${source(project, 'c')} 6000`]]);
  await session.release();
  expect(mediaSent(test).slice(-2)).toEqual(['stop b', 'stop c']);
});

it('OBS 重连恢复画面中途停歌：恢复时要定位的素材照样停掉，恢复前已经结束的不再停（2026-11-11 R3c）', async () => {
  const seeking = deferred();
  const test = setup(clipsFixture([['a', 'va', 'one', 0, 9000], ['b', 'vb', 'two', 0, 9000], ['c', 'vc', 'three', 1, 9000], ['d', 'vd', 'four', 0, 1000]], ['one', 'two', 'three', 'four']));
  await test.session.prepare(0); await test.advance(0, 900);
  test.dependencies.seekMedia.mockImplementation(() => seeking.promise);
  const rebuilt = test.session.recover(() => Promise.resolve());
  test.time(1200); test.session.clock(1200);
  await vi.waitFor(() => expect(test.dependencies.seekMedia).toHaveBeenCalled());
  const stopping = test.session.release(); seeking.release(); await rebuilt.catch(() => null); await stopping;
  expect(mediaSent(test)).toEqual(['start a', 'start b', 'start d', 'stop a', 'stop b', 'stop c']);
});

it('从中间开播定位素材时停歌：还没定位的素材也照样停掉（2026-11-11 R3c）', async () => {
  const seeking = deferred();
  const test = setup(clipsFixture([['a', 'va', 'one', 0, 9000], ['b', 'vb', 'two', 0, 9000]], ['one', 'two']));
  test.dependencies.seekMedia.mockImplementationOnce(() => seeking.promise);
  const preparing = test.session.prepare(1500).catch(() => null);
  await vi.waitFor(() => expect(test.dependencies.seekMedia).toHaveBeenCalled());
  const stopping = test.session.release(); seeking.release(); await preparing; await stopping;
  expect(test.dependencies.seekMedia).toHaveBeenCalledOnce();
  expect(mediaSent(test)).toEqual(['stop a', 'stop b']);
});

it('素材开始或结束后 1 秒内读回不看素材（2026-11-11 R3c，R8 读回）', async () => {
  const project = clipsFixture([['a', 'va', 'upper', 0, 20000], ['b', 'vb', 'lower', 4, 3000]], ['upper', 'lower']);
  project.rundown[0]!.referenceMediaClips[1]!.startTimecode.frames = 15;
  const test = setup(project), read = reader(test.dependencies.now);
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', { ...test.dependencies, readPicture: read.readPicture });
  await session.prepare(0);
  for (let time = 0; time <= 10000; time += 100) await step(session, test, time);
  // b starts at 4.5 s and ends at 7.5 s: the readings at 5 s and 8 s compare no material; a reading takes a material
  // only once it was on air for a second (b at 6 s).
  const a = source(project, 'a'), b = source(project, 'b');
  expect(read.asked.map(entry => [entry.at, entry.decoders])).toEqual([[0, []], [1000, [`${a} 1000`]], [2000, [`${a} 2000`]], [3000, [`${a} 3000`]], [4000, [`${a} 4000`]],
    [5000, []], [6000, [`${a} 6000`, `${b} 1500`]], [7000, [`${a} 7000`, `${b} 2500`]], [8000, []], [9000, [`${a} 9000`]], [10000, [`${a} 10000`]]]);
  await session.release();
});

it('OBS 重连恢复画面后自有输出场景里的来源：重连前隐藏没成功的，恢复画面时再隐藏一次，下一个来源不再另外隐藏它（2026-11-11 R3c）', async () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('来源'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'cams', name: '机位' }], cues: [
      { id: 'one', name: '一号', layerId: 'cams', durationMs: 1000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: 'one-show', kind: 'obs.setSceneItemEnabled', label: '显示一号', sceneName: '团播联动台输出', sourceName: '一号', enabled: true }] },
      { id: 'two', name: '二号', layerId: 'cams', durationMs: 4000, timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 },
        actions: [{ id: 'two-show', kind: 'obs.setSceneItemEnabled', label: '显示二号', sceneName: '团播联动台输出', sourceName: '二号', enabled: true }] }] }] });
  let refused = false;
  const test = setup(project, action => action.kind === 'obs.setSceneItemEnabled' && !action.enabled && !refused ? (refused = true, Promise.reject(new Error('OBS 拒绝'))) : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 1500);
  await test.session.recover(() => Promise.resolve()); await test.advance(1600, 3000); await test.session.release();
  expect(test.actions.map(action => action.kind === 'obs.setSceneItemEnabled' ? `${action.sourceName} ${action.enabled}` : action.kind)).toEqual(['一号 true', '一号 false', '一号 false', '二号 true', '二号 false']);
});

it('素材停止被 OBS 拒绝后 OBS 重连，恢复画面前停歌：停歌时照样再停一次（2026-11-11 R3c）', async () => {
  const test = setup(clipsFixture([['a', 'va', 'track', 0, 1000]], ['track']));
  test.dependencies.executeManagedMediaEvent.mockImplementation(payload => payload.event.id === 'managed-media:a:stop' ? Promise.reject(new Error('OBS 拒绝')) : Promise.resolve());
  await test.session.prepare(0); await test.advance(0, 1500);
  const restoring = deferred(), rebuilt = test.session.recover(() => restoring.promise);
  const stopping = test.session.release(); restoring.release(); await rebuilt.catch(() => null); await stopping;
  // The refused stop was sent once more right after it (2026-11-10 第 2 题), then once at the song's stop.
  expect(mediaSent(test)).toEqual(['start a', 'stop a', 'stop a', 'stop a']);
});

it('素材已经停好后 OBS 重连，恢复画面前停歌：不再停第二次（2026-11-11 R3c）', async () => {
  const test = setup(clipsFixture([['a', 'va', 'track', 0, 1000]], ['track']));
  await test.session.prepare(0); await test.advance(0, 1500);
  const restoring = deferred(), rebuilt = test.session.recover(() => restoring.promise);
  const stopping = test.session.release(); restoring.release(); await rebuilt.catch(() => null); await stopping;
  expect(mediaSent(test)).toEqual(['start a', 'stop a']);
});

/** A session with what R5 reports: the parts listed each time they change, and the red texts cleared. */
function repairing(project: LinkProject, execute?: (action: LinkAction) => Promise<void>, extra: Partial<ObsProgramSessionDependencies> = {}) {
  const test = setup(project, execute), items: ObsPictureItem[][] = [], cleared: string[] = [];
  const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', { ...test.dependencies,
    pictureItems: list => items.push(list), clearFault: message => cleared.push(message), ...extra });
  const advance = async (from: number, through: number): Promise<void> => {
    for (let time = from; time <= through; time += 100) { test.time(time); session.clock(time); await session.settled(); }
  };
  const deviceLogs = (): { level: string; message: string; details: unknown }[] => test.dependencies.recordLog.mock.calls.map(([entry]) => entry)
    .filter(entry => entry.category === 'device').map(entry => ({ level: entry.level, message: entry.message, details: entry.details }));
  return { ...test, session, items, cleared, advance, deviceLogs, last: () => items.at(-1) ?? [] };
}
const REPAIRED = '切换节目画面没有成功（OBS 拒绝了），已按现在该有的画面自动补发一次（这首歌第 1 次，最多 20 次）。补上了就不用处理';
const AT_LIMIT = '切换节目画面：这一项画面补发了一次还是没成功，到下一段会按时间线照常切换。请检查 OBS 里的这个场景或来源';

describe('失败分级接线，自动补一次（2026-11-10 第 2 题，0.5.9 R5）', () => {
  it('切换被拒绝一次：下一次时钟按现在该有的画面补发一次，补上了这一项就从列表里拿掉，红字收回；运行日志记通道、哪一项、第几次和上限', async () => {
    let refused = false;
    const test = repairing(camerasFixture([[0, 1000, '全景'], [1, 1000, '特写'], [2, 1000, '全景']]), action => {
      if (action.kind !== 'obs.setProgramScene' || action.sceneName !== '特写' || refused) return Promise.resolve();
      refused = true; return Promise.reject(new Error('OBS 拒绝了'));
    });
    await test.session.prepare(0); await test.advance(0, 1500);
    expect(scenes(test)).toEqual(['全景', '特写', '特写']);
    expect(test.faults).toEqual([REPAIRED]);
    expect(test.items.map(list => list.map(item => item.state))).toEqual([['failed'], ['repairing'], []]);
    expect(test.cleared).toEqual([REPAIRED]);
    expect(test.deviceLogs()).toEqual([{ level: 'warning', message: REPAIRED, details: { channel: 'obs', item: 'program',
      recoveries: [{ row: 'picture.element', key: `program@${JSON.stringify(['特写', 'camera-1'])}`, count: 1, max: 1 }, { row: 'picture.song', key: 'song', count: 1, max: 20 }] } }]);
    expect(test.session.error).toBeNull();
  });

  it('补发一次还是不行：不再补，这一项标红写明到下一段照常切换；过了切点应有的状态变了，失败记录作废，自己就好', async () => {
    const test = repairing(camerasFixture([[0, 1000, '全景'], [1, 1000, '特写'], [2, 1000, '全景']]),
      action => action.kind === 'obs.setProgramScene' && action.sceneName === '特写' ? Promise.reject(new Error('OBS 拒绝了')) : Promise.resolve());
    await test.session.prepare(0); await test.advance(0, 1900);
    expect(scenes(test)).toEqual(['全景', '特写', '特写']);
    expect(test.faults).toEqual([REPAIRED, AT_LIMIT]);
    expect(test.last()).toEqual([{ id: 'program', scope: 'item', state: 'limit', detail: AT_LIMIT }]);
    expect(test.deviceLogs().map(entry => entry.level)).toEqual(['warning', 'error']);
    await test.advance(2000, 2500);
    expect(scenes(test)).toEqual(['全景', '特写', '特写', '全景']);
    expect(test.last()).toEqual([]); expect(test.cleared).toContain(AT_LIMIT);
    expect(test.faults).toHaveLength(2); expect(test.session.error).toBeNull();
  });

  it('每首歌合计最多自动补 20 次：之后失败的只标红“这首歌自动补画面已到上限”，照常按时间线切', async () => {
    const cameras = Array.from({ length: 24 }, (_, index): [number, number, string] => [index, 1000, `机位 ${index}`]);
    const test = repairing(camerasFixture(cameras), action => action.kind === 'obs.setProgramScene' && action.sceneName !== '机位 0' ? Promise.reject(new Error('OBS 拒绝了')) : Promise.resolve());
    await test.session.prepare(0); await test.advance(0, 23900);
    // Each of 23 refused cameras: its own switch; the first 20 of them once more. From the 20th on (its own
    // repair failed too, and the song has none left) each is in red with the song's limit.
    expect(scenes(test)).toHaveLength(1 + 23 + 20);
    expect(test.faults.filter(message => message.includes('自动补发一次'))).toHaveLength(20);
    expect(test.faults.filter(message => message.includes('这首歌自动补画面已到上限'))).toEqual(
      Array.from({ length: 4 }, () => '切换节目画面没有成功：这首歌自动补画面已到上限，后面只按时间线切换。请检查 OBS 是否卡顿'));
    expect(test.session.error).toBeNull();
  });

  it('请求还在路上（OBS 回应慢）时不补，免得和慢回应叠在一起；回应是失败以后才补一次', async () => {
    let refuse = (): void => undefined;
    const answer = new Promise<void>((_resolve, reject) => { refuse = () => reject(new Error('OBS 拒绝了')); });
    let first = true;
    const test = repairing(camerasFixture([[0, 1000, '全景'], [1, 2000, '特写']]), action => {
      if (action.kind !== 'obs.setProgramScene' || action.sceneName !== '特写' || !first) return Promise.resolve();
      first = false; return answer;
    });
    await test.session.prepare(0); await test.advance(0, 900);
    for (let time = 1000; time <= 1500; time += 100) { test.time(time); test.session.clock(time); await Promise.resolve(); }
    expect(scenes(test)).toEqual(['全景', '特写']);
    refuse(); await test.session.settled(); await test.advance(1600, 1900);
    expect(scenes(test)).toEqual(['全景', '特写', '特写']);
    expect(test.session.error).toBeNull();
  });

  it('素材开播没有回应：记成“不确定”，下一次时钟补发一次，回应了就从列表里拿掉', async () => {
    const project = videoFixture(); project.rundown[0]!.referenceMediaClips[0]!.startTimecode.seconds = 1;
    let answer: ManagedMediaOutcome = { kind: 'unanswered', reason: 'OBS 播放素材请求超时（2000 ms）；不确定是否已执行' };
    const execute = vi.fn<(payload: { projectPath: string; event: ManagedMediaEvent }) => Promise<ManagedMediaOutcome>>(() => { const outcome = answer; answer = { kind: 'done' }; return Promise.resolve(outcome); });
    const test = repairing(project, undefined, { executeManagedMediaEvent: execute });
    await test.session.prepare(0); await test.advance(0, 1300);
    expect(execute.mock.calls.map(([payload]) => `${payload.event.phase} ${payload.event.clipId}`)).toEqual(['start clip', 'start clip']);
    expect(test.faults).toEqual(['素材“视频”没有成功（OBS 播放素材请求超时（2000 ms）；不确定是否已执行），已按现在该有的画面自动补发一次（这首歌第 1 次，最多 20 次）。补上了就不用处理']);
    // The clip and the switch to its scene went out in one step: both are not known, the clip's start is repaired.
    const listed = test.items[1] ?? [];
    expect(listed.map(item => [item.scope, item.state])).toEqual([['item', 'uncertain'], ['item', 'uncertain']]);
    expect(listed[0]?.id).toMatch(/^decoder:/); expect(listed[0]?.detail).toContain('素材“视频”不确定 OBS 有没有做到。原因：');
    expect(listed[1]?.id).toBe('program'); expect(listed[1]?.detail).toContain('切换节目画面不确定 OBS 有没有做到');
    expect(test.items.flat().filter(item => item.state === 'repairing').map(item => item.id)).toEqual([expect.stringMatching(/^decoder:/)]);
    expect(test.last()).toEqual([]);
    expect(test.session.error).toBeNull();
  });

  it('素材已经在画面上、只是和音乐没对齐：不重新开播，列为“没对齐”，交给漂移校正；对齐了就拿掉', async () => {
    const execute = vi.fn<(payload: { projectPath: string; event: ManagedMediaEvent }) => Promise<ManagedMediaOutcome>>(() => Promise.resolve<ManagedMediaOutcome>({ kind: 'failed', reason: '切场景后素材位置对不上：视频', onAir: true, outOfStep: true, sent: true }));
    const correct = vi.fn<(event: ManagedMediaEvent, mayCorrect: (driftMs: number) => boolean) => Promise<number | null>>(() => Promise.resolve(null));
    let drift = 400;
    const read = reader(() => test.dependencies.now(), () => drift);
    const test = repairing(videoFixture(), undefined, { executeManagedMediaEvent: execute, correctMediaDrift: correct, readPicture: read.readPicture });
    await test.session.prepare(0); await test.advance(0, 900);
    expect(execute).toHaveBeenCalledOnce();
    expect(test.last()).toEqual([{ id: 'drift:clip', scope: 'item', state: 'not-aligned', detail: '素材“视频”已经在画面上，但和音乐没对齐。差得多时联动台过几秒会自动按音乐校正，不用处理' }]);
    // The read-back finds it 400 ms off; by the time it is corrected OBS has it in step.
    for (let time = 1000; time <= 1100; time += 100) await step(test.session, test, time);
    drift = 0;
    await test.advance(1200, 5200);
    expect(correct).toHaveBeenCalled(); expect(test.last()).toEqual([]);
    expect(execute).toHaveBeenCalledOnce(); expect(test.faults).toEqual([]);
  });

  it('漂移校正每段 60 秒内只校正 1 次：再对不上就标红“素材和音乐一直对不上”，不反复校正，过了 60 秒再校正', async () => {
    const project = videoFixture();
    project.mediaAssets[0]!.durationMs = 90000; project.rundown[0]!.referenceMediaClips[0]!.durationMs = 90000;
    const corrected: number[] = [];
    let now = (): number => 0;
    const correct = vi.fn((_event: ManagedMediaEvent, mayCorrect: (driftMs: number) => boolean) => {
      if (!mayCorrect(500)) return Promise.resolve(null);
      corrected.push(now()); return Promise.resolve(500);
    });
    const read = reader(() => now(), () => 500);
    const test = repairing(parseLinkProject(project), undefined, { correctMediaDrift: correct, readPicture: read.readPicture });
    now = test.dependencies.now;
    await test.session.prepare(0);
    for (let time = 0; time <= 61500; time += 100) await step(test.session, test, time);
    // Read back every second (R8): corrected at 1 s, left as it is from 2 s to 60 s (said once), corrected again at 61 s.
    expect(corrected).toEqual([1000, 61000]);
    expect(test.faults).toEqual(['素材和音乐差了 500 ms，已按当前位置校正：视频',
      '素材“视频”和音乐差了 500 ms，这一分钟里已经校正过，不再反复校正：素材和音乐一直对不上，请检查 OBS 是否卡顿',
      '素材和音乐差了 500 ms，已按当前位置校正：视频']);
    expect(test.deviceLogs().map(entry => entry.details)).toEqual(Array.from({ length: 3 }, () =>
      ({ channel: 'obs', item: 'drift:clip', recoveries: [{ row: 'picture.drift', key: 'clip', count: 1, max: 1 }] })));
    expect(test.session.error).toBeNull();
  });

  it('素材开播被拒绝：一个请求都没发出去的记“没有成功”，发出了一部分的记“不确定”（R3b 两条）；片段结束后这一项自己从列表里拿掉', async () => {
    for (const sent of [false, true]) {
      const project = videoFixture(); project.rundown[0]!.referenceMediaClips[0]!.durationMs = 2000;
      let first = true;
      const execute = vi.fn((payload: { projectPath: string; event: ManagedMediaEvent }): Promise<ManagedMediaOutcome> => {
        if (payload.event.phase !== 'start' || !first) return Promise.resolve({ kind: 'done' });
        first = false; return Promise.resolve({ kind: 'failed', reason: 'OBS 拒绝了', onAir: false, outOfStep: false, sent });
      });
      const test = repairing(project, undefined, { executeManagedMediaEvent: execute });
      await test.session.prepare(0); await test.advance(0, 300);
      expect(test.items.flat().find(item => item.id.startsWith('decoder:'))).toMatchObject(sent
        ? { state: 'uncertain', detail: '素材“视频”不确定 OBS 有没有做到。原因：OBS 拒绝了' }
        : { state: 'failed', detail: '素材“视频”没有成功。原因：OBS 拒绝了' });
      await test.advance(400, 3000);
      expect(test.last().filter(item => item.id.startsWith('decoder:'))).toEqual([]);
      expect(test.session.error).toBeNull();
    }
  });

  it('OBS 断着时别的画面动作照常排进来：断线前失败的也不补，不花次数，也不标“到上限”', async () => {
    let connected = true;
    const test = repairing(stickerSpanFixture(), () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), { connected: () => connected });
    await test.session.prepare(0); await test.advance(0, 900);
    // The sticker's show at 1 s fails offline; the close-up at 1.2 s and its end at 1.5 s come through the same pass that would repair it.
    connected = false; await test.advance(1000, 2500);
    expect(test.actions.filter(action => action.kind === 'obs.setSceneItemEnabled' && action.enabled)).toHaveLength(1);
    expect(test.faults.filter(message => message.includes('自动补发') || message.includes('上限'))).toEqual([]);
    expect(test.session.error).toBeNull();
  });

  it('同一步里两项都失败、这首歌只剩 1 次：只补先轮到的那一项，另一项标红“这首歌自动补画面已到上限”', async () => {
    // 19 refused cameras use 19 of the song's 20; then a camera and a shown sticker start together, both refused.
    const cameras = Array.from({ length: 21 }, (_, index) => ({ id: `camera-${index}`, name: `机位 ${index}`, layerId: 'layer-camera', durationMs: 1000,
      timecode: { hours: 0, minutes: 0, seconds: index, frames: 0 }, actions: [{ id: `switch-${index}`, kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: `机位 ${index}` }] }));
    const project = parseLinkProject({ ...createEmptyLinkProject('机位'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'layer-sticker', name: '贴纸' }, { id: 'layer-camera', name: '机位' }], cues: [...cameras,
        { id: 'show', name: '贴纸', layerId: 'layer-sticker', durationMs: 900, timecode: { hours: 0, minutes: 0, seconds: 20, frames: 0 },
          actions: [{ id: 'sticker', kind: 'obs.setSceneItemEnabled' as const, label: '显示贴纸', sceneName: '机位 20', sourceName: '贴纸', enabled: true }] }] }] });
    const test = repairing(project, action => action.kind === 'obs.setProgramScene' && action.sceneName === '机位 0' || action.kind === 'obs.setSceneItemEnabled' && !action.enabled
      ? Promise.resolve() : Promise.reject(new Error('OBS 拒绝了')));
    await test.session.prepare(0); await test.advance(0, 20500);
    const repaired = test.faults.filter(message => message.includes('自动补发一次'));
    expect(repaired).toHaveLength(20);
    expect(repaired.at(-1)).toContain('这首歌第 20 次，最多 20 次');
    expect(test.faults.filter(message => message.includes('这首歌自动补画面已到上限'))).toHaveLength(2);
    expect(test.session.error).toBeNull();
  });

  it('OBS 没连上时不补：失败是连接的事，不花自动补的次数', async () => {
    let connected = true;
    const test = repairing(camerasFixture([[0, 1000, '全景'], [1, 1000, '特写'], [2, 1000, '全景']]),
      () => connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开')), { connected: () => connected });
    await test.session.prepare(0); await test.advance(0, 900);
    connected = false; await test.advance(1000, 1900);
    expect(scenes(test)).toEqual(['全景', '特写']); expect(test.faults).toEqual([]);
    expect(test.session.error).toBeNull();
  });
});

describe('停止后画面停在最后一帧（R14）', () => {
  const what = (action: LinkAction): string => action.kind === 'obs.mediaAction' ? `${action.action} ${action.inputName}`
    : action.kind === 'obs.setSceneItemEnabled' ? `${action.sourceName} ${String(action.enabled)}` : action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind;

  it('停止：在播的素材原地暂停、照常显示，节目场景不动，这首歌显示的来源照常隐藏；素材的停止和交还输出等 release', async () => {
    const test = setup(stickerOverVideoFixture());
    await test.session.prepare(0); await test.advance(0, 1500);
    const before = test.actions.length, video = test.dependencies.executeManagedMediaEvent.mock.calls[0]![0].event.sourceName;
    await test.session.stop();
    // One pause of the clip on air and the sticker hidden: no scene switch, no stop or hide of the clip.
    expect(test.actions.slice(before).map(what)).toEqual([`pause ${video}`, '贴纸 false']);
    expect(mediaSent(test)).toEqual(['start clip']);
    expect(test.dependencies.holdOutputs).toHaveBeenCalledExactlyOnceWith([{ sourceName: video, clipId: 'clip' }]);
    expect(test.dependencies.releaseOutputs).not.toHaveBeenCalled();
    expect(test.session.heldClips()).toEqual([{ sourceName: video, clipId: 'clip' }]);
    await test.session.release();
    expect(mediaSent(test)).toEqual(['start clip', 'stop clip']);
    expect(test.actions.slice(before).map(what)).toEqual([`pause ${video}`, '贴纸 false']);
    expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
    // Once taken off nothing of it counts as on air.
    expect(test.session.heldClips()).toEqual([]);
    expect(test.session.error).toBeNull();
  });

  it('暂停着停止：素材已经停在那一帧，不再发暂停', async () => {
    const test = setup(videoFixture());
    await test.session.prepare(0); await test.advance(0, 1000);
    await test.session.pause();
    const before = test.actions.length;
    await test.session.stop();
    expect(test.actions.slice(before).map(what)).toEqual([]);
    expect(mediaSent(test)).toEqual(['start clip']);
    expect(test.dependencies.holdOutputs).toHaveBeenCalledOnce();
  });

  it('release 只停还由这首歌占着的素材：后面的歌接手了的不再停，输出照样交还', async () => {
    const test = setup(videoFixture());
    const session = new ObsProgramSession(videoFixture(), 'C:/shows/test.tblink', 'song', { ...test.dependencies, heldClipIds: () => new Set<string>() });
    await session.prepare(0);
    for (let time = 0; time <= 1000; time += 100) { test.time(time); session.clock(time); await session.settled(); }
    await session.stop(); await session.release();
    expect(mediaSent(test)).toEqual(['start clip']);
    expect(test.dependencies.releaseOutputs).toHaveBeenCalledOnce();
  });

  it('自有输出场景里的机位：停止时不隐藏；release 时隐藏，下一首正在显示的同一个机位留着', async () => {
    const project = () => parseLinkProject({ ...createEmptyLinkProject('机位'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'cams', name: '机位' }, { id: 'other', name: '二号机位' }], cues: [
        { id: 'one', name: '一号', layerId: 'cams', durationMs: 4000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
          actions: [{ id: 'one-show', kind: 'obs.setSceneItemEnabled', label: '显示一号', sceneName: '团播联动台输出', sourceName: '一号', enabled: true }] },
        { id: 'two', name: '二号', layerId: 'other', durationMs: 4000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
          actions: [{ id: 'two-show', kind: 'obs.setSceneItemEnabled', label: '显示二号', sceneName: '团播联动台输出', sourceName: '二号', enabled: true }] }] }] });
    const shown = (test: ReturnType<typeof setup>) => test.actions.filter(action => action.kind === 'obs.setSceneItemEnabled').map(what);
    const kept = setup(project());
    await kept.session.prepare(0); await kept.advance(0, 1000);
    expect(shown(kept)).toEqual(['一号 true', '二号 true']);
    await kept.session.stop();
    expect(shown(kept)).toEqual(['一号 true', '二号 true']);
    await kept.session.release(() => new Set(['一号']));
    expect(shown(kept)).toEqual(['一号 true', '二号 true', '二号 false']);
    const closed = setup(project());
    await closed.session.prepare(0); await closed.advance(0, 1000); await closed.session.stop(); await closed.session.release();
    expect(shown(closed)).toEqual(['一号 true', '二号 true', '一号 false', '二号 false']);
  });
});

// ---- 0.5.9 R8: the picture read back, and a scene switched by hand in OBS (2026-11-10 decision 5) ----

describe('画面读回和手动接管（R8，2026-11-10 第 5 题）', () => {
  /** A session with the read-back: what OBS has on program follows the switches sent and the hand switches. */
  function following(project: LinkProject, execute?: (action: LinkAction) => Promise<void>, music: () => 'carried' | 'missing' = () => 'carried', online?: () => boolean) {
    let onProgram = '';
    const test = setup(project, async action => { await execute?.(action); if (action.kind === 'obs.setProgramScene') onProgram = action.sceneName; }, online);
    const follows: string[] = [], takeovers: (string | null)[] = [], items: ObsPictureItem[][] = [], cleared: string[] = [];
    let programShown = (scene: string): string => scene;
    const readPicture = vi.fn((request: PictureReadRequest): Promise<PictureReading> => Promise.resolve({ kind: 'read', programScene: programShown(onProgram), transitioning: false,
      decoders: request.decoders.map(decoder => ({ sourceName: decoder.sourceName, state: 'playing', driftMs: 0 })), music: { kind: music() } }));
    const session = new ObsProgramSession(project, 'C:/shows/test.tblink', 'song', { ...test.dependencies,
      readPicture, pictureItems: list => items.push(list), clearFault: message => cleared.push(message),
      pictureFollow: (follow, takeover) => { follows.push(`${follow.state}：${follow.detail}`); takeovers.push(takeover?.sceneName ?? null); } });
    const advance = async (from: number, through: number): Promise<void> => { for (let time = from; time <= through; time += 100) await step(session, test, time); };
    /** Someone switches the program in OBS: OBS has it, and reports it. */
    const handSwitch = (sceneName: string): void => { onProgram = sceneName; session.programSceneChanged(sceneName); };
    return { ...test, session, readPicture, follows, takeovers, items, cleared, advance, handSwitch, last: () => items.at(-1) ?? [],
      /** OBS shows another program than it reported (a change event lost, say). */
      showOnProgram: (shown: ((scene: string) => string)) => { programShown = shown; } };
  }

  it('播放中在 OBS 里手动切走：不切回去，标黄“被手动接管”，到下一段照常切，切完接管结束', async () => {
    const test = following(camerasFixture([[0, 1000, '全景'], [1, 1000, '特写'], [2, 1000, '全景']]));
    await test.session.prepare(0); await test.advance(0, 500);
    test.handSwitch('观众互动');
    await test.advance(600, 900);
    expect(scenes(test)).toEqual(['全景']);
    expect(test.follows.at(-1)).toBe('taken-over：有人在 OBS 里切到了「观众互动」，联动台不切回去；到下一段画面按时间线照常切换');
    expect(test.takeovers.at(-1)).toBe('观众互动');
    const log = test.dependencies.recordLog.mock.calls.map(([entry]) => entry).find(entry => entry.message.startsWith('有人在 OBS 里把节目画面切到了'));
    expect(log).toMatchObject({ level: 'warning', device: 'obs', details: { sceneName: '观众互动', wanted: '全景' } });
    // A pause and resume rebuilds the picture at the position: still not switched back.
    await test.session.pause(); await step(test.session, test, 950, 900);
    expect(scenes(test)).toEqual(['全景']);
    await test.advance(1000, 3000);
    expect(scenes(test)).toEqual(['全景', '特写', '全景']);
    expect(test.follows.at(-1)).toMatch(/^following：OBS 在播「全景」/);
    expect(test.takeovers.at(-1)).toBeNull();
    expect(test.session.error).toBeNull(); expect(test.faults).toEqual([]);
  });

  it('接管时下一段机位切到同一个场景也照常切（下一个机位片段把画面拿回来）；之后又手动切走照旧接管', async () => {
    const test = following(camerasFixture([[0, 1000, '全景'], [1, 1000, '全景']]));
    await test.session.prepare(0); await test.advance(0, 500);
    test.handSwitch('手动一');
    await test.advance(600, 1500);
    expect(scenes(test)).toEqual(['全景', '全景']);
    test.handSwitch('手动二'); await test.advance(1600, 1900);
    expect(scenes(test)).toEqual(['全景', '全景']); expect(test.follows.at(-1)).toMatch(/^taken-over：.*「手动二」/);
  });

  it('联动台自己切换的回报、切换还在路上时 OBS 报的场景都不算手动接管；手动切回时间线要的场景就不再算接管', async () => {
    const answering = deferred();
    const test = following(camerasFixture([[0, 1000, '全景'], [1, 1000, '特写']]), action => action.kind === 'obs.setProgramScene' && action.sceneName === '特写' ? answering.promise : Promise.resolve());
    await test.session.prepare(0); await test.advance(0, 500);
    test.session.programSceneChanged('全景');
    test.time(1000); test.session.clock(1000);
    await vi.waitFor(() => expect(scenes(test)).toEqual(['全景', '特写']));
    test.session.programSceneChanged('别的');
    answering.release(); await test.session.settled();
    expect(test.follows.filter(entry => entry.startsWith('taken-over'))).toEqual([]);
    await test.advance(1100, 1500);
    test.handSwitch('手动'); expect(test.follows.at(-1)).toMatch(/^taken-over/);
    test.handSwitch('特写');
    expect(test.follows.at(-1)).toBe('checking：OBS 切回了「特写」，画面按时间线照常走'); expect(test.takeovers.at(-1)).toBeNull();
  });

  it('读回：连续两次场景对不上才标“没在跟”；刚切完 1 秒内不比；对上了回到“在跟”', async () => {
    // Started at 0.5 s, so the readings fall at 0.5 s, 1.5 s, 2.5 s …: the one at 1.5 s comes half a second after the cut at 1 s.
    const test = following(camerasFixture([[0, 1000, '全景'], [1, 5000, '特写']]));
    await test.session.prepare(500); await test.advance(500, 1500);
    expect(test.follows).toEqual(['checking：刚切过画面，稍后核对']);
    await test.advance(1600, 2500);
    expect(test.follows.at(-1)).toBe('following：OBS 在播「特写」，和时间线一致');
    test.showOnProgram(() => '别的');
    await test.advance(2600, 3500);
    expect(test.follows.at(-1)).toBe('following：OBS 在播「特写」，和时间线一致');
    await test.advance(3600, 4500);
    expect(test.follows.at(-1)).toBe('not-following：OBS 现在播的是「别的」，按时间线这时应该是「特写」');
    test.showOnProgram(scene => scene);
    await test.advance(4600, 5500);
    expect(test.follows.at(-1)).toBe('following：OBS 在播「特写」，和时间线一致');
    expect(scenes(test)).toEqual(['全景', '特写']);
  });

  it('读不到写“无法确认”和原因；OBS 断着不读、不算次数，写无法确认', async () => {
    let online = true;
    const test = following(camerasFixture([[0, 5000, '全景']]), undefined, undefined, () => online);
    test.readPicture.mockRejectedValueOnce(new Error('OBS 请求超时。'));
    await test.session.prepare(0); await test.advance(0, 0);
    expect(test.follows.at(-1)).toBe('unknown：读不到 OBS 现在的画面：OBS 请求超时');
    online = false; const reads = test.readPicture.mock.calls.length;
    await test.advance(100, 2000);
    expect(test.readPicture.mock.calls.length).toBe(reads);
    expect(test.follows.at(-1)).toBe('unknown：OBS 没有连接，重新连上后再核对画面');
  });

  it('当前场景里没有联动台的音乐：标红写明怎么办（只检查，不往场景里加东西）；有了就拿掉', async () => {
    let music: 'carried' | 'missing' = 'carried';
    const test = following(camerasFixture([[0, 5000, '全景']]), undefined, () => music);
    await test.session.prepare(0); await test.advance(0, 900);
    test.handSwitch('没有音乐的场景'); music = 'missing';
    await test.advance(1000, 1000);
    const text = '当前场景「没有音乐的场景」里没有联动台的音乐，观众听不到歌。请在 OBS 里切回这首歌用的场景，或者把「团播联动台·内部正式音频」加进这个场景';
    expect(test.last()).toEqual([{ id: 'music', scope: 'item', state: 'failed', detail: text }]);
    expect(test.faults).toEqual([text]);
    await test.advance(1100, 2000);
    expect(test.faults).toEqual([text]);
    music = 'carried'; await test.advance(2100, 3000);
    expect(test.last()).toEqual([]); expect(test.cleared).toContain(text);
    expect(test.actions.map(action => action.kind)).toEqual(['obs.setProgramScene']);
  });

  it('停歌以后不再读回，也不会是“没在跟”', async () => {
    const test = following(camerasFixture([[0, 5000, '全景']]));
    await test.session.prepare(0); await test.advance(0, 1500);
    const reads = test.readPicture.mock.calls.length, follows = test.follows.length;
    await test.session.stop();
    test.handSwitch('手动'); test.time(3000); test.session.clock(3000);
    expect(test.readPicture.mock.calls.length).toBe(reads); expect(test.follows.length).toBe(follows);
    await test.session.release();
  });
});
