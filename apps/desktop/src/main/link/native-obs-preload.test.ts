import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativeObsPreload } from '@tb/schema';
import { createObsProgramSnapshot, materialSceneNames } from '@tb/core/link';
import { NativeObsPreloadPool } from './native-obs-preload';
import { ObsPreparationCancelled, type NativeObsOutputs } from './native-obs-outputs';
import type { PictureFailure } from './native-obs-host';

function setup() {
  const project = parseLinkProject({ ...createEmptyLinkProject('预备'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌曲' }] });
  const request: NativeObsPreload = { version: 1, sessionId: crypto.randomUUID(), generation: 1, projectPath: 'C:/show.tblink', preciseSeeking: true,
    positionMs: 500, snapshot: createObsProgramSnapshot(project, 'song', 1) };
  const execute = vi.fn(() => Promise.resolve());
  const outputs: NativeObsOutputs = {
    guardOutput: async (current, operation) => { if (!current()) throw new Error('已取消'); return operation(); },
    executor: { id: 'obs', supports: () => true, execute },
    now: () => performance.now(), preloadResources: vi.fn((current: () => void) => { current(); return Promise.resolve(); }), restoreScenes: vi.fn(() => Promise.resolve()), prepareOutputs: vi.fn(() => Promise.resolve()),
    releaseOutputs: vi.fn(() => Promise.resolve()), seekMedia: vi.fn(() => Promise.resolve()), executeManagedMediaEvent: vi.fn(() => Promise.resolve()),
    recordLog: entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: new Date().toISOString(), monotonicMs: 0 })
  };
  const authorize = vi.fn(() => Promise.resolve()), create = vi.fn(() => outputs), report = vi.fn<(failure: PictureFailure) => void>();
  const pool = new NativeObsPreloadPool({ authorize, create, report });
  const stop = { version: request.version, sessionId: request.sessionId, generation: request.generation };
  const song = (id: string) => ({ ...request.snapshot, item: { ...request.snapshot.item, id } });
  return { request, stop, outputs, execute, authorize, create, report, pool, song };
}

it('选择节目仅预备资源；精确修订和起点接管后旧选择清理不能关闭正式输出', async () => {
  const t = setup(); await t.pool.preload(t.request);
  expect(t.outputs.prepareOutputs).not.toHaveBeenCalled(); expect(t.execute).not.toHaveBeenCalled();
  expect(await t.pool.take({ ...t.request, generation: 3 }, 500, () => undefined)).toBe(t.outputs);
  await t.pool.cancel(t.stop); await t.pool.close();
  expect(t.outputs.releaseOutputs).not.toHaveBeenCalled(); expect(t.create).toHaveBeenCalledTimes(1);
});

it.each(['修订', '起点', '所有者'] as const)('%s 改变后先释放旧资源，不复用旧画面', async change => {
  const t = setup(); await t.pool.preload(t.request);
  const request = { ...t.request, snapshot: { ...t.request.snapshot, revision: change === '修订' ? 2 : 1 },
    sessionId: change === '所有者' ? crypto.randomUUID() : t.request.sessionId };
  await t.pool.take(request, change === '起点' ? 900 : 500, () => undefined);
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.create).toHaveBeenCalledTimes(2);
  expect(vi.mocked(t.outputs.releaseOutputs).mock.invocationCallOrder[0]).toBeLessThan(t.create.mock.invocationCallOrder[1]!);
});

