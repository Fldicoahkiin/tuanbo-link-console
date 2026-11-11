import { describe, expect, it } from 'vitest';
import { DragSession } from '../components/drag-session';
import { cancelDragOnEscape } from '../playback-keys';
import { documentShortcut } from '../useDocumentShortcuts';
import { modalDialogOpen } from './key-owner';
import { KeyRouter, type KeyHandlers, type KeyOverlayEntry, type KeyWhen } from './key-router';
import type { KeyPage, KeyScope } from './keymap';

/*
 * The window's one key listener (key-router.ts), pressed with a fake window, fake elements and fake key events. The
 * second part carries over the cases of playback-keys.test.ts, written for the window listener of useInternalPlayer
 * (playbackKeyAction, handlePlaybackKey, registerPlayButton) before the router took its place, with the same
 * assertions: the helpers below of the old names press the keys through a router wired as the app wires it.
 */

/** An element; `modal` marks a native <dialog> opened with showModal(). */
type Node = { tag: string; attributes?: Record<string, string>; parent?: Node; modal?: boolean };
type Fake = { closest(selectors: string): Fake | null; getAttribute(name: string): string | null };

/**
 * One selector of the kinds the key helpers use: `tag`, `.class`, `[name]`, `[name="value"]`, `[name~="word"]` (one of
 * the words of the value), and a tag with either.
 */
