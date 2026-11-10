import { expect, it, vi } from 'vitest';
import { closedProgramFaultReporter, mainProcessErrorReporter, programLightsQuitPrompt } from './main-process-errors';
import type { LinkLogInput } from './run-logger';

it('主进程未捕获的错误记录原文和调用栈并通知界面，日志写入失败也不吞掉通知', async () => {
  const record = vi.fn<(message: string, details: { stack?: string }) => Promise<unknown>>(() => Promise.resolve());
  const notify = vi.fn<(message: string) => void>();
  const report = mainProcessErrorReporter(record, notify);
  const error = new Error('读取 OBS 状态失败');
  report('未捕获的异常', error);
  expect(record).toHaveBeenCalledWith('主进程未捕获的异常：读取 OBS 状态失败', { stack: error.stack });
  expect(notify).toHaveBeenCalledWith('主进程未捕获的异常：读取 OBS 状态失败');
  record.mockRejectedValueOnce(new Error('磁盘已满'));
  const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
  report('未处理的异步错误', 'MIDI 端口已关闭');
  await vi.waitFor(() => expect(console).toHaveBeenCalledWith('主进程错误未能写入日志', expect.any(Error), 'MIDI 端口已关闭'));
  expect(notify).toHaveBeenLastCalledWith('主进程未处理的异步错误：MIDI 端口已关闭');
  console.mockRestore();
});

// 窗口按原样显示主进程发来的话（LinkApp），所以技术报错在这里先换成操作员看得懂的话；日志里留原文。
it('主进程未捕获的技术报错：日志记原文，发给窗口的是换成日常说法的一句', () => {
  const record = vi.fn<(message: string, details: { stack?: string }) => Promise<unknown>>(() => Promise.resolve());
  const notify = vi.fn<(message: string) => void>();
  mainProcessErrorReporter(record, notify)('未处理的异步错误', new Error("EPERM: operation not permitted, open 'C:\\TBLINK\\cache.bin'"));
  expect(record).toHaveBeenCalledWith("主进程未处理的异步错误：EPERM: operation not permitted, open 'C:\\TBLINK\\cache.bin'", expect.any(Object));
  expect(notify).toHaveBeenCalledExactlyOnceWith('没有权限完成这个操作。请检查文件权限，或杀毒软件是否拦截。');
});

const message = '「开场」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。请在控台上关掉这首歌的执行器。';
function reporter() {
  const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  const toWindow = vi.fn<(channel: 'link:main-process-error', message: string) => void>();
  return { record, toWindow, faults: closedProgramFaultReporter(record, toWindow) };
}

// 窗口在 link:main-process-error 上收到的消息由 LinkApp 按原样标红显示。
it('后台节目关闭后才失败的事（补发的关灯）按错误记录并发到窗口标红；日志写不进去也照样显示', async () => {
  const { record, toWindow, faults } = reporter();
  faults.windowOpened();
  faults.report(message, { projectId: 'project', itemId: 'song' });
  expect(record).toHaveBeenCalledWith({ level: 'error', category: 'state', device: '播放器', projectId: 'project', itemId: 'song', message, result: 'failed' });
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', message);
  record.mockRejectedValueOnce(new Error('磁盘已满'));
  const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
  faults.report(message, { projectId: 'project', itemId: null });
  expect(record).toHaveBeenLastCalledWith({ level: 'error', category: 'state', device: '播放器', projectId: 'project', message, result: 'failed' });
  await vi.waitFor(() => expect(console).toHaveBeenCalledWith('后台节目的错误未能写入日志', expect.any(Error), message));
  expect(toWindow).toHaveBeenCalledTimes(2);
  expect(toWindow).toHaveBeenLastCalledWith('link:main-process-error', message);
  console.mockRestore();
});