it('选择预备在许可中被正式播放接管：许可因正式准备在途被拒绝也不影响接管；未被接管时照常报错', async () => {
  const t = setup();
  let refuse: (error: Error) => void = () => undefined;
  t.authorize.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
  const preloading = t.pool.preload(t.request);
  await Promise.resolve();
  const taking = t.pool.take({ ...t.request, generation: 3 }, 500, () => undefined);
  refuse(new Error('正在播放时不能准备另一个节目'));
  expect(await taking).toBe(t.outputs); await preloading;
  t.authorize.mockRejectedValueOnce(new Error('正在播放时不能准备另一个节目'));
  await expect(t.pool.preload({ ...t.request, generation: 5 })).rejects.toThrow('不能准备另一个节目');
  // Refused before the song took it over: the song prepares its own picture instead of failing with the preselection.
  t.create.mockClear();
  expect(await t.pool.take({ ...t.request, generation: 6 }, 500, () => undefined)).toBe(t.outputs); expect(t.create).toHaveBeenCalledOnce();
});

it('许可等待中取消不创建素材；新一代可以明确重新准备', async () => {
  const t = setup(); let permit: () => void = () => { throw new Error('未设置许可'); };
  t.authorize.mockImplementationOnce(() => new Promise<void>(resolve => { permit = resolve; }));
  const job = t.pool.preload(t.request); const rejected = expect(job).rejects.toBeInstanceOf(ObsPreparationCancelled);
  await vi.waitFor(() => expect(t.authorize).toHaveBeenCalledTimes(1));
  const cancel = t.pool.cancel(t.stop); permit(); await cancel; await rejected;
  expect(t.create).not.toHaveBeenCalled();
  await t.pool.preload({ ...t.request, generation: 2 }); expect(t.create).toHaveBeenCalledTimes(1);
  await t.pool.close();
});

it('接管中停止立即使原资源预备失效，失败释放且不自动重发', async () => {
  const t = setup(); let complete: () => void = () => { throw new Error('尚未准备'); };
  vi.mocked(t.outputs.preloadResources).mockImplementation(async current => { await new Promise<void>(resolve => { complete = resolve; }); current(); });
  const job = t.pool.preload(t.request); const failed = expect(job).rejects.toThrow('正式会话已取消');
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  let valid = true;
  const taking = t.pool.take(t.request, 500, () => { if (!valid) throw new Error('正式会话已取消'); });
  const rejected = expect(taking).rejects.toThrow('正式会话已取消');
  valid = false; complete(); await failed; await rejected;
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.create).toHaveBeenCalledTimes(1);
});

it('下一首提前完成解码预热，交接不重复创建，当前歌曲结束不再使已接管资源过期', async () => {
  const t = setup();
  const next = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'next' } }, positionMs: 0 };
  let playing = true;
  await t.pool.prepareNext({ ...t.request, nextFiles: next }, () => { if (!playing) throw new Error('上一首已结束'); });
  expect(t.outputs.preloadResources).toHaveBeenCalledWith(expect.any(Function), 'background');
  playing = false;
  expect(await t.pool.take({ ...t.request, generation: 3, snapshot: next.snapshot }, 0, () => undefined)).toBe(t.outputs);
  await t.pool.close();
  expect(t.create).toHaveBeenCalledTimes(1); expect(t.outputs.releaseOutputs).not.toHaveBeenCalled();
});

it('下一首后台预备失败：清理后不留给下一首继承，下一首照常准备，之后的预备也不被挡住（2026-11-09）', async () => {
  const t = setup();
  const next = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'next' } }, positionMs: 0 };
  vi.mocked(t.outputs.preloadResources).mockRejectedValueOnce(new Error('素材文件读不了'));
  await expect(t.pool.prepareNext({ ...t.request, nextFiles: next }, () => undefined)).rejects.toThrow('素材文件读不了');
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1);
  expect(await t.pool.take({ ...t.request, generation: 3, snapshot: next.snapshot }, 0, () => undefined)).toBe(t.outputs);
  expect(t.create).toHaveBeenCalledTimes(2);
  const third = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'third' } }, positionMs: 0 };
  await expect(t.pool.prepareNext({ ...t.request, generation: 3, snapshot: next.snapshot, nextFiles: third }, () => undefined)).resolves.toBe(true);
});

