import { expect, it } from 'vitest';
import { olderFormatSavePrompt } from './project-format-prompt';
import { projectDocumentResponseSchema } from './project-document-contract';

it('存成旧版本打不开的格式前问一次：先说结果，写明备份的名字和退回旧版本怎么办', () => {
  const prompt = olderFormatSavePrompt('演出（旧版本可打开的备份）.tblink', ['beats']);
  expect(prompt.message).toBe('保存后，0.5.8 和更早的版本打不开这个工程');
  expect(prompt.detail).toContain('这个工程的节拍换成了新的存法');
  expect(prompt.detail).toContain('「演出（旧版本可打开的备份）.tblink」');
  expect(prompt.detail).toContain('要退回旧版本时，打开那一份');
  expect(prompt.buttons).toEqual(['保存', '取消']);
  expect(prompt.buttons[prompt.cancelId]).toBe('取消');
});

it('按原因说：节拍、空白各一句，两样都有时都说，什么都没有时说一句总的（0.5.9 E13）', () => {
  const backup = '演出（旧版本可打开的备份）.tblink';
  const blank = olderFormatSavePrompt(backup, ['blank']).detail;
  expect(blank).toContain('这个工程里有歌在音乐后面留了空白，旧版本存不下。');
  expect(blank).not.toContain('节拍');
  const both = olderFormatSavePrompt(backup, ['beats', 'blank']).detail;
  expect(both.startsWith('这个工程的节拍换成了新的存法。这个工程里有歌在音乐后面留了空白，旧版本存不下。保存前')).toBe(true);
  const none = olderFormatSavePrompt(backup, []).detail;
  expect(none.startsWith('这个工程用到了新版本才有的存法。保存前')).toBe(true);
  for (const detail of [blank, both, none]) {
    expect(detail).toContain(`「${backup}」`);
    expect(detail).not.toMatch(/。。|schema|durationMs/);
  }
});

it('保存前的检查把原因从工程线程带回来：只认节拍和空白两种', () => {
  const checked = (olderFormat: unknown) => projectDocumentResponseSchema.safeParse({ version: 1, id: 1, kind: 'save-checked', olderFormat }).success;
  expect(checked({ backupName: 'a.tblink', reasons: ['beats', 'blank'] })).toBe(true);
  expect(checked({ backupName: 'a.tblink', reasons: [] })).toBe(true);
  expect(checked(null)).toBe(true);
  expect(checked({ backupName: 'a.tblink' })).toBe(false);
  expect(checked({ backupName: 'a.tblink', reasons: ['lighting'] })).toBe(false);
});
