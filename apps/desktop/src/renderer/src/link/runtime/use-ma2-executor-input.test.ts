import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Ma2ExecutorInput, Ma2ExecutorPage } from '@tb/schema';
import { createMa2ExecutorInput } from './use-ma2-executor-input';
import { currentMa2LayoutScope, ma2LayoutConnection } from '../stores/ma2-layout-store';

vi.mock('../stores/ma2-layout-store', () => ({ currentMa2LayoutScope: vi.fn(), ma2LayoutConnection: vi.fn() }));
const connection = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'Test', generation: 'session', version: '3.7.0.5' } };
const flash: Ma2ExecutorPage['items'][number] = { slot: 101, width: 1, name: '面光', kind: 'sequence', sequence: 9000, button: 12302, buttons: [12302], reference: ['25', '1', '9000'] };
const input = vi.fn<(request: Ma2ExecutorInput) => Promise<void>>();
const releaseAll = vi.fn<() => Promise<void>>();
const error = vi.fn<(message: string) => void>();
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Uninitialized promise'); };
  let reject: (reason: Error) => void = () => { throw new Error('Uninitialized promise'); };
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(currentMa2LayoutScope).mockReturnValue('scope-a');
  vi.mocked(ma2LayoutConnection).mockResolvedValue(connection);
  input.mockResolvedValue(undefined); releaseAll.mockResolvedValue(undefined);
  vi.stubGlobal('window', { tbLink: { inputMa2Executor: input, releaseMa2Executors: releaseAll } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('连接尚未返回就松开时不会迟到点亮，也可以立即再次按下', async () => {
  const pending = deferred<typeof connection>(); vi.mocked(ma2LayoutConnection).mockReturnValueOnce(pending.promise);
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); controller.release(flash, 1000, 0);
  controller.press(flash, 1000, 0); await flush();
  expect(input).toHaveBeenCalledTimes(1);
  const newSession = input.mock.calls[0]![0].sessionId;
  pending.resolve(connection); await flush();
  expect(input).toHaveBeenCalledTimes(1);
  controller.release(flash, 1000, 0); await flush();
  expect(input.mock.calls[1]![0]).toMatchObject({ pressed: false, sessionId: newSession });
});
it('按下回包尚未返回时松开立即发释放，旧完成回调不能抹掉新按住会话', async () => {
  const first = deferred<void>(); input.mockImplementationOnce(() => first.promise);
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); await flush();
  const oldSession = input.mock.calls[0]![0].sessionId;
  controller.release(flash, 1000, 0);
  expect(input.mock.calls[1]![0]).toMatchObject({ pressed: false, sessionId: oldSession });
  controller.press(flash, 1000, 0); await flush();
  const newSession = input.mock.calls[2]![0].sessionId;
  expect(newSession).not.toBe(oldSession);
  first.resolve(); await flush(); await vi.advanceTimersByTimeAsync(500);
  expect(input.mock.calls.filter(([request]) => request.pressed && request.sessionId === oldSession)).toHaveLength(1);
  expect(input.mock.calls.filter(([request]) => request.pressed && request.sessionId === newSession)).toHaveLength(2);
  controller.releaseAll(); await flush();
});
it('同一按住只续租且不重叠，松开后清除续租定时器', async () => {
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); controller.press(flash, 1000, 0); await flush();
  const renew = deferred<void>(); input.mockImplementationOnce(() => renew.promise);
  await vi.advanceTimersByTimeAsync(1500);
  expect(input).toHaveBeenCalledTimes(2);
  controller.release(flash, 1000, 0);
  expect(input.mock.calls[2]![0].pressed).toBe(false);
  renew.resolve(); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(input).toHaveBeenCalledTimes(3);
  expect(new Set(input.mock.calls.map(([request]) => request.sessionId)).size).toBe(1);
});
it.each(['Go', 'Toggle'])('连续 %s 点击各自触发一次，不会被尚未回包的同格点击吞掉', async name => {
  const code = name === 'Go' ? 12299 : 12307;
  const item = { ...flash, name, button: code, buttons: [code] };
  const first = deferred<void>(); input.mockImplementationOnce(() => first.promise);
  const controller = createMa2ExecutorInput(error);
  controller.press(item, 1000, 0); controller.press(item, 1000, 0); await flush();
  const presses = input.mock.calls.filter(([request]) => request.pressed);
  expect(presses).toHaveLength(2);
  expect(presses[0]![0].sessionId).not.toBe(presses[1]![0].sessionId);
  first.resolve(); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(input.mock.calls.filter(([request]) => request.pressed)).toHaveLength(2);
  expect(input.mock.calls.filter(([request]) => !request.pressed)).toHaveLength(2);
});
it('回包前工程改变时只释放旧会话，不为新工程续租', async () => {
  const pending = deferred<void>(); input.mockImplementationOnce(() => pending.promise);
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); await flush();
  vi.mocked(currentMa2LayoutScope).mockReturnValue('scope-b');
  pending.resolve(); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(input.mock.calls.map(([request]) => request.pressed)).toEqual([true, false]);
});
it('未经过组件重渲染的来源改变也会在续租前释放', async () => {
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); await flush();
  vi.mocked(currentMa2LayoutScope).mockReturnValue('scope-b');
  await vi.advanceTimersByTimeAsync(500);
  expect(input.mock.calls.map(([request]) => request.pressed)).toEqual([true, false]);
});
it('按下回包丢失时报告错误并立即请求释放，不重试按下', async () => {
  input.mockRejectedValueOnce(new Error('lost receipt'));
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(input.mock.calls.map(([request]) => request.pressed)).toEqual([true, false]);
  expect(error).toHaveBeenCalledWith('lost receipt');
});
it('失焦释放全部，包括尚未建立连接的按下；迟到连接不会重开灯', async () => {
  const pending = deferred<typeof connection>(); vi.mocked(ma2LayoutConnection).mockReturnValueOnce(pending.promise);
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); controller.releaseAll();
  expect(releaseAll).toHaveBeenCalledTimes(1);
  pending.resolve(connection); await flush(); await vi.advanceTimersByTimeAsync(1000);
  expect(input).not.toHaveBeenCalled();
});
it('失焦期间已排队的续租取消不会报错误或重新建立旧定时器', async () => {
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); await flush();
  const renew = deferred<void>(); input.mockImplementationOnce(() => renew.promise);
  await vi.advanceTimersByTimeAsync(500);
  controller.releaseAll(); await flush();
  renew.reject(new Error('按键已松开，已取消排队的按下')); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(input.mock.calls.map(([request]) => request.pressed)).toEqual([true, true, false]);
  expect(error).not.toHaveBeenCalled();
});
it('等待连接超过点击期限时不补发', async () => {
  const pending = deferred<typeof connection>(); vi.mocked(ma2LayoutConnection).mockReturnValueOnce(pending.promise);
  const controller = createMa2ExecutorInput(error);
  controller.press(flash, 1000, 0); await vi.advanceTimersByTimeAsync(1300);
  pending.resolve(connection); await flush();
  expect(input).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith(expect.stringContaining('已过期'));
});
