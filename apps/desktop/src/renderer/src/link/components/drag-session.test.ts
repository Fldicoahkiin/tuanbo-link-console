import { expect, it } from 'vitest';
import { DragSession, type DragKeys } from './drag-session';
import { KeyRouter } from '../keys/key-router';

type Listener = (event: Event) => void;
type Entry = { type: string; listener: Listener; capture: boolean };

/** The window as a drag sees it: who listens to what, in which phase, and the events a test sends it. */
function fakeWindow() {
  let entries: Entry[] = [];
  const capture = (options: boolean | AddEventListenerOptions | undefined): boolean => typeof options === 'boolean' ? options : options?.capture === true;
  return {
    addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void { entries.push({ type, listener, capture: capture(options) }); },
    removeEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void {
      entries = entries.filter(entry => !(entry.type === type && entry.listener === listener && entry.capture === capture(options)));
    },
    send(event: Event): void { for (const entry of entries.filter(value => value.type === event.type)) entry.listener(event); },
    listening: (): string[] => entries.map(entry => `${entry.type}${entry.capture ? '（捕获）' : ''}`).sort()
  };
}

/** A key press, without modifiers; `stopPropagation` leaves a mark. */
class Key extends Event {
  propagationStopped = false;
  readonly code: string;
  readonly ctrlKey = false; readonly altKey = false; readonly shiftKey = false; readonly metaKey = false; readonly repeat = false; readonly isComposing = false;
  constructor(readonly key: string) { super('keydown', { cancelable: true }); this.code = key; }
  override stopPropagation(): void { this.propagationStopped = true; super.stopPropagation(); }
}

/**
 * The window's key router as a drag sees it (04 设计 4.6): while it is told a drag goes on, it hears the window's keys
 * in the capture phase and routes them as the app's router does (`KeyRouter`), which cancels the drag on Escape.
 */
function keyRouter(view: ReturnType<typeof fakeWindow>): DragKeys {
  const router = new KeyRouter(() => null);
  return {
    beginDrag(drag) {
      const leave = router.beginDrag(drag);
      const listener = (event: Event): void => { if (event instanceof Key) router.dispatch(event); };
      view.addEventListener('keydown', listener, true);
      return () => { leave(); view.removeEventListener('keydown', listener, true); };
    }
  };
}
/** A pointer let go over `at` (the element under it, when nothing holds the pointer). */
class Release extends Event {
  constructor(type: 'pointerup' | 'pointercancel', readonly pointerId: number, at: EventTarget | null = null) {
    super(type);
    Object.defineProperty(this, 'target', { value: at });
  }
}

/** The pressed element: it holds the pointer it captured until the pointer is let go, it loses it, or it goes away. */
function pressed() {
  const state = { connected: true, held: new Set<number>() };
  const inside = new EventTarget();
  return {
    element: { get isConnected() { return state.connected; }, setPointerCapture: (id: number) => { state.held.add(id); }, hasPointerCapture: (id: number) => state.connected && state.held.has(id),
      contains: (other: EventTarget | null) => state.connected && other === inside },
    inside, letGo: () => state.held.clear(), remove: () => { state.connected = false; }
  };
}

function session() {
  const view = fakeWindow();
  const drawn: Array<string | null> = [];
  return { view, drawn, drag: new DragSession<string>(view, value => drawn.push(value), keyRouter(view)) };
}

const WATCHING = ['blur', 'keydown（捕获）', 'pointercancel（捕获）', 'pointerup（捕获）'];

it('拖动中按 Esc 只取消这次拖动，键不再往下传，节目不停；手还按着时再按 Esc 也只被拿走，松手后第一下 Esc 照常停节目；Esc 和松手在窗口的捕获阶段判断，先于时间线和窗口的停止键（0.5.9）', () => {
  const { view, drawn, drag } = session(); const clip = pressed();
  drag.begin(clip.element, 1, '片段 A');
  expect(clip.element.hasPointerCapture(1)).toBe(true);
  expect(view.listening()).toEqual(WATCHING);
  const enter = new Key('Enter'); view.send(enter);
  expect(enter.defaultPrevented || enter.propagationStopped).toBe(false);
  drag.update('片段 A 移到 3 秒');
  expect(drag.current()).toBe('片段 A 移到 3 秒');

  const escape = new Key('Escape'); view.send(escape);
  expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
  expect(drag.current()).toBeNull();
  expect(drawn).toEqual(['片段 A', '片段 A 移到 3 秒', null]);
  // The hand still holds the pointer: Escape pressed again to make sure is taken too and does nothing else, and
  // moving on does not bring the drag back.
  expect(view.listening()).toEqual(WATCHING);
  const again = new Key('Escape'); view.send(again);
  expect([again.defaultPrevented, again.propagationStopped]).toEqual([true, true]);
  drag.update('片段 A 移到 5 秒');
  expect(drag.current()).toBeNull();
  expect(drawn).toEqual(['片段 A', '片段 A 移到 3 秒', null]);
  // Let go on the element, which still holds the pointer and has nothing to drop: the first Escape after that stops the show.
  view.send(new Release('pointerup', 1, clip.inside));
  expect(view.listening()).toEqual([]);
  const next = new Key('Escape'); view.send(next);
  expect(next.defaultPrevented || next.propagationStopped).toBe(false);
  expect(drawn).toEqual(['片段 A', '片段 A 移到 3 秒', null]);
});

