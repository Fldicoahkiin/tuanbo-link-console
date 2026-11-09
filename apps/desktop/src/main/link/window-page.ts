import type { LinkLogInput } from './run-logger';

/** The page in the main window, as main follows it: the window's WebContents. */
export type WindowPage = {
  getURL(): string;
  on(event: 'will-navigate', listener: (navigation: { url: string; preventDefault(): void }) => void): unknown;
  on(event: 'did-navigate' | 'render-process-gone', listener: () => void): unknown;
};

/** What main holds for the page in the main window until the page is gone. */
export type WindowPageHoldings = {
  /** The MIDI ports the page opened (MidiPortBroker.releaseWindow). */
  releaseMidi(): Promise<void>;
  /** The saves main asked the page for (RendererSaveRequests.failAll): the next page never answers them. */
  failSaves(message: string): void;
  /** link-main's releaseGonePage, as when the renderer exits: a program that is preparing, playing or paused keeps
   * running and is returned, for the next page to take over when it opens the same project; otherwise the program, the
   * audio and picture outputs and the runtime close. */
  releaseProgram(): Promise<{ itemId: string | null; positionMs: number } | null>;
  record(entry: LinkLogInput): Promise<unknown>;
};

/** Follows the page in the main window (Electron's order: fixtures/window-page-events.ts).
 * - The page may reload itself: the error screen's 重新进入工作区 calls location.reload(). Every other navigation the
 *   page starts (a link, a file dropped on the window) is blocked, so the window only ever shows the app.
 * - What a page held is released once a new page replaced it (did-navigate, before the new page sends anything), as when
 *   its renderer exits: a program that plays on is kept for the new page. Not when a navigation starts: one that is then
 *   blocked starts too, while the page stays and still uses its MIDI ports and its program. The first page replaces
 *   none, and finds nothing to release.
 * - After the renderer exited, link-main's render-process-gone handler released what the page held; the page loaded
 *   after that has nothing of the old one to release. */
export function followWindowPage(page: WindowPage, holdings: WindowPageHoldings): void {
  let exited = false;
  page.on('will-navigate', navigation => { if (navigation.url !== page.getURL()) navigation.preventDefault(); });
  page.on('render-process-gone', () => { exited = true; });
  page.on('did-navigate', () => {
    if (exited) { exited = false; return; }
    void holdings.releaseMidi();
    // The page that reloads itself (the error screen) has put its unsaved edits into the recovery copy first.
    holdings.failSaves('界面重新加载了，这次没有保存。未保存的修改已存进恢复副本，下次打开工程时可以恢复');
    void holdings.releaseProgram().then(kept => kept ? holdings.record({ level: 'warning', category: 'state', device: '播放器',
      ...(kept.itemId ? { itemId: kept.itemId } : {}),
      message: `界面重新加载了，节目在后台继续播放（${Math.floor(kept.positionMs / 1000)} 秒），打开同一个工程就能接回控制` }) : undefined,
    // Logged here; what the next page then opens or plays is refused and says why.
    (error: unknown) => holdings.record({ level: 'error', category: 'state', device: '播放器',
      message: `界面重新加载了，上一页的节目、音频或画面没能关掉。原因：${error instanceof Error ? error.message : String(error)}`, result: 'failed' }))
      .catch((failure: unknown) => console.error('界面重新加载时的节目日志未能保存', failure));
  });
}
