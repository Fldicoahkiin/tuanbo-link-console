import { expect, it } from 'vitest';
import { cuePointEnter } from './cue-point-keys';

/** A key going down; `preventDefault` takes it from the browser and leaves a mark. */
function key(value: string, repeat = false) {
  const event = { key: value, repeat, taken: false, preventDefault: () => { event.taken = true; } };
  return event;
}

it('灯光工作台 Cue 点有焦点时按住 Enter：修改框只在第一下打开，重复的 Enter 被拿走、不再打开（0.5.9）', () => {
  const opened: string[] = [];
  const first = key('Enter'), repeats = [key('Enter', true), key('Enter', true), key('Enter', true)];
  for (const event of [first, ...repeats]) cuePointEnter(event, true, () => opened.push('修改框'));
  expect(opened).toEqual(['修改框']);
  expect([first, ...repeats].map(event => event.taken)).toEqual([true, true, true, true]);
  // Let go and pressed again: it opens again.
  cuePointEnter(key('Enter'), true, () => opened.push('修改框'));
  expect(opened).toEqual(['修改框', '修改框']);
});

it('Cue 点改不了（时间线只读、轨道锁定）时 Enter 不开修改框，也不拿走；别的键不归它管', () => {
  const opened: string[] = [];
  const locked = [key('Enter'), key('Enter', true)];
  for (const event of locked) cuePointEnter(event, false, () => opened.push('修改框'));
  const others = [key(' '), key('Escape'), key('Delete'), key('m', true)];
  for (const event of others) cuePointEnter(event, true, () => opened.push('修改框'));
  expect([...locked, ...others].map(event => event.taken)).toEqual([false, false, false, false, false, false]);
  expect(opened).toEqual([]);
});

// 修改框里按住的 Enter 重复时不当保存：K7 起由按键路由拿走（keys/key-routing-rules.test.ts「按住 Enter 只算一次」）。
