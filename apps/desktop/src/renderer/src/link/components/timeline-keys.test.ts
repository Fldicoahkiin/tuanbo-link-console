import { expect, it } from 'vitest';
import type { ShortcutBinding } from '../stores/shortcut-store';
import { handleLightingShortcut, handleTimelineTransportKey, keysBackToTimeline } from './timeline-keys';

type Node = { tag: string; attributes?: Record<string, string>; parent?: Node };
type Fake = { node: Node; closest(selectors: string): Fake | null; getAttribute(name: string): string | null };

/** One selector of the kinds the key helpers use: `tag`, `.class`, `[name]`, `[name="value"]`, and a tag with either. */
function matches(candidate: Node, selector: string): boolean {
  const parts = /^([a-z]*)((?:\.[a-z-]+)*)((?:\[[a-z-]+(?:="[^"]*")?\])*)$/.exec(selector.trim());
  if (!parts) throw new Error(`测试里的元素不认识这个选择器：${selector}`);
  const [, tag = '', classes = '', attributes = ''] = parts;
  if (tag && candidate.tag !== tag) return false;
  if (classes.split('.').filter(Boolean).some(name => !candidate.attributes?.class?.split(' ').includes(name))) return false;
  return [...attributes.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)].every(([, name = '', value]) => {
    const actual = candidate.attributes?.[name];
    return actual !== undefined && (value === undefined || actual === value);
  });
}
/** A focused or clicked element, with `closest` over its parent chain. */
function element(node: Node): Fake {
  return {
    node,
    closest: (selectors: string) => {
      for (let current: Node | undefined = node; current; current = current.parent) {
        const candidate = current;
        if (selectors.split(',').some(selector => matches(candidate, selector))) return element(candidate);
      }
      return null;
    },
    getAttribute: (name: string) => node.attributes?.[name] ?? null
  };
}
const within = (node: Node, ancestor: Node): boolean => node === ancestor || (node.parent !== undefined && within(node.parent, ancestor));

/** A key press; the calls on it leave marks. */
function press(code: string, init: { repeat?: boolean } = {}) {
  return { code, key: code === 'Space' ? ' ' : code, repeat: init.repeat === true, defaultPrevented: false, propagationStopped: false, immediatePropagationStopped: false,
    preventDefault(): void { this.defaultPrevented = true; },
    stopPropagation(): void { this.propagationStopped = true; },
    stopImmediatePropagation(): void { this.immediatePropagationStopped = true; this.propagationStopped = true; } };
}

const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' } };
const toolbar: Node = { tag: 'div', attributes: { class: 'timeline-toolbar' }, parent: timeline };
const heading: Node = { tag: 'div', attributes: { class: 'track-heading' }, parent: timeline };
const playButton: Node = { tag: 'button', attributes: { class: 'timeline-play-button' }, parent: toolbar };
const dock: Node = { tag: 'aside', attributes: { class: 'lighting-effect-dock' } };

/** The editor's or lighting workbench's timeline, writing down what its keys asked for. */
function page(calls: string[], lightingWorkspace = false, stop = true) {
  return { lightingWorkspace, stop: stop ? () => { calls.push('停止'); } : undefined, playPause: () => { calls.push('播放/暂停'); } };
}

it('编辑器时间线里焦点在工具栏、轨道标题或片段按钮上时，空格是播放/暂停，不再交给按钮；按住只算一次（0.5.9）', () => {
  for (const target of [playButton, { tag: 'button', parent: heading }, { tag: 'button', attributes: { class: 'timeline-clip' }, parent: timeline }, timeline]) {
    const calls: string[] = [];
    const key = press('Space'), held = press('Space', { repeat: true });
    expect(handleTimelineTransportKey(key, element(target), page(calls))).toBe(true);
    expect(handleTimelineTransportKey(held, element(target), page(calls))).toBe(true);
    expect([key.defaultPrevented, held.defaultPrevented]).toEqual([true, true]);
    expect(calls).toEqual(['播放/暂停']);
  }
  // Fields, lists and the panels opened from the toolbar keep Space; the lighting workbench takes it with its shortcut keys first.
  const calls: string[] = [];
  const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: timeline };
  for (const [target, lighting] of [[{ tag: 'select', parent: toolbar }, false], [{ tag: 'input', parent: heading }, false], [{ tag: 'button', parent: panel }, false], [playButton, true]] as const) {
    const key = press('Space');
    expect(handleTimelineTransportKey(key, element(target), page(calls, lighting))).toBe(false);
    expect(key.defaultPrevented).toBe(false);
  }
  expect(calls).toEqual([]);
});

it('时间线里 Esc 停止节目，键不再往下传，按住只停一次；打开的菜单、面板和输入框里的 Esc 留给它们（0.5.9）', () => {
  const calls: string[] = [];
  const key = press('Escape'), held = press('Escape', { repeat: true });
  expect(handleTimelineTransportKey(key, element(playButton), page(calls))).toBe(true);
  expect(handleTimelineTransportKey(held, element(playButton), page(calls))).toBe(true);
  expect([key.defaultPrevented, key.propagationStopped, held.defaultPrevented, held.propagationStopped]).toEqual([true, true, true, true]);
  expect(handleTimelineTransportKey(press('Escape'), element(timeline), page(calls, true))).toBe(true);
  expect(calls).toEqual(['停止', '停止']);

  const opened: Node = { tag: 'button', attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'true' }, parent: toolbar };
  const details: Node = { tag: 'details', attributes: { open: '' }, parent: timeline };
  for (const [target, stop] of [[opened, true], [{ tag: 'summary', parent: details }, true], [{ tag: 'input', parent: heading }, true], [{ tag: 'div', attributes: { role: 'dialog' }, parent: timeline }, true], [timeline, false]] as const) {
    const left = press('Escape');
    expect(handleTimelineTransportKey(left, element(target), page(calls, false, stop))).toBe(false);
    expect(left.defaultPrevented || left.propagationStopped).toBe(false);
  }
  expect(handleTimelineTransportKey(press('Escape'), null, page(calls))).toBe(false);
  expect(calls).toEqual(['停止', '停止']);
});

