import { expect, it } from 'vitest';
import { noticeText } from './notice-text';

// 修复前：窗口把主进程发来的红字再过一遍 toUserErrorMessage，歌名「HAPPY」被当成技术报错，整句前面多了“操作未能完成：”。
it('主进程写好的红字按原样显示，歌名里的大写字母不让它变成技术报错；别处的技术报错照旧换成日常说法', () => {
  const written = '「HAPPY」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。请在控台上关掉这首歌的执行器。';
  expect(noticeText(written, 'error', true)).toBe(written);
  expect(noticeText("EPERM: operation not permitted, open 'C:\\TBLINK\\cache.bin'", 'error', false))
    .toBe('没有权限完成这个操作。请检查文件权限，或杀毒软件是否拦截。');
  expect(noticeText('工程已保存', 'info', false)).toBe('工程已保存');
});