it('Esc 取消以后到松手以前，Esc 都只被拿走；另一根手指松开不算；松手、指针被系统取消、窗口失去焦点、元素没了以后松手、元素自己结束，任何一个之后第一下 Esc 照常停节目（0.5.9）', () => {
  type Ending = (parts: { view: ReturnType<typeof fakeWindow>; clip: ReturnType<typeof pressed>; drag: DragSession<string> }) => void;
  const endings: Array<[string, Ending]> = [
    ['松在元素上（元素还握着指针）', ({ view, clip }) => view.send(new Release('pointerup', 1, clip.inside))],
    ['松在别处（元素丢了指针）', ({ view, clip }) => { clip.letGo(); view.send(new Release('pointerup', 1, new EventTarget())); }],
    ['指针被系统取消', ({ view }) => view.send(new Release('pointercancel', 1))],
    ['窗口失去焦点', ({ view }) => view.send(new Event('blur'))],
    ['元素没了以后松手', ({ view, clip }) => { clip.remove(); view.send(new Release('pointerup', 1)); }],
    ['元素自己松手结束', ({ clip, drag }) => { clip.letGo(); drag.end(); }]
  ];
  for (const [name, letGo] of endings) {
    const { view, drawn, drag } = session(); const clip = pressed();
    drag.begin(clip.element, 1, '灯光点');
    view.send(new Key('Escape'));
    view.send(new Release('pointerup', 2)); view.send(new Release('pointercancel', 2));
    const held = new Key('Escape'); view.send(held);
    expect([name, held.defaultPrevented, held.propagationStopped]).toEqual([name, true, true]);
    letGo({ view, clip, drag });
    expect([name, view.listening()]).toEqual([name, []]);
    const next = new Key('Escape'); view.send(next);
    expect([name, next.defaultPrevented || next.propagationStopped]).toEqual([name, false]);
    expect([name, drawn]).toEqual([name, ['灯光点', null]]);
  }
});

it('拖动中被拖的元素没了（顺序连播换到下一首），松手就结束这次拖动，之后第一下 Esc 照常停节目（0.5.9 回归）', () => {
  const { view, drawn, drag } = session(); const clip = pressed();
  drag.begin(clip.element, 1, '片段 A');
  clip.remove();
  // Its own pointerup never comes: the release lands on the lane.
  view.send(new Release('pointerup', 1));
  expect(drag.current()).toBeNull();
  expect(drawn).toEqual(['片段 A', null]);
  expect(view.listening()).toEqual([]);
  const escape = new Key('Escape'); view.send(escape);
  expect(escape.defaultPrevented || escape.propagationStopped).toBe(false);
});

it('元素没了（拖出视口被裁掉、顺序连播换了歌）、手还按着时按 Esc：只取消这次拖动，键不再往下传，节目不停；再按 Esc 也一样；松手后第一下 Esc 照常停节目（0.5.9）', () => {
  const { view, drawn, drag } = session(); const clip = pressed();
  drag.begin(clip.element, 1, '灯光点');
  clip.remove();
  const escape = new Key('Escape'); view.send(escape);
  expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
  expect(drag.current()).toBeNull();
  expect(drawn).toEqual(['灯光点', null]);
  expect(view.listening()).toEqual(WATCHING);
  const again = new Key('Escape'); view.send(again);
  expect([again.defaultPrevented, again.propagationStopped]).toEqual([true, true]);
  view.send(new Release('pointerup', 1));
  expect(view.listening()).toEqual([]);
  const next = new Key('Escape'); view.send(next);
  expect(next.defaultPrevented || next.propagationStopped).toBe(false);
  expect(drawn).toEqual(['灯光点', null]);
});

