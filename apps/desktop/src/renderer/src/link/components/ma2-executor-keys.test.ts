import { expect, it } from 'vitest';
import { executorKeyDown, executorKeyUp } from './ma2-executor-keys';

/** A key going down (or up) on a focused executor key; `preventDefault` takes it from the browser and leaves a mark. */
function key(value: string, repeat = false) {
  const event = { key: value, repeat, taken: false, preventDefault: () => { event.taken = true; } };
  return event;
}

it('普通执行器键（Go 等）：第一下留给按钮自己点一次，按住时重复的空格和 Enter 被拿走、什么也不按（0.5.9）', () => {
  const pressed: number[] = [];
  for (const value of [' ', 'Enter']) {
    const first = key(value), repeats = [key(value, true), key(value, true), key(value, true)];
    for (const event of [first, ...repeats]) executorKeyDown(event, false, () => pressed.push(1));
    expect([first.taken, ...repeats.map(event => event.taken)]).toEqual([false, true, true, true]);
    const up = key(value); executorKeyUp(up, false, () => pressed.push(-1));
    expect(up.taken).toBe(false);
  }
  expect(pressed).toEqual([]);
});

it('按住才亮的执行器键（Flash、Temp）：第一下按下，重复的不再按，松开才放开；别的键都不管', () => {
  const sent: string[] = [];
  const down = [key('Enter'), key('Enter', true), key('Enter', true)];
  for (const event of down) executorKeyDown(event, true, () => sent.push('按下'));
  expect(down.map(event => event.taken)).toEqual([true, true, true]);
  const up = key('Enter'); executorKeyUp(up, true, () => sent.push('松开'));
  expect(up.taken).toBe(true);
  expect(sent).toEqual(['按下', '松开']);

  const others = [key('Escape'), key('m'), key('ArrowDown', true)];
  for (const event of others) { executorKeyDown(event, true, () => sent.push('按下')); executorKeyDown(event, false, () => sent.push('按下')); executorKeyUp(event, true, () => sent.push('松开')); }
  expect(others.map(event => event.taken)).toEqual([false, false, false]);
  expect(sent).toEqual(['按下', '松开']);
});
