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

/** Edits are written to the .tblink only by an explicit save. */
export async function saveProject(page: Page): Promise<void> {
  await page.keyboard.press('Control+S');
  await expect(page.locator('.project-save-status')).toBeHidden();
}

/** Test teardown: unsaved edits are dropped, so quitting does not stop at 工程尚未保存. */
export async function closeDiscarding(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => Promise.all(BrowserWindow.getAllWindows().map(window => window.webContents.executeJavaScript(
    'window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })'))));
  await application.close();
}

/**
 * For polls on the saved .tblink: each attempt saves first when there are unsaved
 * edits, since results such as a console readback or an import land after the poll starts.
 */
export async function savedValue<T>(page: Page, read: () => Promise<T>): Promise<T> {
  const status = page.locator('.project-save-status');
  if (await status.isVisible()) {
    await page.keyboard.press('Control+S');
    await status.waitFor({ state: 'hidden', timeout: 5000 });
  }
  return read();
}
