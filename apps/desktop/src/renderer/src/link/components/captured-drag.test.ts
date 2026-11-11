import { expect, it } from 'vitest';
import { CapturedDrag } from './captured-drag';
import { DragSession } from './drag-session';
import { KeyRouter } from '../keys/key-router';

/*
 * The drags the window's key router is told of (04 设计 K5): Escape and the keys that change the project are taken
 * while the pointer is held, and the show and the project are left alone; once it is let go they act as before.
 */

type Listener = (event: Event) => void;
type Entry = { type: string; listener: Listener; capture: boolean };

/** The window: who listens to what, and the events a test sends it (capture listeners first). */
function fakeWindow() {
  let entries: Entry[] = [];
  const capture = (options: boolean | AddEventListenerOptions | undefined): boolean => typeof options === 'boolean' ? options : options?.capture === true;
  return {
    addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void { entries.push({ type, listener, capture: capture(options) }); },
    removeEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void {
      entries = entries.filter(entry => !(entry.type === type && entry.listener === listener && entry.capture === capture(options)));
    },
    send(event: Event): void { for (const entry of [...entries.filter(value => value.capture), ...entries.filter(value => !value.capture)]) if (entry.type === event.type) entry.listener(event); },
    listening: (): string[] => entries.map(entry => `${entry.type}${entry.capture ? '（捕获）' : ''}`).sort()
  };
}

/** A key press with nothing focused; `stopPropagation` leaves a mark. */
class Key extends Event {
  propagationStopped = false;
  readonly key: string;
  readonly altKey = false; readonly shiftKey = false; readonly metaKey = false; readonly repeat = false; readonly isComposing = false;
  constructor(readonly code: string, readonly ctrlKey = false) { super('keydown', { cancelable: true }); this.key = code; }
  override stopPropagation(): void { this.propagationStopped = true; super.stopPropagation(); }
}
class Release extends Event {
  constructor(type: 'pointerup' | 'pointercancel', readonly pointerId: number) { super(type); }
}

/** The app's router on `view` on the editor page, writing down the commands it ran. */
function routed() {
  const view = fakeWindow();
  const router = new KeyRouter(() => null);
  router.setPage('cues');
  const calls: string[] = [];
  const uninstall = router.install(view);
  router.register('global', () => ({ 'transport.stop': () => { calls.push('停止'); }, 'document.undo': () => { calls.push('撤销'); }, 'document.redo': () => { calls.push('重做'); } }));
  router.register('timeline', () => ({ 'edit.delete': () => { calls.push('删除'); } }));
  const press = (code: string, ctrl = false): Key => { const key = new Key(code, ctrl); view.send(key); return key; };
  return { view, router, calls, press, uninstall };
}

it('舞台和 OBS 实时画布拖动中（手按着）：Esc 只被拿走、不停节目；Delete、Ctrl+Z、Ctrl+Y 不执行，键不再往下传；松手后照常', () => {
  const { view, router, calls, press } = routed();
  const drag = new CapturedDrag(view, router);
  drag.got(1);
  expect(view.listening()).toEqual(['blur', 'keydown（捕获）', 'pointercancel（捕获）', 'pointerup（捕获）']);
  for (const [code, ctrl] of [['Escape', false], ['Escape', false], ['Delete', false], ['KeyZ', true], ['KeyY', true]] as const) {
    const key = press(code, ctrl);
    expect([code, key.defaultPrevented, key.propagationStopped]).toEqual([code, true, true]);
  }
  expect(calls).toEqual([]);
  // The element lets the pointer go: the keys act again.
  drag.lost(1);
  expect(view.listening()).toEqual(['keydown（捕获）']);
  press('Escape'); press('KeyZ', true);
  expect(calls).toEqual(['停止', '撤销']);
});

it('没说一声就丢了指针也不会一直挡着 Esc：那根手指松开、被系统取消、窗口失去焦点、组件离开，任何一个都结束；别的手指不算', () => {
  const endings: Array<[string, (view: ReturnType<typeof fakeWindow>, drag: CapturedDrag) => void]> = [
    ['松开', view => view.send(new Release('pointerup', 1))],
    ['被系统取消', view => view.send(new Release('pointercancel', 1))],
    ['窗口失去焦点', view => view.send(new Event('blur'))],
    ['组件离开', (_view, drag) => drag.clear()]
  ];
  for (const [name, end] of endings) {
    const { view, router, calls, press } = routed();
    const drag = new CapturedDrag(view, router);
    drag.got(1);
    view.send(new Release('pointerup', 2));
    press('Escape');
    expect([name, calls]).toEqual([name, []]);
    end(view, drag);
    expect([name, view.listening()]).toEqual([name, ['keydown（捕获）']]);
    press('Escape');
    expect([name, calls]).toEqual([name, ['停止']]);
  }
});

it('同时有能取消的拖动（DragSession）时，Esc 取消它；拖播放头时按 Esc 只取消拖动，不停节目；松手后第一下 Esc 照常停止', () => {
  const { view, router, calls, press } = routed();
  const drawn: Array<number | null> = [];
  const held = new Set<number>();
  const playhead = new DragSession<number>(view, value => drawn.push(value), router);
  playhead.begin({ setPointerCapture: id => { held.add(id); }, hasPointerCapture: id => held.has(id), contains: () => false }, 1, 1);
  const escape = press('Escape');
  expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
  expect(playhead.current()).toBeNull();
  expect(drawn).toEqual([1, null]);
  press('Delete');
  expect(calls).toEqual([]);
  held.clear();
  view.send(new Release('pointerup', 1));
  press('Escape');
  expect(calls).toEqual(['停止']);
});
