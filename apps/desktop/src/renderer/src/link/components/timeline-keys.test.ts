import { expect, it } from 'vitest';
import type { ShortcutBinding } from '../stores/shortcut-store';
import { handleLightingShortcut, handleTimelineKey, handleTimelineTransportKey, keysBackToTimeline, lightingTimelineKeyActs } from './timeline-keys';

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

/** An editing key: `code`, the `key` it types, and Ctrl when given. */
function edit(code: string, key: string, ctrlKey = false) {
  return { ...press(code), key, ctrlKey, altKey: false, metaKey: false };
}
/** Every key the timeline edits with or moves the playhead with, and its transport keys. */
const editingKeys = () => [edit('Delete', 'Delete'), edit('Backspace', 'Backspace'), edit('KeyS', 's'), edit('KeyM', 'm'), edit('Enter', 'Enter'),
  edit('KeyV', 'v', true), edit('KeyD', 'd', true), edit('KeyC', 'c', true), edit('KeyX', 'x', true), edit('KeyZ', 'z', true), edit('KeyA', 'a', true),
  edit('Home', 'Home'), edit('End', 'End'), edit('ArrowLeft', 'ArrowLeft'), edit('ArrowRight', 'ArrowRight'), edit('ArrowUp', 'ArrowUp'), edit('ArrowDown', 'ArrowDown'),
  edit('Escape', 'Escape'), edit('Space', ' ')];

/** 修改 Cue 卡点 as ModalSurface renders it inside the timeline: a native <dialog> with no role. */
const lanes: Node = { tag: 'div', attributes: { class: 'timeline-lanes' }, parent: timeline };
const cueDialog: Node = { tag: 'dialog', attributes: { class: 'modal-surface cue-point-dialog', open: '' }, parent: lanes };
const cueForm: Node = { tag: 'form', attributes: { class: 'effect-binding-form' }, parent: cueDialog };
const cueFooter: Node = { tag: 'footer', parent: cueForm };
const inDialog: Node[] = [cueDialog, cueForm, { tag: 'h3', parent: cueForm }, { tag: 'button', parent: cueFooter }, { tag: 'button', attributes: { type: 'submit' }, parent: cueFooter },
  { tag: 'input', attributes: { name: 'time' }, parent: { tag: 'label', parent: cueForm } },
  // A dialog drawn inside a clip still is a dialog.
  { tag: 'button', parent: { tag: 'dialog', attributes: { open: '' }, parent: { tag: 'button', attributes: { class: 'timeline-clip' }, parent: lanes } } },
  // The panels beside a toolbar button (Popover) are portaled to the page, and React still brings their keys to the timeline.
  { tag: 'section', attributes: { role: 'dialog', class: 'ui-popover' }, parent: { tag: 'body' } }, { tag: 'div', attributes: { role: 'alertdialog' }, parent: timeline }];
const clip: Node = { tag: 'button', attributes: { class: 'timeline-clip' }, parent: lanes };

/** The timeline writing down what its keys asked for; `modalOpen` as `modalDialogOpen` reads it. */
function timelinePage(calls: string[], modalOpen: boolean, lightingWorkspace = false) {
  return { ...page(calls, lightingWorkspace), modalOpen };
}

it('时间线里的原生对话框（<dialog>，不写 role）：焦点在对话框本身、它的按钮或输入框上，Delete、Backspace、s、Ctrl+V/D/C/X/Z、Home、End、方向键、M、Enter 都不碰对话框后面的时间线，键留给对话框', () => {
  for (const lighting of [false, true]) for (const target of inDialog) {
    for (const key of editingKeys()) {
      const calls: string[] = [];
      handleTimelineKey(key, element(target), timelinePage(calls, true, lighting), () => { calls.push(`编辑 ${key.key}`); });
      // A Popover is not modal; its keys are its own all the same.
      handleTimelineKey(key, element(target), timelinePage(calls, false, lighting), () => { calls.push(`编辑 ${key.key}`); });
      expect(calls).toEqual([]);
      expect([key.defaultPrevented, key.propagationStopped]).toEqual([false, false]);
    }
  }
});