it('下一首后台预备还没完就开歌、随后失败：这首照常准备画面，不把预备的错误当成这首的错误', async () => {
  const t = setup(); let fail: (error: Error) => void = () => { throw new Error('尚未开始'); };
  vi.mocked(t.outputs.preloadResources).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const next = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'next' } }, positionMs: 0 };
  const job = t.pool.prepareNext({ ...t.request, nextFiles: next }, () => undefined);
  // Handed to the song that took it over: whoever asked for it does not report it a second time.
  const handed = expect(job).rejects.toBeInstanceOf(ObsPreparationCancelled);
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  const taking = t.pool.take({ ...t.request, generation: 3, snapshot: next.snapshot }, 0, () => undefined);
  fail(new Error('读取素材失败：Error: 素材文件读不了'));
  expect(await taking).toBe(t.outputs); await handed;
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.create).toHaveBeenCalledTimes(2);
  // Nobody else hears about a failure after the song took the preparation over: it is reported here, once, without code prefixes.
  expect(t.report.mock.calls).toEqual([[{ log: '提前准备的画面没能用上，已改为重新准备。原因：读取素材失败：素材文件读不了', shown: '提前准备的画面没能用上，已改为重新准备。原因：读取素材失败：素材文件读不了' }]]);
});

it.each([0, 1, 2, 3, 4, 5, 6, 7])('下一首提前准备刚失败、过 %i 个微任务下一首来接手：失败只报一次，只清理一次（2026-11-09）', async ticks => {
  const t = setup(); let fail: (error: Error) => void = () => { throw new Error('尚未开始'); };
  vi.mocked(t.outputs.preloadResources).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  // Whoever asked for it reports what is not a cancellation, as the picture host does.
  const asked: string[] = [];
  const job = t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined)
    .catch((error: unknown) => { if (!(error instanceof ObsPreparationCancelled)) asked.push(error instanceof Error ? error.message : String(error)); });
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  fail(new Error('OBS 读取目录 请求排队超时（2000 ms）；还没发送'));
  for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
  expect(await t.pool.take({ ...t.request, generation: 3, snapshot: t.song('B') }, 0, () => undefined)).toBe(t.outputs);
  await job;
  expect([...asked, ...t.report.mock.calls.map(([failure]) => failure.log)]).toHaveLength(1);
  expect(t.outputs.releaseOutputs).toHaveBeenCalledOnce(); expect(t.create).toHaveBeenCalledTimes(2);
});

it('下一首修订不匹配时清理其解码器，不能把旧预备结果当成新工程', async () => {
  const t = setup();
  const next = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'next' } }, positionMs: 0 };
  await t.pool.prepareNext({ ...t.request, nextFiles: next }, () => undefined);
  await t.pool.take({ ...t.request, snapshot: { ...next.snapshot, revision: 2 } }, 0, () => undefined);
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.create).toHaveBeenCalledTimes(2);
});

it('下一首共用当前视频来源时不修改活动解码器', async () => {
  const t = setup();
  const project = parseLinkProject({ ...createEmptyLinkProject('共用来源'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 1000, width: 1920, height: 1080 }],
    rundown: ['song', 'next'].map(id => ({ id, title: id, referenceMediaClips: [{ id: `${id}-clip`, assetId: 'video', label: '视频',
      startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1000 }] })) });
  const request = { ...t.request, snapshot: createObsProgramSnapshot(project, 'song', 1),
    nextFiles: { snapshot: createObsProgramSnapshot(project, 'next', 1), positionMs: 0 } };
  expect(await t.pool.prepareNext(request, () => undefined)).toBe(false);
  expect(t.create).not.toHaveBeenCalled();
  // A manually selected OBS scene can display that material without a clip
  // reference in the current song. It still owns the visible source.
  request.snapshot.assets = []; request.snapshot.item.referenceMediaClips = [];
  request.snapshot.item.cues = [{ id: 'manual-scene', name: '素材场景', enabled: true, notes: '',
    timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'scene', label: '显示素材',
      kind: 'obs.setProgramScene', sceneName: materialSceneNames(project.projectId, project.mediaAssets[0]!).sceneName }] }];
  expect(await t.pool.prepareNext(request, () => undefined)).toBe(false);
  expect(t.create).not.toHaveBeenCalled();
});

