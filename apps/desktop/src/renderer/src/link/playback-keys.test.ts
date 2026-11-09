import { expect, it } from 'vitest';
import { spaceBelongsToControl } from './playback-keys';

type Node = { tag: string; attributes?: Record<string, string>; parent?: Node };
/** `closest` over a parent chain for the plain selectors the helper uses: a tag, or `[name="value"]`. */
function element(node: Node): { closest(selectors: string): Node | null } {
  const matches = (candidate: Node, selector: string): boolean => {
    const attribute = /^\[([a-z-]+)="([^"]+)"\]$/.exec(selector);
    return attribute ? candidate.attributes?.[attribute[1]!] === attribute[2] : candidate.tag === selector;
  };
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
