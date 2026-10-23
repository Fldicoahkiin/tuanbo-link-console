import { expect, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Answers the explicit save model's two questions with their first button:
 * 选择工程保存位置 → 选择保存位置, 工程尚未保存 → 保存. Every other message box is untouched.
 * Pair with a stubbed showSaveDialog so the save has a destination.
 */
export async function answerSaveQuestions(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox.bind(dialog);
    Reflect.set(dialog, 'showMessageBox', (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string };
      if (options.title === '选择工程保存位置' || options.title === '工程尚未保存') return Promise.resolve({ response: 0, checkboxChecked: false });
      return Reflect.apply(original, dialog, args) as unknown;
    });
  });
}

/**
 * Edits are written to the .tblink only by an explicit save. Waits for this save's own
 * 工程已保存 notice, which shows on every page (the toolbar marker does not).
 */
export async function saveProject(page: Page): Promise<void> {
  await page.evaluate(() => { for (const toast of document.querySelectorAll('.toast')) toast.setAttribute('data-before-save', ''); });
  await page.keyboard.press('Control+S');
  await expect(page.locator('.toast.info:not([data-before-save])', { hasText: '工程已保存' }).first()).toBeVisible();
}

/**
 * Test teardown: playback still running is stopped and unsaved edits are dropped, so quitting does not
 * stop at 联动尚未停止 or 工程尚未保存. Without the stop the main process refuses to quit, the close waits
 * for the 60-second test timeout, and the report shows that timeout instead of the first failed assertion.
 */
export async function closeDiscarding(application: ElectronApplication): Promise<void> {
  // A window whose renderer exited has nothing to report; the main process already stopped asking for it.
  await application.evaluate(({ BrowserWindow }) => Promise.all(BrowserWindow.getAllWindows()
    .filter(window => !window.isDestroyed() && !window.webContents.isCrashed())
    .map(window => window.webContents.executeJavaScript(`(async () => {
      const state = await window.tbLink.getNativePlaybackStatus();
      if (state && ['preparing', 'playing', 'paused'].includes(state.status)) await window.tbLink.controlNativePlayback({ version: 1, sessionId: state.sessionId, generation: state.generation + 100, kind: 'stop' });
      await window.tbLink.setRuntimeActive(false);
      await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null });
    })()`))));
  await application.close();
}

/**
 * For polls on the saved .tblink: each attempt saves first, since results such as a
 * console readback or an import land after the poll starts.
 */
export async function savedValue<T>(page: Page, read: () => Promise<T>): Promise<T> {
  await saveProject(page);
  return read();
}
