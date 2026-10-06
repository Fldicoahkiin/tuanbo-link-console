import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativeObsPreload } from '@tb/schema';
import { createObsProgramSnapshot } from '@tb/core/link';
import { NativeObsPreloadPool } from './native-obs-preload';
import type { NativeObsOutputs } from './native-obs-outputs';

function setup() {
  const project = parseLinkProject({ ...createEmptyLinkProject('预备'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌曲' }] });
  const request: NativeObsPreload = { version: 1, sessionId: crypto.randomUUID(), generation: 1, projectPath: 'C:/show.tblink', preciseSeeking: true,
    positionMs: 500, snapshot: createObsProgramSnapshot(project, 'song', 1) };
  const execute = vi.fn(() => Promise.resolve());
  const outputs: NativeObsOutputs = {
    guardOutput: async (current, operation) => { if (!current()) throw new Error('已取消'); return operation(); },
    executor: { id: 'obs', supports: () => true, execute },
    now: () => performance.now(), preloadResources: vi.fn((current: () => void) => { current(); return Promise.resolve(); }), prepareOutputs: vi.fn(() => Promise.resolve()),
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

it('许可等待中取消不创建素材；新一代可以明确重新准备', async () => {
  const t = setup(); let permit: () => void = () => { throw new Error('未设置许可'); };
  t.authorize.mockImplementationOnce(() => new Promise<void>(resolve => { permit = resolve; }));
  const job = t.pool.preload(t.request); const rejected = expect(job).rejects.toThrow('取消');
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
