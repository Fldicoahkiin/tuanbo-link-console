import { expect, it } from 'vitest';
import { fieldDraft, shownDraft, type FieldDraft, type FieldDraftEvent } from './useFieldDraft';

const run = (...events: FieldDraftEvent[]): FieldDraft => events.reduce(fieldDraft, { editing: false } as FieldDraft);

it('没在编辑时显示工程里的值：在别处撤销后检查器显示新值', () => {
  const idle = run();
  expect(shownDraft(idle, '主歌')).toBe('主歌');
  // Undo elsewhere hands the inspector the old name; it shows at once, no remount needed.
  expect(shownDraft(idle, '前奏')).toBe('前奏');
  // Edited and left: the field shows whatever the project now holds.
  const left = run({ type: 'type', text: '副歌' }, { type: 'end' });
  expect(shownDraft(left, '副歌')).toBe('副歌');
  expect(shownDraft(left, '前奏')).toBe('前奏');
});

it('正在输入时，播放或别处的改动不打断输入', () => {
  const typing = run({ type: 'type', text: '13' });
  // The project's value moves on (playback, a command elsewhere): the typed text stays.
  expect(shownDraft(typing, '12.5')).toBe('13');
  expect(shownDraft(typing, '99')).toBe('13');
});

it('只是点进去、什么都没输：照样跟着工程里的值走，离开时没有旧值可以写回去', () => {
  // Nothing typed means no draft, whether the field has the focus or not: a value the console or an undo changed
  // meanwhile is what the field shows, so leaving it finds nothing to commit.
  const focused = run();
  expect(shownDraft(focused, '4')).toBe('4');
  expect(shownDraft(focused, '7')).toBe('7');
  const idle: FieldDraft = { editing: false };
  expect(fieldDraft(idle, { type: 'end' })).toBe(idle);
});
