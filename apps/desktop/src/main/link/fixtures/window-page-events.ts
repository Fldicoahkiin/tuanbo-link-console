import { EventEmitter } from 'node:events';
import type { WindowPage } from '../window-page';

export const appPage = 'file:///C:/TBLINK/resources/app.asar/out/renderer/index.html';

/** The main window's page, reporting navigations in the order Electron 39.8.10 does (the app's Electron, checked
 * 2026-11-09 in a window with link-main's earlier listener, which prevented every will-navigate):
 * - every main-frame navigation starts with did-start-navigation, also one that will-navigate then blocks;
 * - a navigation the page starts (window.location.reload(), a link, a file dropped on the window) asks will-navigate and
 *   goes on only if no listener prevents it; one that main starts (webContents.reload()) asks no will-navigate;
 * - did-navigate comes once the new page replaced the old one, before the new page sends anything to main.
 * Not a test of Electron: a record of what it did, for tests of what main does with it. */
export function windowPageEvents(url = appPage) {
  const events = new EventEmitter();
  let current = url;
  const page: WindowPage = {
    getURL: () => current,
    on(event: string, listener: (navigation: { url: string; preventDefault(): void }) => void) { events.on(event, listener); return page; }
  };
  /** Whether the navigation went through: a new page is there. */
  const navigate = (target: string, startedBy: 'page' | 'main'): boolean => {
    events.emit('did-start-navigation', { url: target, isMainFrame: true, isSameDocument: false });
    let prevented = false;
    if (startedBy === 'page') events.emit('will-navigate', { url: target, isMainFrame: true, preventDefault: () => { prevented = true; } });
    if (prevented) return false;
    current = target;
    events.emit('did-navigate', { preventDefault: () => undefined }, target, 200, 'OK');
    return true;
  };
  return { page, navigate,
    /** The error screen's 重新进入工作区: window.location.reload(). */
    reloadItself: () => navigate(current, 'page'),
    /** webContents.reload(), as link-main does after the renderer exited. */
    reloadFromMain: () => navigate(current, 'main'),
    /** The renderer exited (crashed or was killed); the page stays until main reloads it. */
    exit: () => { events.emit('render-process-gone', { preventDefault: () => undefined }, { reason: 'crashed', exitCode: 1 }); } };
}