it('时间线里的原生对话框（<dialog>，不写 role：修改 Cue 卡点、编辑歌曲段落、编辑音频片段）：焦点在对话框本身、在「取消」「保存卡点」上按 Esc 都只关对话框，节目不停；空格也归对话框（演出中关「修改 Cue 卡点」停了节目）', () => {
  const calls: string[] = [];
  const dialog: Node = { tag: 'dialog', attributes: { class: 'modal-surface cue-point-dialog', 'aria-label': '修改 Cue 卡点', open: '' }, parent: timeline };
  const footer: Node = { tag: 'footer', parent: { tag: 'form', attributes: { class: 'effect-binding-form' }, parent: dialog } };
  const cancel: Node = { tag: 'button', attributes: { type: 'button' }, parent: footer }, save: Node = { tag: 'button', parent: footer };
  // Mounted on the page body by a component in the timeline (createPortal): its keys still come through the timeline.
  const mounted: Node = { tag: 'dialog', attributes: { class: 'lighting-attribute-dialog', open: '' }, parent: { tag: 'body' } };
  const alert: Node = { tag: 'div', attributes: { role: 'alertdialog' }, parent: timeline };
  for (const target of [dialog, cancel, save, mounted, { tag: 'button', parent: mounted }, alert]) {
    for (const lighting of [true, false]) {
      const escape = press('Escape'), space = press('Space');
      expect(handleTimelineTransportKey(escape, element(target), page(calls, lighting))).toBe(false);
      expect(handleTimelineTransportKey(space, element(target), page(calls, lighting))).toBe(false);
      expect([escape.defaultPrevented, escape.propagationStopped, space.defaultPrevented]).toEqual([false, false, false]);
    }
    const play = press('Space');
    handleLightingShortcut(play, element(target), shortcut('play'), () => calls.push('播放/暂停'));
    expect(play.defaultPrevented || play.immediatePropagationStopped).toBe(false);
  }
  expect(calls).toEqual([]);
  // Out of the dialog, Escape on the timeline stops the show as before.
  expect(handleTimelineTransportKey(press('Escape'), element(timeline), page(calls, true))).toBe(true);
  expect(handleTimelineTransportKey(press('Escape'), element(playButton), page(calls))).toBe(true);
  expect(calls).toEqual(['停止', '停止']);
});

type Action = ShortcutBinding['action'];
const shortcut = (action: Action | undefined, covered = false) => ({ action, covered: () => covered });

