import { expect, it } from 'vitest';
import { noticeText, showMainProcessErrors } from './notice-text';

// 修复前：窗口把主进程发来的红字再过一遍 toUserErrorMessage，歌名「HAPPY」被当成技术报错，整句前面多了“操作未能完成：”。
it('主进程写好的红字按原样显示，歌名里的大写字母不让它变成技术报错；别处的技术报错照旧换成日常说法', () => {
  const written = '「HAPPY」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。请在控台上关掉这首歌的执行器。';
  expect(noticeText(written, 'error', true)).toBe(written);
  expect(noticeText("EPERM: operation not permitted, open 'C:\\TBLINK\\cache.bin'", 'error', false))
    .toBe('没有权限完成这个操作。请检查文件权限，或杀毒软件是否拦截。');
  expect(noticeText('工程已保存', 'info', false)).toBe('工程已保存');
});

// 修复前：LinkApp 自己写着 notify(message, 'error', undefined, true)，最后的 true 换成 false 也没有测试发现：原因里留着
// 认不出的英文原文时，主进程写好的红字又被当成技术报错，前面多了“操作未能完成：”。
it('主进程错误通道发来的红字，窗口按原样标红显示', () => {
  const listeners: ((message: string) => void)[] = [];
  const unsubscribe = (): void => { listeners.length = 0; };
  const shown: { text: string; tone: 'info' | 'error' }[] = [];
  // What LinkApp's notify puts on screen.
  const notify = (message: string, tone: 'info' | 'error' = 'info', _key?: string, written = false): void => { shown.push({ text: noticeText(message, tone, written), tone }); };
  const stop = showMainProcessErrors(listener => { listeners.push(listener); return unsubscribe; }, notify);
  const written = '「HAPPY」的灯光没能完全关闭，控台上可能还亮着。原因：Exception in native module。请在控台上关掉这首歌的执行器。';
  // A text the window would change if it put it into everyday words again.
  expect(noticeText(written, 'error', false)).not.toBe(written);
  for (const listener of listeners) listener(written);
  expect(shown).toEqual([{ text: written, tone: 'error' }]);
  expect(stop).toBe(unsubscribe);
});