it('同一歌曲的循环预备不能在活动期间重写其叠加场景', async () => {
  const t = setup();
  expect(await t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.request.snapshot, positionMs: 0 } }, () => undefined)).toBe(false);
  expect(t.create).not.toHaveBeenCalled();
});

it('停止本轮时取消在途下一首预备并清理，旧选择取消不碰下一首', async () => {
  const t = setup(); let finish: () => void = () => { throw new Error('尚未开始'); };
  vi.mocked(t.outputs.preloadResources).mockImplementation(async current => {
    await new Promise<void>(resolve => { finish = resolve; }); current();
  });
  const next = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'next' } }, positionMs: 0 };
  const job = t.pool.prepareNext({ ...t.request, nextFiles: next }, () => undefined);
  const rejected = expect(job).rejects.toThrow('取消');
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  await t.pool.cancel(t.stop); await t.pool.cancelNext(crypto.randomUUID());
  expect(t.outputs.releaseOutputs).not.toHaveBeenCalled();
  const stopping = t.pool.cancelNext(t.request.sessionId); finish(); await stopping; await rejected;
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1);
});

it('播放代数不污染选择预备代数，重新选歌先清理下一首', async () => {
  const t = setup();
  const next = { snapshot: { ...t.request.snapshot, item: { ...t.request.snapshot.item, id: 'next' } }, positionMs: 0 };
  await t.pool.prepareNext({ ...t.request, generation: 100, nextFiles: next }, () => undefined);
  await t.pool.preload({ ...t.request, generation: 2 });
  expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.authorize).toHaveBeenCalledTimes(1);
  expect(t.create).toHaveBeenCalledTimes(2);
});

it('窗口的预备请求在文件检查拒绝时不创建画面资源', async () => {
  const t = setup();
  await expect(t.pool.preload(t.request, () => Promise.reject(new Error('只能访问当前打开的工程')))).rejects.toThrow('当前打开的工程');
  expect(t.create).not.toHaveBeenCalled();
});

it('下一首后台预备失败、它的清理也失败：报出预备本身的原因，清理失败另报一次，之后每首歌照常准备画面（2026-11-09）', async () => {
  const t = setup();
  vi.mocked(t.outputs.preloadResources).mockRejectedValueOnce(new Error('OBS 读取目录 请求排队超时（2000 ms）；还没发送'));
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：OBS 停止 请求排队超时（2000 ms）；还没发送'));
  await expect(t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined)).rejects.toThrow('OBS 读取目录 请求排队超时');
  // The reason says it once, without repeating that the picture was not cleaned up.
  expect(t.report.mock.calls).toEqual([[{ log: '提前准备的画面没有清理干净，不影响播放。原因：OBS 停止 请求排队超时（2000 ms）；还没发送', shown: '提前准备的画面没有清理干净，不影响播放。原因：OBS 停止 请求排队超时（2000 ms）；还没发送' }]]);
  for (const [id, generation] of [['B', 3], ['C', 4], ['D', 5]] as const) {
    expect(await t.pool.take({ ...t.request, generation, snapshot: t.song(id) }, 0, () => undefined)).toBe(t.outputs);
  }
  await expect(t.pool.prepareNext({ ...t.request, generation: 5, snapshot: t.song('D'), nextFiles: { snapshot: t.song('E'), positionMs: 0 } }, () => undefined)).resolves.toBe(true);
  await expect(t.pool.cancelNext(t.request.sessionId)).resolves.toBeUndefined();
  await expect(t.pool.close()).resolves.toBeUndefined();
  expect(t.create).toHaveBeenCalledTimes(5); expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(2); expect(t.report).toHaveBeenCalledOnce();
});