function matches(candidate: Node, selector: string): boolean {
  const parts = /^([a-z]*)((?:\.[a-z-]+)*)((?:\[[a-z-]+(?:~?="[^"]*")?\])*)$/.exec(selector.trim());
  if (!parts) throw new Error(`测试里的元素不认识这个选择器：${selector}`);
  const [, tag = '', classes = '', attributes = ''] = parts;
  if (tag && candidate.tag !== tag) return false;
  if (classes.split('.').filter(Boolean).some(name => !candidate.attributes?.class?.split(' ').includes(name))) return false;
  return [...attributes.matchAll(/\[([a-z-]+)(?:(~?)="([^"]*)")?\]/g)].every(([, name = '', word, value]) => {
    const actual = candidate.attributes?.[name];
    return actual !== undefined && (value === undefined || (word ? actual.split(' ').includes(value) : actual === value));
  });
}
/** The node each fake element stands for. */
const nodes = new WeakMap<object, Node>();
/** A focused element, with `closest` over its parent chain. */
function element(node: Node): Fake {
  const fake: Fake = {
    closest: (selectors: string) => {
      for (let current: Node | undefined = node; current; current = current.parent) {
        const candidate = current;
        if (selectors.split(',').some(selector => matches(candidate, selector))) return element(candidate);
      }
      return null;
    },
    getAttribute: (name: string) => node.attributes?.[name] ?? null
  };
  nodes.set(fake, node);
  return fake;
}
/** The page as `querySelector` reads it: the first of `nodes` any of the selectors match (`dialog:modal` too). */
const page = (...nodes: Node[]) => ({ querySelector: (selectors: string) => nodes.find(node => selectors.split(',')
  .some(selector => selector === 'dialog:modal' ? node.tag === 'dialog' && node.modal === true : matches(node, selector))) ?? null });

type Modifiers = { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; repeat?: boolean };
/** A key press as the window sees it; `stopPropagation` leaves a mark. `at` puts the focus on an element. */
class Press extends Event {
  readonly key: string;
  readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly metaKey: boolean; readonly repeat: boolean;
  readonly isComposing = false;
  propagationStopped = false;
  constructor(readonly code: string, readonly modifiers: Modifiers = {}) {
    super('keydown', { cancelable: true });
    this.key = code === 'Space' ? ' ' : code;
    this.ctrlKey = modifiers.ctrlKey ?? false; this.altKey = modifiers.altKey ?? false; this.shiftKey = modifiers.shiftKey ?? false;
    this.metaKey = modifiers.metaKey ?? false; this.repeat = modifiers.repeat ?? false;
  }
  override stopPropagation(): void { this.propagationStopped = true; super.stopPropagation(); }
  at(target: Fake | null): this { Object.defineProperty(this, 'target', { value: target, configurable: true }); return this; }
}
const press = (code: string, modifiers: Modifiers = {}): Press => new Press(code, modifiers);
/** Whether anyone took the key. */
const touched = (key: Press): boolean => key.defaultPrevented || key.propagationStopped;

type Listener = (event: Event) => void;
type Entry = { type: string; listener: Listener; capture: boolean };
/** The window: who listens to what, in which phase and order, and the events a test sends it. */
function fakeWindow() {
  let entries: Entry[] = [];
  const capture = (options: boolean | AddEventListenerOptions | undefined): boolean => typeof options === 'boolean' ? options : options?.capture === true;
  return {
    addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void { entries.push({ type, listener, capture: capture(options) }); },
    removeEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void {
      entries = entries.filter(entry => !(entry.type === type && entry.listener === listener && entry.capture === capture(options)));
    },
    /** Capture listeners first, in the order they were added, as on a window. */
    send(event: Event): void { for (const entry of [...entries.filter(value => value.capture), ...entries.filter(value => !value.capture)]) if (entry.type === event.type) entry.listener(event); },
    listening: (): string[] => entries.map(entry => `${entry.type}${entry.capture ? '（捕获）' : ''}`).sort()
  };
}

const body: Node = { tag: 'body' };

/** A router on `onPage`, writing down which handler ran. */
function routed(onPage: KeyPage = 'project') {
  let modal: Node[] = [];
  const router = new KeyRouter(() => page(...modal));
  router.setPage(onPage);
  const calls: string[] = [];
  const handle = (scope: KeyScope, names: Partial<Record<keyof KeyHandlers, string>>, when?: KeyWhen): (() => void) =>
    router.register(scope, () => Object.fromEntries(Object.entries(names).map(([id, name]) => [id, () => { calls.push(name); }])), when);
  return { router, calls, handle, openModal: (open: boolean) => { modal = open ? [{ tag: 'dialog', modal: true }] : []; } };
}

/** A panel Escape closes, writing down its `name` in `closed` when it is closed; `inside`: the elements in it. */
function panel(name: string, closed: string[], options: { blocks?: boolean; inside?: readonly Node[] } = {}): KeyOverlayEntry {
  const inside = (node: Node | undefined): boolean => node !== undefined && (options.inside?.includes(node) === true || inside(node.parent));
  return { open: () => true, close: () => { closed.push(name); }, contains: target => inside(nodes.get(target)), blocks: options.blocks ?? false };
}
describe('路由本身', () => {
  it('按一下只有一个处理执行：页面的处理先于窗口的，页面的处理可以再调窗口自己的；页面上没有这个处理时用窗口的', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.stop': '窗口停止' });
    const leave = handle('home', { 'transport.stop': '首页停止' });
    const escape = press('Escape').at(element(body));
    router.dispatch(escape);
    expect(calls).toEqual(['首页停止']);
    // Taken from the browser, and still heard by the page and the window after the router, as before it (0.5.9).
    expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, false]);
    leave();
    router.dispatch(press('Escape').at(element(body)));
    expect(calls).toEqual(['首页停止', '窗口停止']);
    // The home page's handler hands on to the window's own (the program list's Escape clears, then stops).
    calls.length = 0;
    router.register('home', () => ({ 'transport.stop': stop => { calls.push('清空选择'); stop.global(); } }));
    router.dispatch(press('Escape').at(element(body)));
    expect(calls).toEqual(['清空选择', '窗口停止']);
  });

  it('页面的处理只在它的页面上起作用：首页的播放按钮在首页，编辑器和灯光工作台的时间线播放按钮在那两页', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.playPause': '窗口（无事）' });
    handle('home', { 'transport.playPause': '首页播放按钮' });
    handle('timeline', { 'transport.playPause': '时间线播放按钮' });
    router.dispatch(press('Space').at(element(body)));
    for (const onPage of ['cues', 'lighting'] as const) { router.setPage(onPage); router.dispatch(press('Space').at(element(body))); }
    expect(calls).toEqual(['首页播放按钮', '时间线播放按钮', '时间线播放按钮']);
    // A registration whose `when` says no is passed over: the home page is not on screen.
    calls.length = 0;
    const hidden = routed();
    hidden.handle('global', { 'transport.playPause': '窗口（无事）' });
    hidden.handle('home', { 'transport.playPause': '首页播放按钮' }, () => false);
    hidden.router.dispatch(press('Space').at(element(body)));
    expect(hidden.calls).toEqual(['窗口（无事）']);
  });

  it('没有任何处理时（P1 跟随，或还没有播放器），键原样留给浏览器：不拦、不停止往下传', () => {
    const { router, calls } = routed();
    const keys = [press('Space'), press('Escape'), press('ArrowDown'), press('ArrowUp'), press('Digit3', { ctrlKey: true }), press('KeyS', { ctrlKey: true }), press('KeyZ', { ctrlKey: true })];
    for (const key of keys) router.dispatch(key.at(element(body)));
    for (const onPage of ['cues', 'lighting'] as const) { router.setPage(onPage); for (const code of ['Space', 'Escape']) { const key = press(code).at(element(body)); router.dispatch(key); keys.push(key); } }
    expect(keys.map(touched)).toEqual(keys.map(() => false));
    expect(calls).toEqual([]);
  });

  it('只按一次的键按住不放时，重复的 keydown 被拿走但什么都不做；保存、撤销按住会重复', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.playPause': '播放', 'transport.stop': '停止', 'document.undo': '撤销' });
    const held = [press('Space', { repeat: true }), press('Escape', { repeat: true })];
    for (const key of held) router.dispatch(key.at(element(body)));
    expect(held.map(key => [key.defaultPrevented, key.propagationStopped])).toEqual([[true, false], [true, false]]);
    expect(calls).toEqual([]);
    router.dispatch(press('KeyZ', { ctrlKey: true, repeat: true }).at(element(body)));
    expect(calls).toEqual(['撤销']);
  });

  it('保存、另存为、撤销、重做和 useDocumentShortcuts 的规则一样（Ctrl+Alt+S 保存、Ctrl+Shift+Y 重做、Cmd+S 不保存，滑块和范围输入上照常撤销）；只拦默认动作，键照常往下传给页面', () => {
    const { router, calls, handle, openModal } = routed();
    handle('global', { 'document.save': 'save', 'document.saveAs': 'save-as', 'document.undo': 'undo', 'document.redo': 'redo' });
    const dialog: Node = { tag: 'div', attributes: { role: 'dialog' }, parent: body };
    const places: Array<{ node: Node; editingText: boolean; inDialog: boolean; modal?: boolean }> = [
      { node: body, editingText: false, inDialog: false },
      { node: { tag: 'button', parent: body }, editingText: false, inDialog: false },
      { node: { tag: 'input', parent: body }, editingText: true, inDialog: false },
      { node: { tag: 'input', attributes: { type: 'text' }, parent: body }, editingText: true, inDialog: false },
      { node: { tag: 'input', attributes: { type: 'range' }, parent: body }, editingText: false, inDialog: false },
      { node: { tag: 'input', attributes: { type: 'checkbox' }, parent: body }, editingText: false, inDialog: false },
      { node: { tag: 'textarea', parent: body }, editingText: true, inDialog: false },
      { node: { tag: 'div', attributes: { role: 'slider' }, parent: body }, editingText: false, inDialog: false },
      { node: { tag: 'section', attributes: { class: 'reference-timeline' }, parent: body }, editingText: false, inDialog: false },
      { node: { tag: 'button', parent: dialog }, editingText: false, inDialog: true },
      { node: body, editingText: false, inDialog: true, modal: true }
    ];
    const chords: Array<{ code: string; letter: string; modifiers: Modifiers }> = [
      { code: 'KeyS', letter: 's', modifiers: { ctrlKey: true } }, { code: 'KeyS', letter: 's', modifiers: { ctrlKey: true, altKey: true } },
      { code: 'KeyS', letter: 'S', modifiers: { ctrlKey: true, shiftKey: true } }, { code: 'KeyS', letter: 's', modifiers: { ctrlKey: true, metaKey: true } },
      { code: 'KeyS', letter: 's', modifiers: { metaKey: true } }, { code: 'KeyS', letter: 's', modifiers: {} },
      { code: 'KeyZ', letter: 'z', modifiers: { ctrlKey: true } }, { code: 'KeyZ', letter: 'Z', modifiers: { ctrlKey: true, shiftKey: true } },
      { code: 'KeyY', letter: 'y', modifiers: { ctrlKey: true } }, { code: 'KeyY', letter: 'Y', modifiers: { ctrlKey: true, shiftKey: true } },
      { code: 'KeyZ', letter: 'z', modifiers: { metaKey: true } }, { code: 'KeyA', letter: 'a', modifiers: { ctrlKey: true } }
    ];
    for (const place of places) {
      openModal(place.modal === true);
      for (const chord of chords) {
        calls.length = 0;
        const key = press(chord.code, chord.modifiers).at(element(place.node));
        router.dispatch(key);
        const expected = documentShortcut({ ctrlKey: key.ctrlKey, shiftKey: key.shiftKey, key: chord.letter }, place.editingText, place.inDialog);
        expect([place.node.tag, place.node.attributes, chord.code, chord.modifiers, calls]).toEqual([place.node.tag, place.node.attributes, chord.code, chord.modifiers, expected ? [expected] : []]);
        expect([key.defaultPrevented, key.propagationStopped]).toEqual([expected !== null, false]);
      }
    }
  });

  it('Esc 关的面板开着时 Esc 由路由关掉它（K4），空格照常播放；设置页和连接页开着时窗口的播放键都不碰节目，Esc 只关页面，Ctrl+S 照常保存', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.stop': '停止', 'transport.playPause': '播放', 'document.save': '保存' });
    const closed: string[] = [];
    const leave = router.overlay(panel('面板', closed));
    const escape = press('Escape').at(element(body));
    router.dispatch(escape);
    router.dispatch(press('Space').at(element(body)));
    // Closed by the router, taken from the browser, and still heard by the listeners after it (K6 stops it there).
    expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, false]);
    expect(closed).toEqual(['面板']);
    expect(calls).toEqual(['播放']);
    leave();
    router.dispatch(press('Escape').at(element(body)));
    expect(calls).toEqual(['播放', '停止']);

    calls.length = 0;
    const settings = router.overlay(panel('设置页', closed, { blocks: true }));
    const left = [press('Escape'), press('Space'), press('ArrowDown')].map(key => key.at(element(body)));
    for (const key of left) router.dispatch(key);
    router.dispatch(press('KeyS', { ctrlKey: true }).at(element(body)));
    expect(left.map(touched)).toEqual([true, false, false]);
    expect(closed).toEqual(['面板', '设置页']);
    expect(calls).toEqual(['保存']);
    settings();
  });

  it('还没接到路由上的监听（灯光工作台的快捷键）说它要的键，窗口的键就留给它：单曲快捷键和它重了也不播歌', () => {
    const { router, calls, handle } = routed('lighting');
    handle('global', { 'transport.playPause': '播放' });
    router.songShortcuts({ find: chord => chord === 'KeyM' ? '第三首' : undefined, play: itemId => { calls.push(`播放 ${itemId}`); } });
    const leave = router.claim(event => event.code === 'KeyM' || event.code === 'Space');
    const keys = [press('KeyM'), press('Space')].map(key => key.at(element(body)));
    for (const key of keys) router.dispatch(key);
    expect(keys.map(touched)).toEqual([false, false]);
    expect(calls).toEqual([]);
    leave();
    router.dispatch(press('KeyM').at(element(body)));
    expect(calls).toEqual(['播放 第三首']);
  });

  it('在窗口上监听捕获阶段，先于其他监听；装上后能拿下来', () => {
    const view = fakeWindow();
    const { router, calls, handle } = routed();
    handle('global', { 'transport.stop': '停止' });
    const uninstall = router.install(view);
    expect(view.listening()).toEqual(['keydown（捕获）']);
    view.send(press('Escape').at(element(body)));
    uninstall();
    expect(view.listening()).toEqual([]);
    view.send(press('Escape').at(element(body)));
    expect(calls).toEqual(['停止']);
  });

  it('首页节目列表里按 Esc：先清空选择，再照常停止节目（00-order 第 9 节）；列表外按 Esc 只停止', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.stop': '停止' });
    const grid: Node = { tag: 'div', attributes: { class: 'home-grid', 'data-own-keys': 'Ctrl+KeyA Delete' }, parent: body };
    router.register('home', () => ({ 'transport.stop': stop => { calls.push('清空选择'); stop.global(); } }), stop => stop.target?.closest('.home-grid') != null);
    router.dispatch(press('Escape').at(element({ tag: 'div', attributes: { class: 'home-card' }, parent: grid })));
    router.dispatch(press('Escape').at(element(grid)));
    router.dispatch(press('Escape').at(element(body)));
    expect(calls).toEqual(['清空选择', '停止', '清空选择', '停止', '停止']);
    // The grid's own keys stay the grid's.
    const remove = press('Delete').at(element(grid));
    router.dispatch(remove);
    expect(touched(remove)).toBe(false);
  });
});

