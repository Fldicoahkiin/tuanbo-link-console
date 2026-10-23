import type { ElectronApplication } from '@playwright/test';

/**
 * Answers the start check that asks before a song whose lighting cannot play:
 * "play without lighting" (or cancel) and records each reason shown. Other
 * dialogs keep their behaviour.
 */
export async function answerStartCheck(app: ElectronApplication, playWithoutLighting = true): Promise<() => Promise<string[]>> {
  await app.evaluate(({ dialog }, answer) => {
    const original = dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>;
    const reasons: string[] = [];
    Reflect.set(globalThis, '__startCheckReasons', reasons);
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1);
      if (typeof options === 'object' && options !== null && 'title' in options && options.title === '开播前检查') {
        reasons.push('detail' in options ? String(options.detail) : '');
        return Promise.resolve({ response: answer ? 0 : 1, checkboxChecked: false });
      }
      return original(...args);
    };
  }, playWithoutLighting);
  return () => app.evaluate(() => [...(Reflect.get(globalThis, '__startCheckReasons') as string[])]);
}
