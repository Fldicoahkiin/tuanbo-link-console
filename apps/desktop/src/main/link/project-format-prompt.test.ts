import { expect, it } from 'vitest';
import { olderFormatSavePrompt } from './project-format-prompt';

it('存成旧版本打不开的格式前问一次：先说结果，写明备份的名字和退回旧版本怎么办', () => {
  const prompt = olderFormatSavePrompt('演出（旧版本可打开的备份）.tblink');
  expect(prompt.message).toBe('保存后，0.5.8 和更早的版本打不开这个工程');
  expect(prompt.detail).toContain('这个工程的节拍换成了新的存法');
  expect(prompt.detail).toContain('「演出（旧版本可打开的备份）.tblink」');
  expect(prompt.detail).toContain('要退回旧版本时，打开那一份');
  expect(prompt.buttons).toEqual(['保存', '取消']);
  expect(prompt.buttons[prompt.cancelId]).toBe('取消');
});
