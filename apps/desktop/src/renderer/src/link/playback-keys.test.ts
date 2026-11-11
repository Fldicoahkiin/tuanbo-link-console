import { expect, it } from 'vitest';
import { keyInDialog, spaceBelongsToControl } from './playback-keys';

/*
 * The key helpers the panels, drags and timeline listeners still call. The window's playback keys moved onto the key
 * router (keys/key-router.ts, 04 设计 K3); their cases, which were here, are in keys/key-router.test.ts with the same
 * assertions.
 */

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

it('空格在按钮上也是播放/暂停；在输入框、下拉框、菜单和对话框里留给控件自己（2026-11-09 空格跳到下一首）', () => {
  const body: Node = { tag: 'body' }, dialog: Node = { tag: 'div', attributes: { role: 'dialog' }, parent: body }, menu: Node = { tag: 'div', attributes: { role: 'menu' }, parent: body };
  for (const node of [{ tag: 'button', parent: body }, { tag: 'div', attributes: { role: 'button' }, parent: body }, body]) expect(spaceBelongsToControl(element(node))).toBe(false);
  expect(spaceBelongsToControl(null)).toBe(false);
  for (const node of [{ tag: 'input', parent: body }, { tag: 'select', parent: body }, { tag: 'textarea', parent: body }, { tag: 'button', attributes: { role: 'menuitem' }, parent: menu },
    { tag: 'button', parent: dialog }, { tag: 'div', attributes: { contenteditable: 'true' }, parent: body }, { tag: 'div', attributes: { role: 'slider' }, parent: body }]) expect(spaceBelongsToControl(element(node))).toBe(true);
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
});

it('按住才起作用的控件（MA2 执行器的 Flash、Temp 键）自己用空格：空格按住闪灯，不当播放/暂停（0.5.8 回归）', () => {
  const body: Node = { tag: 'body' };
  const flash: Node = { tag: 'button', attributes: { 'data-momentary': 'true' }, parent: body };
  expect(spaceBelongsToControl(element(flash))).toBe(true);
  // A key pressed once, such as an executor's Go, is a plain button: Space plays and pauses there too.
  expect(spaceBelongsToControl(element({ tag: 'button', parent: body }))).toBe(false);
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