it('OBS 断开时清理已预热的下一首失败：失败只交给关闭的一方，重新连上后每首歌照常准备画面', async () => {
  const t = setup();
  await t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined);
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：素材场景还没准备好，请重新做开播前检查：B开场.mp4'));
  await expect(t.pool.close()).rejects.toThrow('素材场景还没准备好');
  for (const [id, generation] of [['B', 3], ['C', 4]] as const) {
    expect(await t.pool.take({ ...t.request, generation, snapshot: t.song(id) }, 0, () => undefined)).toBe(t.outputs);
  }
  await expect(t.pool.preload({ ...t.request, generation: 5, snapshot: t.song('D') })).resolves.toBeUndefined();
  await expect(t.pool.close()).resolves.toBeUndefined();
  await expect(t.pool.close()).resolves.toBeUndefined();
  expect(t.create).toHaveBeenCalledTimes(4); expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(2); expect(t.report).not.toHaveBeenCalled();
});

// 修复前：节目停止或关闭时，清理选中歌曲提前准备的画面失败，取消就跟着失败：关闭节目也算失败，之后再也开不了节目、
// 退不出软件。
it('取消选中歌曲提前准备的画面时清理失败：报一次“不影响播放”，取消照常完成，之后照常预备和接管', async () => {
  const t = setup(); await t.pool.preload(t.request);
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：Error: OBS 无响应'));
  await expect(t.pool.cancel(t.stop)).resolves.toBeUndefined();
  const text = '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应';
  expect(t.report.mock.calls).toEqual([[{ log: text, shown: text }]]);
  await expect(t.pool.preload({ ...t.request, generation: 2 })).resolves.toBeUndefined();
  expect(await t.pool.take({ ...t.request, generation: 3 }, 500, () => undefined)).toBe(t.outputs);
  await expect(t.pool.close()).resolves.toBeUndefined();
  expect(t.create).toHaveBeenCalledTimes(2); expect(t.report).toHaveBeenCalledOnce();
});

it('这首歌接手的预备失败、清理也失败：这首照常重新准备画面，预备和清理的失败各报一次', async () => {
  const t = setup(); let fail: (error: Error) => void = () => { throw new Error('尚未开始'); };
  vi.mocked(t.outputs.preloadResources).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const job = t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined);
  const handed = expect(job).rejects.toBeInstanceOf(ObsPreparationCancelled);
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  const taking = t.pool.take({ ...t.request, generation: 3, snapshot: t.song('B') }, 0, () => undefined);
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：Error: OBS 停止 请求排队超时（2000 ms）；还没发送'));
  fail(new Error('OBS 预热素材静音 请求排队超时（2000 ms）；还没发送'));
  expect(await taking).toBe(t.outputs); await handed;
  expect(t.create).toHaveBeenCalledTimes(2); expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1);
  expect(t.report.mock.calls).toEqual([[{ log: '提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送', shown: '提前准备的画面没能用上，已改为重新准备。原因：OBS 预热素材静音 请求排队超时（2000 ms）；还没发送' }],
    [{ log: '提前准备的画面没有清理干净，不影响播放。原因：OBS 停止 请求排队超时（2000 ms）；还没发送', shown: '提前准备的画面没有清理干净，不影响播放。原因：OBS 停止 请求排队超时（2000 ms）；还没发送' }]]);
});