describe('浮层和弹窗层（04 设计 K4）', () => {
  it('浮层叠着时 Esc 只关最上面那个（后打开的）；一个一个关完以后 Esc 才停节目；模态对话框开着时 Esc 留给对话框', () => {
    const { router, calls, handle, openModal } = routed();
    handle('global', { 'transport.stop': '停止' });
    const closed: string[] = [];
    const leaves = [router.overlay(panel('设置页', closed, { blocks: true })), router.overlay(panel('设置页里的面板', closed))];
    const modal = press('Escape').at(element(body));
    openModal(true);
    router.dispatch(modal);
    openModal(false);
    expect([closed, touched(modal)]).toEqual([[], false]);
    router.dispatch(press('Escape').at(element(body)));
    expect(closed).toEqual(['设置页里的面板']);
    leaves.pop()?.();
    router.dispatch(press('Escape').at(element(body)));
    expect(closed).toEqual(['设置页里的面板', '设置页']);
    leaves.pop()?.();
    router.dispatch(press('Escape').at(element(body)));
    expect(calls).toEqual(['停止']);
  });

  it('焦点在面板的输入框或按钮上按 Esc 也关面板；自己用 Esc 的元素（ownKeys）留给它自己（输入框里 Esc 撤回输入）', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.stop': '停止' });
    const closed: string[] = [];
    const popover: Node = { tag: 'section', attributes: { role: 'dialog', class: 'ui-popover' }, parent: body };
    const leave = router.overlay(panel('面板', closed, { inside: [popover] }));
    router.dispatch(press('Escape').at(element({ tag: 'input', parent: popover })));
    router.dispatch(press('Escape').at(element({ tag: 'button', parent: popover })));
    const own = press('Escape').at(element({ tag: 'input', attributes: { 'data-own-keys': 'Escape' }, parent: popover }));
    router.dispatch(own);
    expect([closed, touched(own), calls]).toEqual([['面板', '面板'], false, []]);
    leave();
  });

  it('设置页开着时页面键和全局键都不碰节目：编辑器的空格、Esc、方向键和单曲快捷键都不动，Esc 只关设置页，Ctrl+S 照常保存', () => {
    const { router, calls, handle } = routed('cues');
    handle('global', { 'transport.stop': '窗口停止', 'transport.playPause': '窗口播放', 'home.nextSong': '下一首', 'document.save': '保存' });
    handle('timeline', { 'transport.playPause': '时间线播放' });
    router.songShortcuts({ find: chord => chord === 'Ctrl+Digit3' ? '第三首' : undefined, play: itemId => { calls.push(`播放 ${itemId}`); } });
    const closed: string[] = [];
    const settings: Node = { tag: 'section', attributes: { role: 'dialog', class: 'connections-dialog' }, parent: body };
    const leave = router.overlay(panel('设置页', closed, { blocks: true, inside: [settings] }));
    for (const target of [body, { tag: 'button', parent: settings }, { tag: 'section', attributes: { class: 'reference-timeline' }, parent: body }]) {
      for (const key of [press('Space'), press('ArrowDown'), press('Digit3', { ctrlKey: true })]) {
        router.dispatch(key.at(element(target)));
        expect(touched(key)).toBe(false);
      }
    }
    router.dispatch(press('Escape').at(element(body)));
    router.dispatch(press('KeyS', { ctrlKey: true }).at(element({ tag: 'input', parent: settings })));
    expect([calls, closed]).toEqual([['保存'], ['设置页']]);
    leave();
  });

  it('Popover 开着、焦点在外面时空格照样播放；焦点在不是对话框的面板里（播放状态详情）时空格归面板', () => {
    const { router, calls, handle } = routed();
    handle('global', { 'transport.playPause': '播放' });
    const closed: string[] = [];
    const details: Node = { tag: 'div', attributes: { class: 'player-diagnostics-popover' }, parent: body };
    const leave = router.overlay(panel('播放状态详情', closed, { inside: [details] }));
    router.dispatch(press('Space').at(element(body)));
    router.dispatch(press('Space').at(element({ tag: 'button', parent: body })));
    const inside = press('Space').at(element({ tag: 'button', parent: details }));
    router.dispatch(inside);
    expect([calls, touched(inside), closed]).toEqual([['播放', '播放'], false, []]);
    leave();
  });

  it('有模态框开着时 Ctrl+Z、Ctrl+Y 不撤销重做工程，键留给对话框；Ctrl+S 照常保存', () => {
    const { router, calls, handle, openModal } = routed();
    handle('global', { 'document.undo': '撤销', 'document.redo': '重做', 'document.save': '保存' });
    const dialog: Node = { tag: 'dialog', attributes: { class: 'modal-surface', open: '' }, parent: body, modal: true };
    openModal(true);
    const left = [press('KeyZ', { ctrlKey: true }), press('KeyY', { ctrlKey: true }), press('KeyZ', { ctrlKey: true, shiftKey: true })];
    for (const target of [body, { tag: 'button', parent: dialog }, null]) for (const key of left) router.dispatch(press(key.code, key.modifiers).at(target === null ? null : element(target)));
    for (const key of left) router.dispatch(key.at(element(body)));
    router.dispatch(press('KeyS', { ctrlKey: true }).at(element({ tag: 'button', parent: dialog })));
    expect([left.map(touched), calls]).toEqual([[false, false, false], ['保存']]);
    openModal(false);
    router.dispatch(press('KeyZ', { ctrlKey: true }).at(element(body)));
    expect(calls).toEqual(['保存', '撤销']);
  });

  it('有弹窗或面板开着时页面就算被盖住了（灯光工作台的快捷键等着），都关了才不算', () => {
    const { router, openModal } = routed('lighting');
    expect(router.covered()).toBe(false);
    const leave = router.overlay(panel('面板', []));
    expect(router.covered()).toBe(true);
    leave();
    openModal(true);
    expect(router.covered()).toBe(true);
    openModal(false);
    expect(router.covered()).toBe(false);
  });
});