it('拖动中画面离开（组件卸载）、手还按着：不再画；按 Esc 只取消、不停节目，再按 Esc 也一样，松手也一样结束；之后第一下 Esc 照常停节目（0.5.9）', () => {
  const escaped = session(); const clip = pressed();
  escaped.drag.begin(clip.element, 1, '片段 A');
  escaped.drag.dispose(); clip.remove();
  expect(escaped.view.listening()).toEqual(WATCHING);
  const escape = new Key('Escape'); escaped.view.send(escape);
  expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
  expect(escaped.view.listening()).toEqual(WATCHING);
  const again = new Key('Escape'); escaped.view.send(again);
  expect([again.defaultPrevented, again.propagationStopped]).toEqual([true, true]);
  escaped.view.send(new Release('pointerup', 1));
  expect(escaped.view.listening()).toEqual([]);
  const next = new Key('Escape'); escaped.view.send(next);
  expect(next.defaultPrevented || next.propagationStopped).toBe(false);
  // Gone and cancelled, then the window loses the focus before the release: over as well.
  const blurred = session(); const gone = pressed();
  blurred.drag.begin(gone.element, 1, '片段 C');
  blurred.drag.dispose(); gone.remove();
  blurred.view.send(new Key('Escape'));
  blurred.view.send(new Event('blur'));
  expect(blurred.view.listening()).toEqual([]);
  const later = new Key('Escape'); blurred.view.send(later);
  expect(later.defaultPrevented || later.propagationStopped).toBe(false);
  expect(blurred.drawn).toEqual(['片段 C']);

  const released = session(); const other = pressed();
  released.drag.begin(other.element, 1, '片段 B');
  released.drag.dispose(); other.remove();
  released.view.send(new Release('pointerup', 1));
  expect(released.view.listening()).toEqual([]);
  const after = new Key('Escape'); released.view.send(after);
  expect(after.defaultPrevented || after.propagationStopped).toBe(false);
  // Nothing is drawn once the component left.
  expect([escaped.drawn, released.drawn]).toEqual([['片段 A'], ['片段 B']]);

  // A component that leaves with no drag going on leaves nothing behind.
  const idle = session();
  idle.drag.dispose();
  expect(idle.view.listening()).toEqual([]);
});

it('正常松手交给元素自己放下：窗口不抢先取消；别的指针松开不算；放下后不再监听', () => {
  const { view, drawn, drag } = session(); const clip = pressed();
  drag.begin(clip.element, 7, 'Cue 点');
  view.send(new Release('pointerup', 3));
  // The element still holds pointer 7: its own pointerup comes next and drops the drag.
  view.send(new Release('pointerup', 7));
  expect(drag.current()).toBe('Cue 点');
  clip.letGo(); drag.end();
  expect(drawn).toEqual(['Cue 点', null]);
  expect(view.listening()).toEqual([]);
});

it('元素没了、按着的那根手指还没松：另一根手指（指针）松开或被取消都不算，Esc 照样只取消；只有它自己松开才结束（触摸屏，0.5.9）', () => {
  const { view, drawn, drag } = session(); const clip = pressed();
  drag.begin(clip.element, 1, '机位片段');
  // 顺序连播 moves on: the clip goes away while finger 1 still holds it.
  clip.remove();
  view.send(new Release('pointerup', 2)); view.send(new Release('pointercancel', 2));
  expect(drag.current()).toBe('机位片段');
  expect(view.listening()).toEqual(WATCHING);
  const escape = new Key('Escape'); view.send(escape);
  expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
  expect(drag.current()).toBeNull();

  drag.begin(clip.element, 1, '机位片段');
  clip.remove();
  view.send(new Release('pointerup', 2));
  expect(drag.current()).toBe('机位片段');
  view.send(new Release('pointerup', 1));
  expect(drag.current()).toBeNull();
  expect(view.listening()).toEqual([]);
  expect(drawn).toEqual(['机位片段', null, '机位片段', null]);
});

it('元素还在、只是丢了指针时：手还按着按 Esc 只取消拖动；松在元素上交给它自己放下，松在别处就结束', () => {
  const { view, drawn, drag } = session(); const clip = pressed();
  drag.begin(clip.element, 1, '片段 A');
  clip.letGo();
  const escape = new Key('Escape'); view.send(escape);
  expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
  expect(drag.current()).toBeNull();

  drag.begin(clip.element, 1, '片段 B');
  clip.letGo();
  view.send(new Release('pointerup', 1, clip.inside));
  expect(drag.current()).toBe('片段 B');
  drag.end();

  drag.begin(clip.element, 1, '片段 C');
  clip.letGo();
  view.send(new Release('pointerup', 1, new EventTarget()));
  expect(drag.current()).toBeNull();
  const next = new Key('Escape'); view.send(next);
  expect(next.defaultPrevented || next.propagationStopped).toBe(false);
  expect(drawn).toEqual(['片段 A', null, '片段 B', null, '片段 C', null]);
  expect(view.listening()).toEqual([]);
});

it('窗口失去焦点、指针被系统取消时也结束拖动；新的拖动开始时旧的不再监听，也清不掉新的', () => {
  const { view, drawn, drag } = session();
  drag.begin(pressed().element, 1, '第一次');
  view.send(new Event('blur'));
  expect(drag.current()).toBeNull();

  const lost = pressed();
  drag.begin(lost.element, 1, '第二次');
  lost.remove();
  view.send(new Release('pointercancel', 1));
  expect(drag.current()).toBeNull();

  const first = pressed(), second = pressed();
  drag.begin(first.element, 1, '第三次');
  drag.begin(second.element, 2, '第四次');
  expect(view.listening()).toEqual(WATCHING);
  first.remove();
  view.send(new Release('pointerup', 1));
  expect(drag.current()).toBe('第四次');
  second.letGo(); drag.end();
  expect(view.listening()).toEqual([]);
  expect(drawn).toEqual(['第一次', null, '第二次', null, '第三次', '第四次', null]);
});
