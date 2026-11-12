import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativeObsStatus } from '@tb/schema';
import { createObsProgramSnapshot } from '@tb/core/link';
import { NativeObsRequests } from './native-obs-requests';

function setup() {
  const project = parseLinkProject({ ...createEmptyLinkProject('测试'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌曲' }] });
  const request = { version: 1 as const, sessionId: crypto.randomUUID(), generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, 'song', 0) };
  let release: () => void = () => { throw new Error('未初始化'); };
  const permission = new Promise<void>(resolve => { release = resolve; });
  const state: NativeObsStatus = { version: 1, sessionId: request.sessionId, generation: 1, itemId: 'song', revision: 0,
    state: 'ready', reason: null, nextCueId: null, currentCueId: null, pendingCount: 0, positionMs: 0 };
  const prepare = vi.fn(() => Promise.resolve(state)), stopOwned = vi.fn(() => Promise.resolve()), prepareNext = vi.fn(() => Promise.resolve());
  return { request, release, prepare, stopOwned, prepareNext, api: new NativeObsRequests({ prepare, stopOwned, prepareNext }, () => permission) };
}

it('许可返回前停止，迟到准备不派发；旧的取消也不能影响新代数', async () => {
  const test = setup(), stop = { version: 1 as const, sessionId: test.request.sessionId, generation: 1 };
  const pending = expect(test.api.prepare(test.request)).rejects.toThrow('排队时被取消');
  await test.api.stop(stop); test.release(); await pending;
  expect(test.prepare).not.toHaveBeenCalled(); expect(test.stopOwned).not.toHaveBeenCalled();
  await test.api.prepare({ ...test.request, generation: 2 });
  await expect(test.api.stop(stop)).rejects.toThrow('上一次准备'); expect(test.stopOwned).not.toHaveBeenCalled();
  await test.api.stop({ ...stop, generation: 2 }); expect(test.stopOwned).toHaveBeenCalledTimes(1);
});

it('重复准备拒绝，异步许可不能使先前歌曲盖过后来的歌曲', async () => {
  const test = setup(); const first = expect(test.api.prepare(test.request)).rejects.toThrow('排队时被取消');
  const newer = { ...test.request, generation: 2 }; const second = test.api.prepare(newer);
  await expect(test.api.prepare(newer)).rejects.toThrow('已过期'); test.release(); await first; await second;
  expect(test.prepare).toHaveBeenCalledExactlyOnceWith(newer);
});

it('窗口的准备请求在文件检查拒绝时不派发', async () => {
  const test = setup(); test.release();
  await expect(test.api.prepare(test.request, () => Promise.reject(new Error('只能访问当前打开的工程')))).rejects.toThrow('当前打开的工程');
  expect(test.prepare).not.toHaveBeenCalled();
  await test.api.prepare({ ...test.request, generation: 2 }, () => Promise.resolve());
  expect(test.prepare).toHaveBeenCalledTimes(1);
});

it('0.5.9 S8b：下一首的画面重新准备只认派发了的那次准备；排队中或停了就失效', async () => {
  const test = setup(), next = { version: 1 as const, sessionId: test.request.sessionId, generation: 1, nextFiles: null };
  const preparing = test.api.prepare(test.request);
  await expect(test.api.next(next)).rejects.toThrow('已过期');
  test.release(); await preparing;
  await test.api.next(next); expect(test.prepareNext).toHaveBeenCalledExactlyOnceWith(next);
  await expect(test.api.next({ ...next, generation: 2 })).rejects.toThrow('已过期');
  await test.api.stop({ version: 1, sessionId: test.request.sessionId, generation: 1 });
  await expect(test.api.next(next)).rejects.toThrow('已过期'); expect(test.prepareNext).toHaveBeenCalledTimes(1);
});
