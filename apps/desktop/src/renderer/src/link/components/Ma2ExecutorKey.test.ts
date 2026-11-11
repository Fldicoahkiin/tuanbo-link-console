import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Ma2ExecutorPage } from '@tb/schema';
import { Ma2ExecutorKey } from './Ma2ExecutorKey';
import { KeyRouter } from '../keys/key-router';

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);

type Item = Ma2ExecutorPage['items'][number];
/** Executor 100.1: Go on its first key, Flash on the second, Off on the third. */
const item: Item = { slot: 1, width: 1, name: '面光', sequence: 86, kind: 'sequence', button: 12299, buttons: [12299, 12302, 12290, 0], reference: ['25', '1', '86'] };

type Button = React.ReactElement<React.ComponentProps<'button'>>;
type Key = { key: string; repeat: boolean; taken: boolean; preventDefault: () => void };

/**
 * The key as the page draws it, with the button's own handlers, and what reaches the console. It is drawn once, without
 * a window: the handlers keep this drawing's state (not held down), which is all one held key needs.
 */
function draw(index: number): { html: string; button: Button; sent: string[] } {
  const sent: string[] = [];
  const input = {
    press: (_: Item, page: number, key: number) => { sent.push(`按下 ${page}.${item.slot} 第 ${key + 1} 键`); },
    release: (_: Item, page: number, key: number) => { sent.push(`松开 ${page}.${item.slot} 第 ${key + 1} 键`); }
  };
  const drawn: { button: Button | null } = { button: null };
  function Page(): JSX.Element { drawn.button = Ma2ExecutorKey({ item, page: 100, index, input }); return drawn.button; }
  const html = renderToStaticMarkup(React.createElement(Page));
  if (!drawn.button) throw new Error('执行器键没有画出来');
  return { html, button: drawn.button, sent };
}

function key(value: string, repeat: boolean): Key {
  const event: Key = { key: value, repeat, taken: false, preventDefault: () => { event.taken = true; } };
  return event;
}

/** The focused button, as the key router looks at it: a `<button>` on the page, with no keys of its own declared. */
const focusedButton = { closest: (selectors: string) => selectors.split(',').some(selector => selector.trim() === 'button') ? { getAttribute: () => null } : null };

/**
 * Holds Space or Enter on the focused button: one keydown, `repeats` repeated keydowns, then the keyup. Each keydown
 * goes to the window's key router first (K7: it takes a held Enter's repeats, `held`), then, unless the router stopped
 * it, to the button. What Chromium does with what is left to it: every Enter keydown clicks the button; a Space keydown
 * arms it and the keyup clicks it. Returns which keydowns were taken from the browser.
 */
function hold(button: Button, value: ' ' | 'Enter', repeats: number): boolean[] {
  const click = (): void => button.props.onClick?.({ stopPropagation: () => undefined } as unknown as React.MouseEvent<HTMLButtonElement>);
  const router = new KeyRouter(() => null);
  const taken: boolean[] = [];
  let armed = false;
  for (let index = 0; index <= repeats; index++) {
    const down = key(value, index > 0);
    let stopped = false;
    router.dispatch({ code: value === ' ' ? 'Space' : 'Enter', key: value, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: down.repeat,
      isComposing: false, get defaultPrevented() { return down.taken; }, preventDefault: down.preventDefault, stopPropagation: () => { stopped = true; }, target: focusedButton });
    if (!stopped) button.props.onKeyDown?.(down as unknown as React.KeyboardEvent<HTMLButtonElement>);
    taken.push(down.taken);
    if (stopped) continue;
    if (!down.taken && value === 'Enter') click();
    if (!down.taken && value === ' ') armed = true;
  }
  const up = key(value, false);
  button.props.onKeyUp?.(up as unknown as React.KeyboardEvent<HTMLButtonElement>);
  if (!up.taken && armed) click();
  return taken;
}

it('Go 这类普通执行器键有焦点时按住 Enter：控台只收到一次按下，重复的按键由按键路由拿走（K7），不会一下跳过好几个 Cue（0.5.9）', () => {
  const go = draw(0);
  expect(go.html).not.toContain('data-momentary');
  const taken = hold(go.button, 'Enter', 3);
  expect(go.sent).toEqual(['按下 100.1 第 1 键']);
  // The first keydown is left to the button, whose click presses the key once; the router takes the repeats.
  expect(taken).toEqual([false, true, true, true]);

  // Space clicks a button when let go, once however long it is held.
  const space = draw(0);
  hold(space.button, ' ', 3);
  expect(space.sent).toEqual(['按下 100.1 第 1 键']);
});

it('Flash 这类按住才亮的执行器键：按住空格或 Enter 时按下、松手才放开，重复的按键不再按（0.5.8 起空格归它自己）', () => {
  for (const value of [' ', 'Enter'] as const) {
    const flash = draw(1);
    expect(flash.html).toContain('data-momentary="true"');
    expect(hold(flash.button, value, 3)[0]).toBe(true);
    expect(flash.sent).toEqual(['按下 100.1 第 2 键', '松开 100.1 第 2 键']);
  }
});

it('用鼠标点 Flash 这类按住才亮的键：按下时按一次、松开时放开一次，之后的 click 不再按（否则控台上一直亮着，0.5.9）', () => {
  const flash = draw(1);
  const pointer = { button: 0, pointerId: 1, currentTarget: { setPointerCapture: () => undefined } };
  flash.button.props.onPointerDown?.(pointer as unknown as React.PointerEvent<HTMLButtonElement>);
  flash.button.props.onPointerUp?.(pointer as unknown as React.PointerEvent<HTMLButtonElement>);
  flash.button.props.onClick?.({ stopPropagation: () => undefined } as unknown as React.MouseEvent<HTMLButtonElement>);
  expect(flash.sent).toEqual(['按下 100.1 第 2 键', '松开 100.1 第 2 键']);
});
