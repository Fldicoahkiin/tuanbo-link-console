import { expect, it } from 'vitest';
import { popoverPlace } from './Popover';

const screen = { width: 1280, height: 720 };

it('详细面板在按钮下方、右边对齐；靠近窗口左边时不出窗口，高度不超过窗口', () => {
  const button = { left: 900, top: 10, right: 964, bottom: 44 };
  expect(popoverPlace(button, { width: 360, height: 400 }, screen, 'below-end')).toEqual({ left: 604, top: 50, maxHeight: 662 });
  expect(popoverPlace({ left: 20, top: 10, right: 80, bottom: 44 }, { width: 360, height: 400 }, screen, 'below-end')).toEqual({ left: 8, top: 50, maxHeight: 662 });
});

it('同步详情在侧栏按钮右侧、底边对齐；太高时往下挪到窗口里，不超出窗口', () => {
  const button = { left: 16, top: 600, right: 236, bottom: 632 };
  expect(popoverPlace(button, { width: 320, height: 200 }, screen, 'right-end')).toEqual({ left: 242, top: 432, maxHeight: 704 });
  expect(popoverPlace({ left: 16, top: 60, right: 236, bottom: 92 }, { width: 320, height: 200 }, screen, 'right-end')).toEqual({ left: 242, top: 8, maxHeight: 704 });
  expect(popoverPlace(button, { width: 320, height: 900 }, screen, 'right-end')).toEqual({ left: 242, top: 8, maxHeight: 704 });
});