/* ---- playback-keys.test.ts, through the router ---- */

/** What the window's playback keys are told of the page, as useInternalPlayer told them. */
type PlaybackKeyContext = { paused: boolean; modalOpen: boolean; arrowKeys: boolean; song: (key: string) => string | undefined };
type PlaybackKeyAction = { kind: 'song'; itemId: string } | { kind: 'play-button' } | { kind: 'stop' } | { kind: 'skip'; direction: -1 | 1 };
type Player = { play(itemId: string): void; stop(): void; skip(direction: -1 | 1): void };

const keys = (overrides: Partial<PlaybackKeyContext> = {}): PlaybackKeyContext =>
  ({ paused: false, modalOpen: false, arrowKeys: true, song: (key: string) => key === 'Ctrl+Digit3' ? '第三首' : undefined, ...overrides });

let modalOpen = false;
/** The app's router: the pages' play buttons stay on it between presses, as on the window. */
const router = new KeyRouter(() => page(...(modalOpen ? [{ tag: 'dialog', modal: true }] : [])));

/** A page's play button, which Space presses while it is the latest on the page on screen (the home page here). */
function registerPlayButton(pressButton: () => void): () => void {
  return router.register('home', () => ({ 'transport.playPause': () => pressButton() }));
}

/** One press, with the window's playback keys wired to `player` as useInternalPlayer and LinkApp wire them. */
function handlePlaybackKey(key: Press, target: Fake | null, context: PlaybackKeyContext, player: Player): void {
  modalOpen = context.modalOpen;
  const done = [
    router.register('global', () => ({ 'transport.stop': () => player.stop(), 'transport.playPause': () => undefined })),
    router.register('global', () => ({ 'home.prevSong': () => player.skip(-1), 'home.nextSong': () => player.skip(1) }), () => context.arrowKeys),
    router.songShortcuts({ find: chord => context.song(chord), play: itemId => player.play(itemId) }),
    ...(context.paused ? [router.overlay({ open: () => true, close: () => undefined, contains: () => false, blocks: true })] : [])
  ];
  router.dispatch(key.at(target));
  for (const leave of done) leave();
  modalOpen = false;
}

