import { describe, expect, it, vi } from 'vitest';
import { emptyInternalPlayerState, type InternalPlayerState } from '@tb/core/link';
import { followWindowPage } from './window-page';
import { appPage, windowPageEvents } from './fixtures/window-page-events';
import type { LinkLogInput } from './run-logger';

function holdings() {
  const releaseMidi = vi.fn(() => Promise.resolve());
  const releaseProgram = vi.fn<() => Promise<InternalPlayerState | null>>(() => Promise.resolve(null));
  const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
  const failSaves = vi.fn<(message: string) => void>();
  return { releaseMidi, failSaves, releaseProgram, record };
}
const savesFailed = '界面重新加载了，这次没有保存。未保存的修改已存进恢复副本，下次打开工程时可以恢复';

describe('主窗口换了一页，主进程才放开上一页占着的东西', () => {
  // 修复前：will-navigate 把页面自己的 location.reload() 也拦下了，错误画面上的“重新进入工作区”什么都不做，按钮一直灰着；
  // 主进程却在 did-start-navigation 里放开了这一页的 MIDI 接口。主进程等上一页回答的保存，新页面不会回答，所以也在这时
  // 放开，不然退出时的保存会一直等下去。
  it('页面自己重新加载（错误画面上的“重新进入工作区”）照常进行；新页面到了才放开上一页的 MIDI 接口、等它回答的保存和节目，各一次', async () => {
    const f = windowPageEvents(), held = holdings();
    followWindowPage(f.page, held);
    expect(f.reloadItself()).toBe(true);
    await vi.waitFor(() => expect(held.releaseProgram).toHaveBeenCalledOnce());
    expect(held.releaseMidi).toHaveBeenCalledOnce();
    expect(held.failSaves.mock.calls).toEqual([[savesFailed]]);
    expect(f.reloadItself()).toBe(true);
    await vi.waitFor(() => expect(held.releaseProgram).toHaveBeenCalledTimes(2));
    expect(held.releaseMidi).toHaveBeenCalledTimes(2);
    expect(held.failSaves).toHaveBeenCalledTimes(2);
    expect(held.record).not.toHaveBeenCalled();
  });

  // 修复前：did-start-navigation 在 will-navigate 拦下跳转之前就来了，拖一个文件进窗口也会悄悄关掉这一页的 MIDI 接口；
  // 在那里放开节目的话，页面还在，节目却被当成没有窗口在看，界面再也收不到它的状态。
  it('被拦下的跳转（拖进窗口的文件、页面里的链接）不放开任何东西：页面还在，MIDI 接口和节目照旧归它', async () => {
    const f = windowPageEvents(), held = holdings();
    followWindowPage(f.page, held);
    expect(f.navigate('file:///C:/Users/live/Desktop/song.mp3', 'page')).toBe(false);
    expect(f.navigate('https://example.com/', 'page')).toBe(false);
    await Promise.resolve();
    expect(f.page.getURL()).toBe(appPage);
    expect(held.releaseMidi).not.toHaveBeenCalled();
    expect(held.failSaves).not.toHaveBeenCalled();
    expect(held.releaseProgram).not.toHaveBeenCalled();
  });

  it('界面进程退出后由主进程重新加载：退出时 link-main 已经放开过，新页面到了不再放一次、不再记一条；之后页面自己重新加载照常放开', async () => {
    const f = windowPageEvents(), held = holdings();
    followWindowPage(f.page, held);
    f.exit();
    expect(f.reloadFromMain()).toBe(true);
    await Promise.resolve();
    expect(held.releaseMidi).not.toHaveBeenCalled();
    expect(held.failSaves).not.toHaveBeenCalled();
    expect(held.releaseProgram).not.toHaveBeenCalled();
    expect(f.reloadItself()).toBe(true);
    await vi.waitFor(() => expect(held.releaseProgram).toHaveBeenCalledOnce());
    expect(held.releaseMidi).toHaveBeenCalledOnce();
    expect(held.failSaves).toHaveBeenCalledOnce();
    expect(held.record).not.toHaveBeenCalled();
  });

  it('节目在后台继续播放时记一条提醒；放不开时按错误记下原因', async () => {
    const f = windowPageEvents(), held = holdings();
    followWindowPage(f.page, held);
    held.releaseProgram.mockResolvedValueOnce({ ...emptyInternalPlayerState, itemId: 'song', status: 'playing', positionMs: 65_400 });
    f.reloadItself();
    await vi.waitFor(() => expect(held.record).toHaveBeenCalledOnce());
    expect(held.record).toHaveBeenCalledWith({ level: 'warning', category: 'state', device: '播放器', itemId: 'song',
      message: '界面重新加载了，节目在后台继续播放（65 秒），打开同一个工程就能接回控制' });
    held.releaseProgram.mockRejectedValueOnce(new Error('音频或画面没能完全关闭，请查看运行日志'));
    f.reloadItself();
    await vi.waitFor(() => expect(held.record).toHaveBeenCalledTimes(2));
    expect(held.record).toHaveBeenLastCalledWith({ level: 'error', category: 'state', device: '播放器',
      message: '界面重新加载了，上一页的节目、音频或画面没能关掉。原因：音频或画面没能完全关闭，请查看运行日志', result: 'failed' });
  });
});
