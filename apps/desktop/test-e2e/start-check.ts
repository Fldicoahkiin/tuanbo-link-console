import type { ElectronApplication } from '@playwright/test';

/**
 * Records any start-check dialog. Since 2026-10-26 a song always plays with its timecode and the start
 * check only shows a warning, so the list must stay empty; a dialog that still appears is answered
 * with cancel, which makes the song fail to start and the regression visible. Other dialogs keep their behaviour.
 */
export async function recordStartCheckDialogs(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>;
    const reasons: string[] = [];
    Reflect.set(globalThis, '__startCheckReasons', reasons);
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1);
      if (typeof options === 'object' && options !== null && 'title' in options && options.title === '开播前检查') {
        reasons.push('detail' in options ? String(options.detail) : '');
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }
      return original(...args);
    };
  });
  return () => app.evaluate(() => [...(Reflect.get(globalThis, '__startCheckReasons') as string[])]);
}
