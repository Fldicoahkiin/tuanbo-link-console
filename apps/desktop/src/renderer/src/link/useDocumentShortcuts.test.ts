import { expect, it } from 'vitest';
import { documentShortcut, runDocumentShortcut } from './useDocumentShortcuts';

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

it('Ctrl+Shift+S 另存为', () => {
  expect(documentShortcut(press('S', true), false)).toBe('save-as');
  expect(documentShortcut(press('s', true), true)).toBe('save-as');
});

it('播放中仍可保存；另存为会更换工程路径，播放中不执行；撤销重做只允许灯光步骤', () => {
  const calls: string[] = [];
  const actions = { save: () => { calls.push('save'); }, saveAs: () => { calls.push('save-as'); }, undo: () => { calls.push('undo'); }, redo: () => { calls.push('redo'); } };
  for (const action of ['save', 'save-as', 'undo', 'redo'] as const) runDocumentShortcut(action, true, { undoScope: 'visual', redoScope: 'lighting' }, actions);
  expect(calls).toEqual(['save', 'redo']);
  runDocumentShortcut('save-as', false, { undoScope: undefined, redoScope: undefined }, actions);
  expect(calls).toEqual(['save', 'redo', 'save-as']);
});
