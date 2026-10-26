import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativeObsPreload } from '@tb/schema';
import { createObsProgramSnapshot, materialSceneNames } from '@tb/core/link';
import { NativeObsPreloadPool } from './native-obs-preload';
import { ObsPreparationCancelled, type NativeObsOutputs } from './native-obs-outputs';

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
  const authorize = vi.fn(() => Promise.resolve()), create = vi.fn(() => outputs);
  const pool = new NativeObsPreloadPool({ authorize, create });
  const stop = { version: request.version, sessionId: request.sessionId, generation: request.generation };
  return { request, stop, outputs, execute, authorize, create, pool };
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
