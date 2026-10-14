import { expect, it } from 'vitest';
import { documentShortcut } from './useDocumentShortcuts';

const press = (key: string, shiftKey = false) => ({ ctrlKey: true, shiftKey, key });

it('文本框内 Ctrl+Z/Y 交给输入框自身撤销，Ctrl+S 仍保存工程', () => {
  expect(documentShortcut(press('z'), true)).toBeNull();
  expect(documentShortcut(press('y'), true)).toBeNull();
  expect(documentShortcut(press('Z', true), true)).toBeNull();
  expect(documentShortcut(press('s'), true)).toBe('save');
});

it('焦点不在文本框时 Ctrl+Z/Y/Shift+Z 操作工程撤销与重做', () => {
  expect(documentShortcut(press('z'), false)).toBe('undo');
  expect(documentShortcut(press('Z', true), false)).toBe('redo');
  expect(documentShortcut(press('y'), false)).toBe('redo');
  expect(documentShortcut({ ctrlKey: false, shiftKey: false, key: 'z' }, false)).toBeNull();
});