it('模态对话框开着时，时间线不处理任何键；对话框一关，编辑键和 Esc、空格立刻照常可用', () => {
  for (const target of [clip, timeline, { tag: 'div', attributes: { class: 'track-heading' }, parent: timeline }]) {
    const calls: string[] = [];
    for (const key of editingKeys()) {
      handleTimelineKey(key, element(target), timelinePage(calls, true), () => { calls.push(`编辑 ${key.key}`); });
      expect(key.defaultPrevented).toBe(false);
    }
    expect(calls).toEqual([]);
  }
  // Closed: on a clip every editing key goes to the timeline, Escape stops and Space plays.
  const calls: string[] = [];
  for (const key of editingKeys()) handleTimelineKey(key, element(clip), timelinePage(calls, false), () => { calls.push(`编辑 ${key.key}`); });
  expect(calls).toEqual(['编辑 Delete', '编辑 Backspace', '编辑 s', '编辑 m', '编辑 Enter', '编辑 v', '编辑 d', '编辑 c', '编辑 x', '编辑 z', '编辑 a',
    '编辑 Home', '编辑 End', '编辑 ArrowLeft', '编辑 ArrowRight', '编辑 ArrowUp', '编辑 ArrowDown', '停止', '播放/暂停']);
  const bare: string[] = [];
  handleTimelineKey(edit('Delete', 'Delete'), element(timeline), timelinePage(bare, false), () => { bare.push('删除'); });
  handleTimelineKey(edit('Delete', 'Delete'), null, timelinePage(bare, false), () => { bare.push('删除'); });
  expect(bare).toEqual(['删除', '删除']);
});

it('时间线的编辑键让开工具栏按钮、输入框、下拉框和播放器，片段、Cue 和音频波形按钮上照常编辑（和原来一样）', () => {
  for (const target of [playButton, { tag: 'input', parent: toolbar }, { tag: 'select', parent: toolbar }, { tag: 'textarea', parent: heading }, { tag: 'audio', parent: timeline }]) {
    const calls: string[] = [];
    handleTimelineKey(edit('Delete', 'Delete'), element(target), timelinePage(calls, false), () => { calls.push('删除'); });
    expect(calls).toEqual([]);
  }
  for (const name of ['timeline-clip', 'timeline-cue', 'timeline-media-waveform']) {
    const calls: string[] = [];
    handleTimelineKey(edit('Delete', 'Delete'), element({ tag: 'button', attributes: { class: name }, parent: lanes }), timelinePage(calls, false), () => { calls.push('删除'); });
    expect(calls).toEqual(['删除']);
  }
});

it('灯光时间线的窗口键（M 打点、Delete/Backspace 删灯光点、Ctrl+A/C/X/V）：对话框里、或者模态对话框开着焦点掉到页面上时都不动作；关掉后照常', () => {
  const body: Node = { tag: 'body' };
  const mtc: Node = { tag: 'dialog', attributes: { class: 'modal-surface ui-dialog', open: '' }, parent: body };
  const close: Node = { tag: 'button', parent: { tag: 'header', parent: { tag: 'div', attributes: { class: 'ui-dialog-frame' }, parent: mtc } } };
  const panel: Node = { tag: 'section', attributes: { role: 'dialog', class: 'ui-popover' }, parent: body };
  for (const key of editingKeys()) {
    for (const target of [mtc, close, { tag: 'p', parent: mtc }, panel, { tag: 'button', parent: panel }, cueDialog, { tag: 'button', parent: cueFooter }]) {
      expect(lightingTimelineKeyActs(key, element(target), false)).toBe(false);
      expect(lightingTimelineKeyActs(key, element(target), true)).toBe(false);
    }
    expect(lightingTimelineKeyActs(key, element(body), true)).toBe(false);
    expect(lightingTimelineKeyActs(key, null, true)).toBe(false);
    // Closed again.
    expect(lightingTimelineKeyActs(key, element(body), false)).toBe(true);
    expect(lightingTimelineKeyActs(key, element(clip), false)).toBe(true);
    expect(lightingTimelineKeyActs(key, null, false)).toBe(true);
  }
  // As before: fields, held keys, Alt and keys already taken stay out.
  for (const target of [{ tag: 'input', parent: body }, { tag: 'textarea', parent: body }, { tag: 'select', parent: body }, { tag: 'div', attributes: { contenteditable: 'true' }, parent: body }]) {
    expect(lightingTimelineKeyActs(edit('Delete', 'Delete'), element(target), false)).toBe(false);
  }
  expect(lightingTimelineKeyActs({ ...edit('Delete', 'Delete'), repeat: true }, element(body), false)).toBe(false);
  expect(lightingTimelineKeyActs({ ...edit('Delete', 'Delete'), altKey: true }, element(body), false)).toBe(false);
  expect(lightingTimelineKeyActs({ ...edit('Delete', 'Delete'), defaultPrevented: true }, element(body), false)).toBe(false);
});
