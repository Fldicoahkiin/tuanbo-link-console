import { expect, it } from 'vitest';
import { floatingMenuPlace } from './FloatingMenu';

const screen = { width: 1280, height: 800 };
const size = { width: 232, height: 300 };

it('菜单出现在鼠标位置；靠近窗口右边或下边时翻到鼠标另一侧，不出窗口', () => {
  expect(floatingMenuPlace({ x: 100, y: 100 }, size, screen)).toEqual({ left: 100, top: 100 });
  expect(floatingMenuPlace({ x: 1200, y: 100 }, size, screen)).toEqual({ left: 968, top: 100 });
  expect(floatingMenuPlace({ x: 100, y: 700 }, size, screen)).toEqual({ left: 100, top: 400 });
  // Too tall to fit on either side: kept inside the window.
  expect(floatingMenuPlace({ x: 100, y: 200 }, { width: 232, height: 700 }, screen)).toEqual({ left: 100, top: 8 });
});