/** What one press would do, read from which handler ran; the press itself is left as it was. */
function playbackKeyAction(key: Press, target: Fake | null, context: PlaybackKeyContext): PlaybackKeyAction | null {
  const copy = press(key.code, key.modifiers);
  if (key.defaultPrevented) copy.preventDefault();
  const calls: string[] = [];
  const leave = registerPlayButton(() => calls.push('播放按钮'));
  handlePlaybackKey(copy, target, context, recorder(calls));
  leave();
  const [call] = calls;
  if (call === undefined) return null;
  if (call === '停止') return { kind: 'stop' };
  if (call === '播放按钮') return { kind: 'play-button' };
  if (call.startsWith('换歌 ')) return { kind: 'skip', direction: call === '换歌 1' ? 1 : -1 };
  return { kind: 'song', itemId: call.slice('播放 '.length) };
}

/** Presses Space with nothing focused: the play button of the page on screen. */
function pressPlayButton(): void {
  handlePlaybackKey(press('Space'), element(body), keys(), recorder([]));
}

/** The player the window keys go to, writing down what they asked for. */
function recorder(calls: string[]): Player {
  return { play: (itemId: string) => { calls.push(`播放 ${itemId}`); }, stop: () => { calls.push('停止'); }, skip: (direction: -1 | 1) => { calls.push(`换歌 ${direction}`); } };
}