it('报告的失败：运行日志里留着 OBS 的原话和来源名，界面上是看得懂的说法（2026-11-09）', async () => {
  const t = setup(); let fail: (error: Error) => void = () => { throw new Error('尚未开始'); };
  vi.mocked(t.outputs.preloadResources).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const job = t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined);
  const handed = expect(job).rejects.toBeInstanceOf(ObsPreparationCancelled);
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  const taking = t.pool.take({ ...t.request, generation: 3, snapshot: t.song('B') }, 0, () => undefined);
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：Error: SetInputSettings：No source was found by the name of `团播联动台·素材·B`.'));
  fail(new Error('GetSceneItemId：No scene was found by the name of `团播联动台·素材·B`.'));
  expect(await taking).toBe(t.outputs); await handed;
  // Named, so the log and the red text cannot change places on the way to the picture host (2026-11-09). A cleanup
  // that failed is not a preparation that failed: its red text says what went wrong, without advice about preparing.
  expect(t.report.mock.calls).toEqual([
    [{ log: '提前准备的画面没能用上，已改为重新准备。原因：GetSceneItemId：No scene was found by the name of `团播联动台·素材·B`.',
      shown: '提前准备的画面没能用上，已改为重新准备。原因：OBS 中找不到需要的场景或来源。请重新同步素材后再播放。' }],
    [{ log: '提前准备的画面没有清理干净，不影响播放。原因：SetInputSettings：No source was found by the name of `团播联动台·素材·B`.',
      shown: '提前准备的画面没有清理干净，不影响播放。原因：OBS 中找不到需要的场景或来源' }]]);
});

it('接手预备的歌被取消：预备按取消结束，不当成失败报告；只清理一次，这首歌也不再准备', async () => {
  const t = setup(); let finish: () => void = () => { throw new Error('尚未开始'); };
  vi.mocked(t.outputs.preloadResources).mockImplementationOnce(async current => { await new Promise<void>(resolve => { finish = resolve; }); current(); });
  const job = t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined);
  const cancelled = expect(job).rejects.toBeInstanceOf(ObsPreparationCancelled);
  await vi.waitFor(() => expect(t.outputs.preloadResources).toHaveBeenCalled());
  let owner = true;
  const taking = expect(t.pool.take({ ...t.request, generation: 3, snapshot: t.song('B') }, 0, () => { if (!owner) throw new Error('画面资源交接已取消'); }))
    .rejects.toThrow('画面资源交接已取消');
  owner = false; finish(); await cancelled; await taking;
  expect(t.report).not.toHaveBeenCalled(); expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.create).toHaveBeenCalledTimes(1);
});

it('重新选歌时上一份预备清理失败：新的选择照常预备，清理失败只报一次', async () => {
  const t = setup(); await t.pool.preload(t.request);
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：OBS 无响应'));
  await expect(t.pool.preload({ ...t.request, generation: 2, snapshot: t.song('B') })).resolves.toBeUndefined();
  expect(t.create).toHaveBeenCalledTimes(2);
  expect(t.report.mock.calls).toEqual([[{ log: '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应', shown: '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应' }]]);
});

it('开另一首歌时清理别的预备失败：这首照常准备画面，清理失败只报一次', async () => {
  const t = setup();
  await t.pool.prepareNext({ ...t.request, nextFiles: { snapshot: t.song('B'), positionMs: 0 } }, () => undefined);
  vi.mocked(t.outputs.releaseOutputs).mockRejectedValueOnce(new Error('画面没有清理干净：OBS 无响应'));
  expect(await t.pool.take({ ...t.request, generation: 3, snapshot: t.song('C') }, 0, () => undefined)).toBe(t.outputs);
  expect(t.create).toHaveBeenCalledTimes(2);
  expect(t.report.mock.calls).toEqual([[{ log: '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应', shown: '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应' }]]);
});

it('选择预备在开歌前就失败：失败已经交给选歌的一方，开歌接手时不再重复报告', async () => {
  const t = setup();
  vi.mocked(t.outputs.preloadResources).mockRejectedValueOnce(new Error('素材文件读不了'));
  await expect(t.pool.preload(t.request)).rejects.toThrow('素材文件读不了');
  expect(await t.pool.take({ ...t.request, generation: 3 }, 500, () => undefined)).toBe(t.outputs);
  expect(t.create).toHaveBeenCalledTimes(2); expect(t.outputs.releaseOutputs).toHaveBeenCalledTimes(1); expect(t.report).not.toHaveBeenCalled();
});
