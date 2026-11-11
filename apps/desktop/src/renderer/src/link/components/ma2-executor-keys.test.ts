import { expect, it } from 'vitest';
import { executorKeyDown, executorKeyUp } from './ma2-executor-keys';

/** A key going down (or up) on a focused executor key; `preventDefault` takes it from the browser and leaves a mark. */
function key(value: string, repeat = false) {
  const event = { key: value, repeat, taken: false, preventDefault: () => { event.taken = true; } };
  return event;
}

// 按住 Enter 时重复的那些由按键路由先拿走，到不了执行器键（K7，keys/key-routing-rules.test.ts 的「按住 Enter 只算一次」）。
it('普通执行器键（Go 等）：空格和 Enter 留给按钮自己点，执行器键自己不再管重复的', () => {
  const pressed: number[] = [];
  for (const value of [' ', 'Enter']) {
    const first = key(value);
    executorKeyDown(first, false, () => pressed.push(1));
    expect(first.taken).toBe(false);
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
