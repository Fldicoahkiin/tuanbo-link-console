import { expect, it } from 'vitest';
import { cancelDragOnEscape, escapeClosesPanel, handlePlaybackKey, keyInDialog, modalDialogOpen, playbackKeyAction, pressPlayButton, registerPlayButton, spaceBelongsToControl, type PlaybackKeyContext } from './playback-keys';

/** An element; `modal` marks a native <dialog> opened with showModal(). */
type Node = { tag: string; attributes?: Record<string, string>; parent?: Node; modal?: boolean };
/** One of the plain selectors the helpers use: a tag, `.class`, `[name="value"]`, or `tag:modal`. */
const matches = (candidate: Node, selector: string): boolean => {
  const attribute = /^\[([a-z-]+)="([^"]+)"\]$/.exec(selector);
  if (attribute) return candidate.attributes?.[attribute[1]!] === attribute[2];
  if (selector.startsWith('.')) return candidate.attributes?.class?.split(' ').includes(selector.slice(1)) === true;
  const modal = /^([a-z]+):modal$/.exec(selector);
  if (modal) return candidate.tag === modal[1] && candidate.modal === true;
  if (!/^[a-z]+$/.test(selector)) throw new Error(`测试里的元素不认识这个选择器：${selector}`);
  return candidate.tag === selector;
};
/** `closest` over a parent chain. */
function element(node: Node): { closest(selectors: string): Node | null } {
  return { closest: (selectors: string) => {
    for (let current: Node | undefined = node; current; current = current.parent) {
      const candidate = current;
      if (selectors.split(',').some(selector => matches(candidate, selector))) return candidate;
    }
    return null;
  } };
}

/** A key press as the window sees it; `preventDefault` and `stopPropagation` leave a mark. */
function press(code: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; repeat?: boolean } = {}) {
  return { code, key: code === 'Space' ? ' ' : code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, ...modifiers,
    defaultPrevented: false, propagationStopped: false,
    preventDefault(): void { this.defaultPrevented = true; },
    stopPropagation(): void { this.propagationStopped = true; } };
}
const keys = (overrides: Partial<PlaybackKeyContext> = {}): PlaybackKeyContext =>
  ({ paused: false, modalOpen: false, arrowKeys: true, song: (key: string) => key === 'Ctrl+Digit3' ? '第三首' : undefined, ...overrides });

it('空格在按钮上也是播放/暂停；在输入框、下拉框、菜单和对话框里留给控件自己（2026-11-09 空格跳到下一首）', () => {
  const body: Node = { tag: 'body' }, dialog: Node = { tag: 'div', attributes: { role: 'dialog' }, parent: body }, menu: Node = { tag: 'div', attributes: { role: 'menu' }, parent: body };
  for (const node of [{ tag: 'button', parent: body }, { tag: 'div', attributes: { role: 'button' }, parent: body }, body]) expect(spaceBelongsToControl(element(node))).toBe(false);
  expect(spaceBelongsToControl(null)).toBe(false);
  for (const node of [{ tag: 'input', parent: body }, { tag: 'select', parent: body }, { tag: 'textarea', parent: body }, { tag: 'button', attributes: { role: 'menuitem' }, parent: menu },
    { tag: 'button', parent: dialog }, { tag: 'div', attributes: { contenteditable: 'true' }, parent: body }, { tag: 'div', attributes: { role: 'slider' }, parent: body }]) expect(spaceBelongsToControl(element(node))).toBe(true);
});

it('空格按的是当前页面的播放按钮，不再去播“上次那首”；按钮上和页面空白处都一样（0.5.9）', () => {
  const body: Node = { tag: 'body' };
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
  const body: Node = { tag: 'body' };
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
  const body: Node = { tag: 'body' };
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
  const body: Node = { tag: 'body' };
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
  /** The page as `querySelector` reads it: the first of `nodes` any of the selectors match. */
  const page = (...nodes: Node[]) => ({ querySelector: (selectors: string) => nodes.find(node => selectors.split(',').some(selector => matches(node, selector))) ?? null });
  const popover: Node = { tag: 'section', attributes: { role: 'dialog', 'aria-modal': 'false', class: 'ui-popover' } };
  const settings: Node = { tag: 'section', attributes: { role: 'dialog', 'aria-modal': 'false', class: 'connections-dialog' } };
  const shown: Node = { tag: 'dialog', attributes: { open: '' } };
  const modal: Node = { tag: 'dialog', attributes: { open: '', class: 'modal-surface' }, modal: true };
  expect(modalDialogOpen(page())).toBe(false);
  expect(modalDialogOpen(page(popover, settings, shown))).toBe(false);
  expect(modalDialogOpen(page(popover, modal))).toBe(true);
  // The focus on the page while a panel is open: Space plays and pauses, Escape stops.
  const body: Node = { tag: 'body' };
  const context = keys({ modalOpen: modalDialogOpen(page(popover)) });
  expect(playbackKeyAction(press('Space'), element(body), context)).toEqual({ kind: 'play-button' });
  expect(playbackKeyAction(press('Escape'), element(body), context)).toEqual({ kind: 'stop' });
});