it('灯光工作台的快捷键：播放键在按钮上也是播放/暂停，打点和逐帧让开按钮；按住只算一次，键不再往下传（0.5.9）', () => {
  const runs: Action[] = [];
  for (const target of [playButton, { tag: 'button', parent: dock }, timeline]) {
    const key = press('Space'), held = press('Space', { repeat: true });
    handleLightingShortcut(key, element(target), shortcut('play'), action => runs.push(action));
    handleLightingShortcut(held, element(target), shortcut('play'), action => runs.push(action));
    expect([key.defaultPrevented, key.immediatePropagationStopped, held.defaultPrevented, held.immediatePropagationStopped]).toEqual([true, true, true, true]);
  }
  expect(runs).toEqual(['play', 'play', 'play']);

  const onButton = press('KeyM'), onTimeline = press('KeyM'), heldStamp = press('KeyM', { repeat: true });
  handleLightingShortcut(onButton, element(playButton), shortcut('stamp'), action => runs.push(action));
  handleLightingShortcut(onTimeline, element(timeline), shortcut('stamp'), action => runs.push(action));
  handleLightingShortcut(heldStamp, element(timeline), shortcut('stamp'), action => runs.push(action));
  expect([onButton.defaultPrevented, onTimeline.defaultPrevented, heldStamp.defaultPrevented]).toEqual([false, true, true]);
  expect(runs).toEqual(['play', 'play', 'play', 'stamp']);

  // A dialog or the settings page over the workbench, a key without a shortcut, a field and the Cue pool keep their keys.
  const pool: Node = { tag: 'div', attributes: { class: 'cue-pool-grid' }, parent: dock };
  const left = [press('Space'), press('Space'), press('Space'), press('Space')];
  handleLightingShortcut(left[0]!, element(timeline), shortcut('play', true), action => runs.push(action));
  handleLightingShortcut(left[1]!, element(timeline), shortcut(undefined), action => runs.push(action));
  handleLightingShortcut(left[2]!, element({ tag: 'input', parent: dock }), shortcut('play'), action => runs.push(action));
  handleLightingShortcut(left[3]!, element({ tag: 'button', parent: pool }), shortcut('play'), action => runs.push(action));
  expect(left.map(key => key.defaultPrevented || key.immediatePropagationStopped)).toEqual([false, false, false, false]);
  const handled = press('Space'); handled.preventDefault();
  handleLightingShortcut(handled, element(timeline), shortcut('play'), action => runs.push(action));
  expect(handled.immediatePropagationStopped).toBe(false);
  expect(runs).toHaveLength(4);
});

it('灯光工作台里 MA2 执行器的 Flash、Temp 键自己用空格：按住闪灯，不当播放/暂停（0.5.8 回归）', () => {
  const flash: Node = { tag: 'button', attributes: { 'data-momentary': 'true' }, parent: dock };
  const runs: Action[] = [];
  for (const key of [press('Space'), press('Space', { repeat: true })]) {
    handleLightingShortcut(key, element(flash), shortcut('play'), action => runs.push(action));
    expect([key.defaultPrevented, key.immediatePropagationStopped]).toEqual([false, false]);
  }
  expect(runs).toEqual([]);
});

it('鼠标点完时间线工具栏上的按钮，键交还给时间线，M、←、→ 照常可用；键盘按的、正要打开菜单或面板的按钮留住焦点（0.5.9）', () => {
  const bar = { contains: (button: Fake) => within(button.node, toolbar) };
  const modes: Node = { tag: 'div', attributes: { role: 'group' }, parent: toolbar };
  const select: Node = { tag: 'button', attributes: { 'aria-pressed': 'true' }, parent: modes };
  const record: Node = { tag: 'button', attributes: { class: 'timeline-record-button' }, parent: toolbar };
  for (const node of [playButton, { tag: 'svg', parent: playButton }, select, record]) expect(keysBackToTimeline({ detail: 1, target: element(node) }, bar)).toBe(true);
  // Pressed from the keyboard: the focus stays on the button.
  expect(keysBackToTimeline({ detail: 0, target: element(playButton) }, bar)).toBe(false);
  // A menu or panel button: opening it leaves the keys to the menu or panel, closing it gives them back.
  const menu: Node = { tag: 'button', attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, parent: toolbar };
  const panel: Node = { tag: 'button', attributes: { 'aria-haspopup': 'dialog', 'aria-expanded': 'true' }, parent: toolbar };
  expect(keysBackToTimeline({ detail: 1, target: element(menu) }, bar)).toBe(false);
  expect(keysBackToTimeline({ detail: 1, target: element(panel) }, bar)).toBe(true);
  // Clicks in a menu or panel the toolbar opened (mounted on the page body), and on what is not a button.
  const item: Node = { tag: 'button', attributes: { role: 'menuitem' }, parent: { tag: 'body' } };
  for (const target of [element(item), element({ tag: 'select', parent: toolbar }), null]) expect(keysBackToTimeline({ detail: 1, target }, bar)).toBe(false);
});