// 修复前：界面进程退出、自动重新加载的那几秒里发出的红字没有窗口接着，新窗口什么也看不到。
it('没有窗口能显示时（界面进程退出、还没重新加载好），失败马上按错误记录，红字留给下一个打开节目的窗口，只显示一次', () => {
  const { record, toWindow, faults } = reporter();
  faults.report(message, { projectId: 'project', itemId: 'song' });
  expect(record).toHaveBeenCalledOnce(); expect(toWindow).not.toHaveBeenCalled();
  faults.windowOpened();
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', message);
  faults.windowExited();
  const other = '「返场」的灯光没能完全关闭，控台上可能还亮着。原因：控台连接变了。请在控台上关掉这首歌的执行器。';
  faults.report(other, { projectId: 'project', itemId: 'encore' });
  expect(toWindow).toHaveBeenCalledOnce();
  faults.windowOpened(); faults.windowOpened();
  expect(toWindow.mock.calls).toEqual([['link:main-process-error', message], ['link:main-process-error', other]]);
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls.map(([entry]) => entry.level)).toEqual(['error', 'error']);
});

// 修复前：画面、提前准备的画面或独立监听在节目之后没关掉，整个关闭算失败，之后再也开不了节目、退不出软件；
// 现在只说一次，和节目的失败一样记录、标红。
it('节目之后关掉的画面或独立监听没关掉：按给的记录写一次错误，红字和节目的失败一样只显示一次，没有窗口时留给下一个窗口', () => {
  const { record, toWindow, faults } = reporter();
  const shown = '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应';
  const log = { level: 'error' as const, category: 'device' as const, device: '后台画面', message: '提前准备的画面没有清理干净，不影响播放。原因：OBS 无响应（GetSceneItemList）', result: 'failed' as const };
  faults.closeFailed(shown, log);
  expect(record).toHaveBeenCalledExactlyOnceWith(log); expect(toWindow).not.toHaveBeenCalled();
  faults.windowOpened();
  expect(toWindow).toHaveBeenCalledExactlyOnceWith('link:main-process-error', shown);
  // The monitor logs its own failure: nothing more is logged for it.
  faults.closeFailed('独立监听没能完全关掉，不影响之后播放。原因：监听进程没有退出', null);
  expect(record).toHaveBeenCalledOnce();
  expect(toWindow).toHaveBeenLastCalledWith('link:main-process-error', '独立监听没能完全关掉，不影响之后播放。原因：监听进程没有退出');
});

// 修复前：退出时节目补发的关灯没发出去，只在马上要关掉的窗口里闪一下红字，软件就退出了，控台上的灯还亮着。
it('退出时关节目这段里没关掉的灯光：照常记录、标红，另外交给退出流程去问操作员；别的时候报的不算', async () => {
  const { record, toWindow, faults } = reporter();
  faults.windowOpened();
  faults.report('「串场」的灯光没能完全关闭，控台上可能还亮着。原因：控台连接变了。请在控台上关掉这首歌的执行器。', { projectId: 'project', itemId: 'interlude' });
  const collected = await faults.collect(() => { faults.report(message, { projectId: 'project', itemId: 'song' }); return Promise.resolve(); });
  expect(collected).toEqual([message]);
  expect(record).toHaveBeenCalledTimes(2); expect(toWindow).toHaveBeenLastCalledWith('link:main-process-error', message);
  faults.closeFailed('画面没有清理干净，不影响之后播放。原因：OBS 无响应。请检查 OBS 节目画面上是否还留着刚才的素材', null);
  await expect(faults.collect(() => Promise.reject(new Error('音频引擎没有响应')))).rejects.toThrow('音频引擎没有响应');
  expect(await faults.collect(() => Promise.resolve())).toEqual([]);
});

// 和退出前停不掉灯光试听时一样问（2026-10-19 定的：返回软件 / 仍然退出），说的是哪首歌、为什么、怎么办。
it('退出时节目的灯光没关掉：和灯光试听停不掉时一样问返回软件还是仍然退出，默认返回软件，写上这首歌的那句话', () => {
  expect(programLightsQuitPrompt([message])).toEqual({ type: 'warning', title: '灯光没能关闭', message: '退出前没能关掉这首歌的灯光。',
    detail: `${message}\n\n如果仍然退出，控台上可能还保持着当前的灯光，请到控台手动处理。`, buttons: ['返回软件', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true });
  const other = '「返场」的灯光没能完全关闭，控台上可能还亮着。原因：控台连接变了。请在控台上关掉这首歌的执行器。';
  expect(programLightsQuitPrompt([message, other])).toMatchObject({ message: '退出前没能关掉这几首歌的灯光。',
    detail: `${message}\n${other}\n\n如果仍然退出，控台上可能还保持着当前的灯光，请到控台手动处理。` });
});