it('时间线里有焦点的工具栏、轨道和片段按钮上，空格是播放/暂停；时间线里的输入框、下拉框和弹出面板留给控件（0.5.9）', () => {
  const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' } };
  const toolbar: Node = { tag: 'div', attributes: { class: 'timeline-toolbar' }, parent: timeline };
  const heading: Node = { tag: 'div', attributes: { class: 'track-heading' }, parent: timeline };
  const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: timeline };
  for (const node of [{ tag: 'button', parent: toolbar }, { tag: 'button', parent: heading }, { tag: 'button', attributes: { class: 'timeline-clip' }, parent: timeline }, timeline]) {
    expect(spaceBelongsToControl(element(node))).toBe(false);
  }
  for (const node of [{ tag: 'select', parent: toolbar }, { tag: 'input', parent: heading }, { tag: 'button', parent: panel }]) expect(spaceBelongsToControl(element(node))).toBe(true);
  // The window leaves the timeline's keys to the timeline, which presses the same play button.
  for (const key of [press('Space'), press('Escape')]) expect(playbackKeyAction(key, element({ tag: 'button', parent: toolbar }), keys())).toBeNull();
});

/** The player the window keys go to, writing down what they asked for. */
function recorder(calls: string[]) {
  return { play: (itemId: string) => { calls.push(`播放 ${itemId}`); }, stop: () => { calls.push('停止'); }, skip: (direction: -1 | 1) => { calls.push(`换歌 ${direction}`); } };
}

it('按住不放的重复键和 Cmd 组合不碰节目', () => {
  const body: Node = { tag: 'body' };
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

  const command = { ...press('Escape'), metaKey: true };
  expect(playbackKeyAction(command, element(body), keys())).toBeNull();
  handlePlaybackKey(command, element(body), keys(), recorder(calls));
  expect(command.defaultPrevented).toBe(false);
  expect(calls).toEqual([]);
  leave();
});

it('窗口的播放键都经同一个处理：单曲快捷键播那首，空格按当前页面的播放按钮，Esc 停止，↑↓ 换歌，键不再往下传（0.5.9）', () => {
  const body: Node = { tag: 'body' };
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
  expect(left.map(key => key.defaultPrevented)).toEqual([false, false, false]);
  expect(calls).toHaveLength(5);
  leave();
});

it('按住才起作用的控件（MA2 执行器的 Flash、Temp 键）自己用空格：空格按住闪灯，不当播放/暂停（0.5.8 回归）', () => {
  const body: Node = { tag: 'body' };
  const flash: Node = { tag: 'button', attributes: { 'data-momentary': 'true' }, parent: body };
  expect(spaceBelongsToControl(element(flash))).toBe(true);
  const calls: string[] = [];
  const leave = registerPlayButton(() => calls.push('播放按钮'));
  const key = press('Space');
  handlePlaybackKey(key, element(flash), keys(), recorder(calls));
  expect(key.defaultPrevented).toBe(false);
  expect(calls).toEqual([]);
  // A key pressed once, such as an executor's Go, is a plain button: Space plays and pauses there too.
  expect(spaceBelongsToControl(element({ tag: 'button', parent: body }))).toBe(false);
  leave();
});

it('拖动或修剪时按 Esc 只取消这次拖动，键不再往下传，节目不停（0.5.9）', () => {
  const body: Node = { tag: 'body' };
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

it('键归对话框只有一条规则（keyInDialog）：焦点在原生 <dialog>（不写 role）、role="dialog"、role="alertdialog" 里，或者有模态对话框开着；对话框一关就不再算', () => {
  const body: Node = { tag: 'body' };
  const native: Node = { tag: 'dialog', attributes: { class: 'modal-surface cue-point-dialog', open: '' }, parent: { tag: 'section', attributes: { class: 'reference-timeline' }, parent: body }, modal: true };
  for (const node of [native, { tag: 'button', parent: { tag: 'footer', parent: native } }, { tag: 'div', attributes: { role: 'dialog' }, parent: body }, { tag: 'div', attributes: { role: 'alertdialog' }, parent: body }]) {
    expect(keyInDialog(element(node), false)).toBe(true);
  }
  for (const target of [element(body), element({ tag: 'button', parent: body }), null]) {
    expect(keyInDialog(target, true)).toBe(true);
    expect(keyInDialog(target, false)).toBe(false);
  }
});

it('页面自己用 Esc 关的面板、详情和连接页（escapeClosesPanel）：模态对话框开着时让给对话框，Esc 先关对话框；关掉后照常', () => {
  const escape = () => ({ key: 'Escape', defaultPrevented: false });
  expect(escapeClosesPanel(escape(), true)).toBe(false);
  expect(escapeClosesPanel(escape(), false)).toBe(true);
  expect(escapeClosesPanel({ key: 'Escape', defaultPrevented: true }, false)).toBe(false);
  expect(escapeClosesPanel({ key: 'Enter', defaultPrevented: false }, false)).toBe(false);
});
