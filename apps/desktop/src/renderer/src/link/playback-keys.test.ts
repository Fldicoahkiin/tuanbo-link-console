import { expect, it } from 'vitest';
import { cancelDragOnEscape, playbackKeyAction, pressPlayButton, registerPlayButton, spaceBelongsToControl } from './playback-keys';

type Node = { tag: string; attributes?: Record<string, string>; parent?: Node };
/** `closest` over a parent chain for the plain selectors the helpers use: a tag, `.class` or `[name="value"]`. */
function element(node: Node): { closest(selectors: string): Node | null } {
  const matches = (candidate: Node, selector: string): boolean => {
    const attribute = /^\[([a-z-]+)="([^"]+)"\]$/.exec(selector);
    if (attribute) return candidate.attributes?.[attribute[1]!] === attribute[2];
    if (selector.startsWith('.')) return candidate.attributes?.class?.split(' ').includes(selector.slice(1)) === true;
    return candidate.tag === selector;
  };
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
const keys = (overrides: Partial<{ paused: boolean; arrowKeys: boolean; song: (key: string) => string | undefined }> = {}) =>
  ({ paused: false, arrowKeys: true, song: (key: string) => key === 'Ctrl+Digit3' ? '第三首' : undefined, ...overrides });

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

it('按住不放的重复键和 Cmd 组合不碰节目', () => {
  const body: Node = { tag: 'body' };
  expect(playbackKeyAction(press('Space', { repeat: true }), element(body), keys())).toBeNull();
  expect(playbackKeyAction({ ...press('Escape'), metaKey: true }, element(body), keys())).toBeNull();
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