describe('窗口的播放键（原 playback-keys.test.ts）', () => {
  it('空格按的是当前页面的播放按钮，不再去播“上次那首”；按钮上和页面空白处都一样（0.5.9）', () => {
    expect(playbackKeyAction(press('Space'), element(body), keys())).toEqual({ kind: 'play-button' });
    expect(playbackKeyAction(press('Space'), element({ tag: 'button', parent: body }), keys())).toEqual({ kind: 'play-button' });
    expect(playbackKeyAction(press('Space'), null, keys())).toEqual({ kind: 'play-button' });
    expect(playbackKeyAction(press('Space'), element({ tag: 'input', parent: body }), keys())).toBeNull();
    // A song's own shortcut still plays that song.
    expect(playbackKeyAction(press('Digit3', { ctrlKey: true }), element(body), keys())).toEqual({ kind: 'song', itemId: '第三首' });

    const pressed: string[] = [];
    const leaveHome = registerPlayButton(() => pressed.push('首页'));
    pressPlayButton();
    const leaveEditor = registerPlayButton(() => pressed.push('编辑器'));
    leaveHome(); // the page left later than the new one came: it does not take the new page's button away
    pressPlayButton();
    leaveEditor();
    pressPlayButton(); // no page with a play button on screen: nothing happens
    expect(pressed).toEqual(['首页', '编辑器']);
  });

  it('设置页或设备连接页开着时，Esc、空格、方向键和单曲快捷键都不碰节目，Esc 只关页面（0.5.9）', () => {
    for (const key of [press('Escape'), press('Space'), press('ArrowDown'), press('ArrowUp'), press('Digit3', { ctrlKey: true })]) {
      expect(playbackKeyAction(key, element(body), keys({ paused: true }))).toBeNull();
    }
    expect(playbackKeyAction(press('Escape'), element(body), keys())).toEqual({ kind: 'stop' });
    expect(playbackKeyAction(press('ArrowDown'), element(body), keys())).toEqual({ kind: 'skip', direction: 1 });
    expect(playbackKeyAction(press('ArrowUp'), element(body), keys())).toEqual({ kind: 'skip', direction: -1 });
    expect(playbackKeyAction(press('ArrowDown'), element(body), keys({ arrowKeys: false }))).toBeNull();
    // The settings page closes on Escape and marks it handled, so a listener after it leaves the show alone too.
    const closed = press('Escape'); closed.preventDefault();
    expect(playbackKeyAction(closed, element(body), keys())).toBeNull();
  });

  /** Every key the window acts on: stop, the previous and next song, the play button and a song's own shortcut. */
  const windowKeys = () => [press('Escape'), press('ArrowDown'), press('ArrowUp'), press('Space'), press('Digit3', { ctrlKey: true })];

  it('对话框里按的键都归对话框：原生对话框（<dialog>，不写 role）、role="dialog" 和 role="alertdialog"，焦点在对话框本身或它的按钮上，Esc 不停节目、↑↓ 不换歌、空格和单曲快捷键不播放（演出中在「MTC 时间码状态」里点一下文字再按 Esc，节目停了）', () => {
    // ModalSurface and Dialog render a native <dialog> with no role; a click on its text puts the focus on the dialog itself.
    const native: Node = { tag: 'dialog', attributes: { class: 'modal-surface ui-dialog', open: '' }, parent: body, modal: true };
    const close: Node = { tag: 'button', attributes: { class: 'ui-icon-button' }, parent: { tag: 'header', parent: { tag: 'div', attributes: { class: 'ui-dialog-frame' }, parent: native } } };
    const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: body };
    const alert: Node = { tag: 'div', attributes: { role: 'alertdialog' }, parent: body };
    const calls: string[] = [];
    const leave = registerPlayButton(() => calls.push('播放按钮'));
    for (const target of [native, close, { tag: 'p', parent: native }, panel, { tag: 'div', parent: panel }, alert]) {
      for (const key of windowKeys()) {
        expect(playbackKeyAction(key, element(target), keys())).toBeNull();
        handlePlaybackKey(key, element(target), keys(), recorder(calls));
        // Left alone, so the dialog's own Escape closes it.
        expect(key.defaultPrevented).toBe(false);
      }
    }
    expect(calls).toEqual([]);
    leave();
  });

  it('模态对话框开着、焦点掉到了页面上（有焦点的按钮被移除或变灰）：Esc、↑↓、空格和单曲快捷键也都不碰节目，Esc 留给对话框关掉自己', () => {
    const calls: string[] = [];
    const leave = registerPlayButton(() => calls.push('播放按钮'));
    for (const target of [element(body), element({ tag: 'div', attributes: { class: 'home-card' }, parent: body }), null]) {
      for (const key of windowKeys()) {
        expect(playbackKeyAction(key, target, keys({ modalOpen: true }))).toBeNull();
        handlePlaybackKey(key, target, keys({ modalOpen: true }), recorder(calls));
        expect(key.defaultPrevented).toBe(false);
      }
    }
    expect(calls).toEqual([]);
    // Closed again: the keys work as before.
    const taken = windowKeys();
    for (const key of taken) handlePlaybackKey(key, element(body), keys(), recorder(calls));
    expect(calls).toEqual(['停止', '换歌 1', '换歌 -1', '播放按钮', '播放 第三首']);
    leave();
  });

  it('只有原生模态对话框开着才算“有对话框挡着”：按钮旁弹出的面板（role="dialog"，不是模态）、只是打开（show）的对话框都不算，空格照常播放/暂停', () => {
    const popover: Node = { tag: 'section', attributes: { role: 'dialog', 'aria-modal': 'false', class: 'ui-popover' } };
    const settings: Node = { tag: 'section', attributes: { role: 'dialog', 'aria-modal': 'false', class: 'connections-dialog' } };
    const shown: Node = { tag: 'dialog', attributes: { open: '' } };
    const modal: Node = { tag: 'dialog', attributes: { open: '', class: 'modal-surface' }, modal: true };
    expect(modalDialogOpen(page())).toBe(false);
    expect(modalDialogOpen(page(popover, settings, shown))).toBe(false);
    expect(modalDialogOpen(page(popover, modal))).toBe(true);
    // The focus on the page while a panel is open: Space plays and pauses, Escape stops.
    const context = keys({ modalOpen: modalDialogOpen(page(popover)) });
    expect(playbackKeyAction(press('Space'), element(body), context)).toEqual({ kind: 'play-button' });
    expect(playbackKeyAction(press('Escape'), element(body), context)).toEqual({ kind: 'stop' });
  });

  it('时间线里有焦点的工具栏、轨道和片段按钮上，空格是播放/暂停；时间线里的输入框、下拉框和弹出面板留给控件（0.5.9）', () => {
    const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' } };
    const toolbar: Node = { tag: 'div', attributes: { class: 'timeline-toolbar' }, parent: timeline };
    // The window leaves the timeline's keys to the timeline, which presses the same play button.
    for (const key of [press('Space'), press('Escape')]) expect(playbackKeyAction(key, element({ tag: 'button', parent: toolbar }), keys())).toBeNull();
  });

  it('按住不放的重复键和 Cmd 组合不碰节目', () => {
    const calls: string[] = [];
    const leave = registerPlayButton(() => calls.push('播放按钮'));
    // Held down, a key repeats its keydown. The window takes the repeats of its keys but acts once per press: a repeat
    // it left alone made the focused button take Space, and letting go pressed it, so holding Space after clicking
    // 「下一首」 paused the show and then jumped to the next song (0.5.9).
    const held = [press('Space', { repeat: true }), press('Escape', { repeat: true }), press('ArrowDown', { repeat: true }), press('Digit3', { ctrlKey: true, repeat: true })];
    for (const key of held) handlePlaybackKey(key, element(body), keys(), recorder(calls));
    const onButton = press('Space', { repeat: true });
    handlePlaybackKey(onButton, element({ tag: 'button', parent: body }), keys(), recorder(calls));
    expect([...held, onButton].map(key => key.defaultPrevented)).toEqual([true, true, true, true, true]);
    expect(calls).toEqual([]);

    const command = press('Escape', { metaKey: true });
    expect(playbackKeyAction(command, element(body), keys())).toBeNull();
    handlePlaybackKey(command, element(body), keys(), recorder(calls));
    expect(command.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    leave();
  });

  it('窗口的播放键都经同一个处理：单曲快捷键播那首，空格按当前页面的播放按钮，Esc 停止，↑↓ 换歌，键不再交给浏览器（0.5.9）', () => {
    const calls: string[] = [];
    const leave = registerPlayButton(() => calls.push('播放按钮'));
    const taken = [press('Digit3', { ctrlKey: true }), press('Space'), press('Escape'), press('ArrowUp'), press('ArrowDown')];
    for (const key of taken) handlePlaybackKey(key, element(body), keys(), recorder(calls));
    expect(taken.map(key => key.defaultPrevented)).toEqual([true, true, true, true, true]);
    expect(calls).toEqual(['播放 第三首', '播放按钮', '停止', '换歌 -1', '换歌 1']);
    // The settings page open, a field focused or the timeline focused: the key is left alone.
    const left = [press('Escape'), press('Space'), press('Space')];
    handlePlaybackKey(left[0]!, element(body), keys({ paused: true }), recorder(calls));
    handlePlaybackKey(left[1]!, element({ tag: 'input', parent: body }), keys(), recorder(calls));
    handlePlaybackKey(left[2]!, element({ tag: 'section', attributes: { class: 'reference-timeline' } }), keys(), recorder(calls));
    // Escape on the settings page closes the page (the router, K4), and only the page.
    expect(left.map(key => key.defaultPrevented)).toEqual([true, false, false]);
    expect(calls).toHaveLength(5);
    leave();
  });

  it('按住才起作用的控件（MA2 执行器的 Flash、Temp 键）自己用空格：空格按住闪灯，不当播放/暂停（0.5.8 回归）', () => {
    const flash: Node = { tag: 'button', attributes: { 'data-momentary': 'true' }, parent: body };
    const calls: string[] = [];
    const leave = registerPlayButton(() => calls.push('播放按钮'));
    const key = press('Space');
    handlePlaybackKey(key, element(flash), keys(), recorder(calls));
    expect(key.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    leave();
  });

  it('拖动或修剪时按 Esc 只取消这次拖动，键不再往下传，节目不停（0.5.9）', () => {
    let cancelled = 0;
    const escape = press('Escape');
    cancelDragOnEscape(escape, true, () => { cancelled += 1; });
    expect(cancelled).toBe(1);
    expect(escape.propagationStopped).toBe(true);
    // Even a window listener the stop did not keep out leaves the show alone.
    expect(playbackKeyAction(escape, element(body), keys())).toBeNull();

    // Not dragging: Escape goes on and stops as before. Other keys never cancel a drag.
    const idle = press('Escape');
    cancelDragOnEscape(idle, false, () => { cancelled += 1; });
    expect(idle.defaultPrevented || idle.propagationStopped).toBe(false);
    expect(playbackKeyAction(idle, element(body), keys())).toEqual({ kind: 'stop' });
    const enter = press('Enter');
    cancelDragOnEscape(enter, true, () => { cancelled += 1; });
    expect(enter.defaultPrevented || enter.propagationStopped).toBe(false);
    expect(cancelled).toBe(1);
  });

  it('拖动中路由先拿到 Esc 也不停节目，由拖动自己取消；手还按着时再按 Esc 也只被拿走；松手后 Esc 照常停止', () => {
    const view = fakeWindow();
    const calls: string[] = [];
    const uninstall = router.install(view);
    const done = [router.register('global', () => ({ 'transport.stop': () => { calls.push('停止'); } }))];
    const drawn: Array<string | null> = [];
    const drag = new DragSession<string>(view, value => drawn.push(value), router);
    const held = new Set<number>();
    const handle = { isConnected: true, setPointerCapture: (id: number) => { held.add(id); }, hasPointerCapture: (id: number) => held.has(id), contains: () => false };
    drag.begin(handle, 1, '片段 A');
    const escape = press('Escape').at(element(body));
    view.send(escape);
    expect([escape.defaultPrevented, escape.propagationStopped]).toEqual([true, true]);
    expect(drawn).toEqual(['片段 A', null]);
    const again = press('Escape').at(element(body));
    view.send(again);
    expect([again.defaultPrevented, again.propagationStopped]).toEqual([true, true]);
    expect(calls).toEqual([]);
    const release = new Event('pointerup');
    Object.defineProperty(release, 'pointerId', { value: 1 });
    Object.defineProperty(release, 'target', { value: null });
    held.clear();
    view.send(release);
    view.send(press('Escape').at(element(body)));
    expect(calls).toEqual(['停止']);
    for (const leave of done) leave();
    uninstall();
  });
});
