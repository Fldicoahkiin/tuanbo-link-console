import { describe, expect, it } from 'vitest';
import { editsText, HOME_OWN_KEYS, keyInTimeline, keyOwner, ownKeys, windowKeepsKey } from './key-owner';
import { routeKey, type RouteDecision, type RouteInput } from './key-route';
import { KEYMAP, type CommandId, type KeyPage, type KeyScope } from './keymap';

/*
 * The cases of playback-keys.test.ts and timeline-keys.test.ts, one by one, asked of `routeKey`: what a key does where
 * the focus is, with the same result. Those files still test the listeners that act today; these say the same of the
 * one routing function the listeners give way to (04 设计 K2). Each `it` names the case it is written from.
 */

type Node = { tag: string; attributes?: Record<string, string>; parent?: Node };
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
/** A focused element, with `closest` over its parent chain. */
function element(node: Node): Fake {
  return {
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

type Handlers = (id: CommandId, scope: KeyScope) => boolean;
/** Handlers there for the given `scope id` pairs only. */
const only = (...pairs: string[]): Handlers => (id, scope) => pairs.includes(`${scope} ${id}`);
/** The window's playback keys and the project's keys: 联动台播放 with a player, ↑↓ change songs. */
const windowHandlers: Handlers = (_id, scope) => scope === 'global';
/**
 * The editor's or lighting workbench's timeline with a song open, no lighting point selected, the focus not in the
 * lighting workbench's Cue points (whose Delete and Escape take the key only there, K6).
 */
const timelineHandlers: Handlers = (id, scope) => scope !== 'lighting-points' && !(scope === 'lighting' && (id === 'edit.delete' || id === 'edit.deselect'));

type Where = { page?: KeyPage; repeat?: boolean; modalOpen?: boolean; overlays?: RouteInput['overlays']; drag?: RouteInput['drag'];
  available?: Handlers; song?: RouteInput['song']; keymap?: RouteInput['keymap'] };
/** `routeKey` for `chord` pressed with the focus on `node` (null: nowhere). */
function route(node: Node | null, chord: string, where: Where = {}): RouteDecision {
  const target = node === null ? null : element(node);
  return routeKey({ chord, repeat: where.repeat ?? false, composing: false, owner: keyOwner(target, chord), inTimeline: keyInTimeline(target),
    windowKeeps: windowKeepsKey(target, chord), editingText: editsText(target),
    modalOpen: where.modalOpen ?? false, overlays: where.overlays ?? [], drag: where.drag ?? 'none', page: where.page ?? 'project',
    available: where.available ?? windowHandlers, song: where.song ?? (key => key === 'Ctrl+Digit3' ? '第三首' : undefined), ...(where.keymap ? { keymap: where.keymap } : {}) });
}
const run = (id: CommandId, scope: KeyScope): RouteDecision => ({ kind: 'run', id, scope });
const NATIVE: RouteDecision = { kind: 'native' }, IGNORE: RouteDecision = { kind: 'ignore' }, SWALLOW: RouteDecision = { kind: 'swallow' };
/** Nobody on the page acted: left to the browser or to the element. */
const untouched = (decision: RouteDecision): boolean => decision.kind === 'native' || decision.kind === 'ignore';
/** Every key the window acts on: stop, the previous and next song, the play button and a song's own shortcut. */
const windowKeys = ['Escape', 'ArrowDown', 'ArrowUp', 'Space', 'Ctrl+Digit3'];

const body: Node = { tag: 'body' };

describe('窗口的播放键（playback-keys.test.ts 的用例）', () => {
  it('空格在按钮上也是播放/暂停；在输入框、下拉框、菜单和对话框里留给控件自己（2026-11-09 空格跳到下一首）', () => {
    const dialog: Node = { tag: 'div', attributes: { role: 'dialog' }, parent: body }, menu: Node = { tag: 'div', attributes: { role: 'menu' }, parent: body };
    for (const node of [{ tag: 'button', parent: body }, { tag: 'div', attributes: { role: 'button' }, parent: body }, body, null]) {
      expect(route(node, 'Space')).toEqual(run('transport.playPause', 'global'));
    }
    for (const node of [{ tag: 'input', parent: body }, { tag: 'select', parent: body }, { tag: 'textarea', parent: body }, { tag: 'button', attributes: { role: 'menuitem' }, parent: menu },
      { tag: 'button', parent: dialog }, { tag: 'div', attributes: { contenteditable: 'true' }, parent: body }, { tag: 'div', attributes: { role: 'slider' }, parent: body }]) {
      expect(route(node, 'Space')).toEqual(NATIVE);
    }
  });

  it('空格按的是当前页面的播放按钮，不再去播“上次那首”；按钮上和页面空白处都一样（0.5.9）', () => {
    for (const node of [body, { tag: 'button', parent: body }, null]) expect(route(node, 'Space')).toEqual(run('transport.playPause', 'global'));
    expect(route({ tag: 'input', parent: body }, 'Space')).toEqual(NATIVE);
    // A song's own shortcut still plays that song.
    expect(route(body, 'Ctrl+Digit3')).toEqual({ kind: 'song', itemId: '第三首' });
  });

  it('设置页或设备连接页开着时，Esc、空格、方向键和单曲快捷键都不碰节目，Esc 只关页面（0.5.9）', () => {
    const settings = [{ focusInside: false, blocks: true }];
    expect(route(body, 'Escape', { overlays: settings })).toEqual({ kind: 'overlay' });
    for (const chord of ['Space', 'ArrowDown', 'ArrowUp', 'Ctrl+Digit3']) expect(route(body, chord, { overlays: settings })).toEqual(NATIVE);
    expect(route(body, 'Escape')).toEqual(run('transport.stop', 'global'));
    expect(route(body, 'ArrowDown')).toEqual(run('home.nextSong', 'global'));
    expect(route(body, 'ArrowUp')).toEqual(run('home.prevSong', 'global'));
    // ↑↓ change songs only when that is turned on.
    expect(route(body, 'ArrowDown', { available: (id, scope) => scope === 'global' && id !== 'home.nextSong' })).toEqual(IGNORE);
  });

  it('对话框里按的键都归对话框：原生对话框（<dialog>，不写 role）、role="dialog" 和 role="alertdialog"，焦点在对话框本身或它的按钮上，Esc 不停节目、↑↓ 不换歌、空格和单曲快捷键不播放', () => {
    const native: Node = { tag: 'dialog', attributes: { class: 'modal-surface ui-dialog', open: '' }, parent: body };
    const close: Node = { tag: 'button', attributes: { class: 'ui-icon-button' }, parent: { tag: 'header', parent: { tag: 'div', attributes: { class: 'ui-dialog-frame' }, parent: native } } };
    const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: body };
    const alert: Node = { tag: 'div', attributes: { role: 'alertdialog' }, parent: body };
    for (const target of [native, close, { tag: 'p', parent: native }, panel, { tag: 'div', parent: panel }, alert]) {
      for (const chord of windowKeys) expect(route(target, chord, { modalOpen: target !== panel && target !== alert })).toEqual(NATIVE);
    }
  });

  it('模态对话框开着、焦点掉到了页面上：Esc、↑↓、空格和单曲快捷键也都不碰节目，Esc 留给对话框关掉自己；关掉后照常', () => {
    for (const target of [body, { tag: 'div', attributes: { class: 'home-card' }, parent: body }, null]) {
      for (const chord of windowKeys) expect(route(target, chord, { modalOpen: true })).toEqual(NATIVE);
    }
    expect(windowKeys.map(chord => route(body, chord))).toEqual([run('transport.stop', 'global'), run('home.nextSong', 'global'), run('home.prevSong', 'global'),
      run('transport.playPause', 'global'), { kind: 'song', itemId: '第三首' }]);
  });

  it('只有原生模态对话框开着才算“有对话框挡着”：按钮旁弹出的面板不是模态，焦点在页面上时空格照常播放/暂停、Esc 停止', () => {
    expect(route(body, 'Space')).toEqual(run('transport.playPause', 'global'));
    expect(route(body, 'Escape')).toEqual(run('transport.stop', 'global'));
  });

  it('时间线里有焦点的工具栏、轨道和片段按钮上，空格是播放/暂停；时间线里的输入框、下拉框和弹出面板留给控件；窗口把时间线的键留给时间线（0.5.9）', () => {
    const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' } };
    const toolbar: Node = { tag: 'div', attributes: { class: 'timeline-toolbar' }, parent: timeline };
    const heading: Node = { tag: 'div', attributes: { class: 'track-heading' }, parent: timeline };
    const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: timeline };
    const editor = { page: 'cues' as const, available: timelineHandlers };
    for (const node of [{ tag: 'button', parent: toolbar }, { tag: 'button', parent: heading }, { tag: 'button', attributes: { class: 'timeline-clip' }, parent: timeline }, timeline]) {
      expect(route(node, 'Space', editor)).toEqual(run('transport.playPause', 'editor'));
    }
    for (const node of [{ tag: 'select', parent: toolbar }, { tag: 'input', parent: heading }, { tag: 'button', parent: panel }]) expect(route(node, 'Space', editor)).toEqual(NATIVE);
    // The timeline's own play button and stop, never the window's.
    expect(route({ tag: 'button', parent: toolbar }, 'Escape', editor)).toEqual(run('transport.stop', 'timeline'));
    for (const chord of ['Space', 'Escape']) expect(route({ tag: 'button', parent: toolbar }, chord, { page: 'cues', available: windowHandlers })).toEqual(NATIVE);
  });

  it('按住不放的重复键和 Cmd 组合不碰节目：重复的键拿走但不再做事', () => {
    for (const chord of ['Space', 'Escape', 'ArrowDown', 'Ctrl+Digit3']) expect(route(body, chord, { repeat: true })).toEqual(SWALLOW);
    expect(route({ tag: 'button', parent: body }, 'Space', { repeat: true })).toEqual(SWALLOW);
    expect(route(body, 'Meta+Escape')).toEqual(IGNORE);
  });

  it('窗口的播放键都经同一个处理：单曲快捷键播那首，空格按当前页面的播放按钮，Esc 停止，↑↓ 换歌；设置页、输入框、时间线里不归窗口（0.5.9）', () => {
    expect(['Ctrl+Digit3', 'Space', 'Escape', 'ArrowUp', 'ArrowDown'].map(chord => route(body, chord))).toEqual([{ kind: 'song', itemId: '第三首' },
      run('transport.playPause', 'global'), run('transport.stop', 'global'), run('home.prevSong', 'global'), run('home.nextSong', 'global')]);
    expect(route(body, 'Escape', { overlays: [{ focusInside: false, blocks: true }] })).toEqual({ kind: 'overlay' });
    expect(route({ tag: 'input', parent: body }, 'Space')).toEqual(NATIVE);
    expect(route({ tag: 'section', attributes: { class: 'reference-timeline' } }, 'Space')).toEqual(IGNORE);
  });

  it('按住才起作用的控件（MA2 执行器的 Flash、Temp 键）自己用空格：不当播放/暂停（0.5.8 回归）；按一下的 Go 键是普通按钮，空格照常播放', () => {
    expect(route({ tag: 'button', attributes: { 'data-momentary': 'true' }, parent: body }, 'Space')).toEqual(NATIVE);
    expect(route({ tag: 'button', parent: body }, 'Space')).toEqual(run('transport.playPause', 'global'));
  });

  it('拖动或修剪时按 Esc 只取消这次拖动，节目不停；取消后手还按着再按 Esc 也不停；不拖动时 Esc 照常停止，别的键不取消拖动（0.5.9）', () => {
    expect(route(body, 'Escape', { drag: 'active' })).toEqual({ kind: 'drag-cancel' });
    expect(route(body, 'Escape', { drag: 'cancelled' })).toEqual(SWALLOW);
    expect(route(body, 'Escape')).toEqual(run('transport.stop', 'global'));
    expect(route(body, 'Enter', { drag: 'active' })).toEqual(IGNORE);
  });

  it('键归对话框只有一条规则：焦点在原生 <dialog>、role="dialog"、role="alertdialog" 里，或者有模态对话框开着；对话框一关就不再算', () => {
    const native: Node = { tag: 'dialog', attributes: { class: 'modal-surface cue-point-dialog', open: '' }, parent: { tag: 'section', attributes: { class: 'reference-timeline' }, parent: body } };
    for (const node of [native, { tag: 'button', parent: { tag: 'footer', parent: native } }, { tag: 'div', attributes: { role: 'dialog' }, parent: body }, { tag: 'div', attributes: { role: 'alertdialog' }, parent: body }]) {
      expect(route(node, 'Escape', { page: 'cues', available: timelineHandlers })).toEqual(NATIVE);
    }
    for (const target of [body, { tag: 'button', parent: body }, null]) expect(route(target, 'Space', { modalOpen: true })).toEqual(NATIVE);
    for (const target of [body, null]) expect(route(target, 'Escape')).toEqual(run('transport.stop', 'global'));
  });

  it('页面自己用 Esc 关的面板、详情和连接页：模态对话框开着时让给对话框，Esc 先关对话框；关掉后照常关面板', () => {
    const panel = [{ focusInside: false, blocks: false }];
    expect(route(body, 'Escape', { overlays: panel, modalOpen: true })).toEqual(NATIVE);
    expect(route(body, 'Escape', { overlays: panel })).toEqual({ kind: 'overlay' });
    expect(route(body, 'Enter', { overlays: panel })).toEqual(IGNORE);
  });
});

const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' } };
const toolbar: Node = { tag: 'div', attributes: { class: 'timeline-toolbar' }, parent: timeline };
const heading: Node = { tag: 'div', attributes: { class: 'track-heading' }, parent: timeline };
const playButton: Node = { tag: 'button', attributes: { class: 'timeline-play-button' }, parent: toolbar };
const dock: Node = { tag: 'aside', attributes: { class: 'lighting-effect-dock' } };
const lanes: Node = { tag: 'div', attributes: { class: 'timeline-lanes' }, parent: timeline };
const clip: Node = { tag: 'button', attributes: { class: 'timeline-clip' }, parent: lanes };
const editor = { page: 'cues' as const, available: timelineHandlers };
const workbench = { page: 'lighting' as const, available: timelineHandlers };

describe('时间线的键（timeline-keys.test.ts 的用例）', () => {
  it('编辑器时间线里焦点在工具栏、轨道标题或片段按钮上时，空格是播放/暂停；按住只算一次；输入框、下拉框和面板留给控件，灯光工作台由它的快捷键先拿（0.5.9）', () => {
    for (const target of [playButton, { tag: 'button', parent: heading }, clip, timeline]) {
      expect(route(target, 'Space', editor)).toEqual(run('transport.playPause', 'editor'));
      expect(route(target, 'Space', { ...editor, repeat: true })).toEqual(SWALLOW);
    }
    const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: timeline };
    for (const target of [{ tag: 'select', parent: toolbar }, { tag: 'input', parent: heading }, { tag: 'button', parent: panel }]) expect(route(target, 'Space', editor)).toEqual(NATIVE);
    expect(route(playButton, 'Space', workbench)).toEqual(run('transport.playPause', 'lighting'));
  });

  it('时间线里 Esc 停止节目，按住只停一次；打开的菜单、面板和输入框里的 Esc 留给它们；没有停止可做时时间线不拿（0.5.9）', () => {
    expect(route(playButton, 'Escape', editor)).toEqual(run('transport.stop', 'timeline'));
    expect(route(playButton, 'Escape', { ...editor, repeat: true })).toEqual(SWALLOW);
    expect(route(timeline, 'Escape', workbench)).toEqual(run('transport.stop', 'timeline'));
    const opened: Node = { tag: 'button', attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'true' }, parent: toolbar };
    const details: Node = { tag: 'details', attributes: { open: '' }, parent: timeline };
    for (const target of [opened, { tag: 'summary', parent: details }, { tag: 'input', parent: heading }, { tag: 'div', attributes: { role: 'dialog' }, parent: timeline }]) {
      expect(route(target, 'Escape', editor)).toEqual(NATIVE);
    }
    expect(untouched(route(timeline, 'Escape', { page: 'cues', available: only() }))).toBe(true);
    // The focus nowhere is not the timeline: the window's stop, not the timeline's.
    expect(route(null, 'Escape', { page: 'cues', available: (_id, scope) => scope !== 'timeline' })).toEqual(run('transport.stop', 'global'));
  });

  it('时间线里的原生对话框（修改 Cue 卡点、编辑歌曲段落、编辑音频片段）：焦点在对话框本身、在「取消」「保存卡点」上，Esc、空格都归对话框，灯光工作台的播放键也不拿；对话框外照常停止', () => {
    const dialog: Node = { tag: 'dialog', attributes: { class: 'modal-surface cue-point-dialog', 'aria-label': '修改 Cue 卡点', open: '' }, parent: timeline };
    const footer: Node = { tag: 'footer', parent: { tag: 'form', attributes: { class: 'effect-binding-form' }, parent: dialog } };
    const mounted: Node = { tag: 'dialog', attributes: { class: 'lighting-attribute-dialog', open: '' }, parent: { tag: 'body' } };
    const alert: Node = { tag: 'div', attributes: { role: 'alertdialog' }, parent: timeline };
    for (const target of [dialog, { tag: 'button', attributes: { type: 'button' }, parent: footer }, { tag: 'button', parent: footer }, mounted, { tag: 'button', parent: mounted }, alert]) {
      for (const page of [editor, workbench]) for (const chord of ['Escape', 'Space']) expect(route(target, chord, page)).toEqual(NATIVE);
    }
    expect(route(timeline, 'Escape', workbench)).toEqual(run('transport.stop', 'timeline'));
    expect(route(playButton, 'Escape', editor)).toEqual(run('transport.stop', 'timeline'));
  });

  it('灯光工作台的快捷键：播放键在按钮上也是播放/暂停，打点让开按钮；按住只算一次；设置页或对话框盖着、没有这个键、输入框和 Cue 池里都不拿（0.5.9）', () => {
    for (const target of [playButton, { tag: 'button', parent: dock }, timeline]) {
      expect(route(target, 'Space', workbench)).toEqual(run('transport.playPause', 'lighting'));
      expect(route(target, 'Space', { ...workbench, repeat: true })).toEqual(SWALLOW);
    }
    expect(route(playButton, 'KeyM', workbench)).toEqual(NATIVE);
    expect(route(timeline, 'KeyM', workbench)).toEqual(run('lighting.stamp', 'lighting'));
    expect(route(timeline, 'KeyM', { ...workbench, repeat: true })).toEqual(SWALLOW);
    // The settings page over the workbench; Space bound to nothing; a field; the Cue pool; a key a control took first.
    expect(route(timeline, 'Space', { ...workbench, overlays: [{ focusInside: false, blocks: true }] })).toEqual(NATIVE);
    const unbound = KEYMAP.filter(entry => !(entry.scope === 'lighting' && entry.id === 'transport.playPause'));
    expect(untouched(route(timeline, 'Space', { ...workbench, keymap: unbound }))).toBe(true);
    expect(route({ tag: 'input', parent: dock }, 'Space', workbench)).toEqual(NATIVE);
    const pool: Node = { tag: 'div', attributes: { class: 'cue-pool-grid' }, parent: dock };
    // The workbench's play key leaves the Cue pool alone; the window's Space then presses the page's play button there,
    // as the window's listener always did (playbackKeyAction never kept the Cue pool; K3 wires the router, today wins).
    expect(route({ tag: 'button', parent: pool }, 'Space', workbench)).toEqual(run('transport.playPause', 'global'));
    expect(route({ tag: 'div', attributes: ownKeys('Space'), parent: timeline }, 'Space', workbench)).toEqual(NATIVE);
  });

  it('灯光工作台里 MA2 执行器的 Flash、Temp 键自己用空格：按住闪灯，不当播放/暂停（0.5.8 回归）', () => {
    const flash: Node = { tag: 'button', attributes: { 'data-momentary': 'true' }, parent: dock };
    expect(route(flash, 'Space', workbench)).toEqual(NATIVE);
    expect(route(flash, 'Space', { ...workbench, repeat: true })).toEqual(NATIVE);
  });

  /** Every key the timeline edits with or moves the playhead with, and its transport keys. */
  const editingKeys = ['Delete', 'Backspace', 'KeyS', 'KeyM', 'Enter', 'Ctrl+KeyV', 'Ctrl+KeyD', 'Ctrl+KeyC', 'Ctrl+KeyX', 'Ctrl+KeyZ', 'Ctrl+KeyA',
    'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Space'];
  const cueDialog: Node = { tag: 'dialog', attributes: { class: 'modal-surface cue-point-dialog', open: '' }, parent: lanes };
  const cueForm: Node = { tag: 'form', attributes: { class: 'effect-binding-form' }, parent: cueDialog };
  const cueFooter: Node = { tag: 'footer', parent: cueForm };
  const inDialog: Node[] = [cueDialog, cueForm, { tag: 'h3', parent: cueForm }, { tag: 'button', parent: cueFooter }, { tag: 'button', attributes: { type: 'submit' }, parent: cueFooter },
    { tag: 'input', attributes: { name: 'time' }, parent: { tag: 'label', parent: cueForm } },
    { tag: 'button', parent: { tag: 'dialog', attributes: { open: '' }, parent: { tag: 'button', attributes: { class: 'timeline-clip' }, parent: lanes } } },
    { tag: 'section', attributes: { role: 'dialog', class: 'ui-popover' }, parent: { tag: 'body' } }, { tag: 'div', attributes: { role: 'alertdialog' }, parent: timeline }];
  /** Every handler there, the lighting points' too. */
  const everything = { available: () => true };

  it('时间线里的原生对话框：焦点在对话框本身、它的按钮或输入框上，Delete、Backspace、s、Ctrl+V/D/C/X/Z、Home、End、方向键、M、Enter 都不碰对话框后面的时间线', () => {
    for (const page of ['cues', 'lighting'] as const) for (const target of inDialog) for (const chord of editingKeys) {
      for (const modalOpen of [true, false]) expect(route(target, chord, { page, modalOpen, ...everything })).toEqual(NATIVE);
    }
  });

  it('模态对话框开着时，时间线不处理任何键；对话框一关，编辑键和 Esc、空格立刻照常可用', () => {
    for (const target of [clip, timeline, heading]) for (const chord of editingKeys) expect(route(target, chord, { page: 'cues', modalOpen: true, ...everything })).toEqual(NATIVE);
    // Closed: on a clip every editing key the timeline knows goes to it, Escape stops and Space plays.
    const onClip = Object.fromEntries(editingKeys.map(chord => [chord, route(clip, chord, { page: 'cues', ...everything })]));
    expect(onClip).toEqual({
      Delete: run('edit.delete', 'timeline'), Backspace: run('edit.delete', 'lighting-points'), KeyS: run('edit.split', 'timeline'), KeyM: run('lighting.addPoint', 'editor'),
      Enter: NATIVE, 'Ctrl+KeyV': run('edit.paste', 'timeline'), 'Ctrl+KeyD': run('edit.duplicate', 'timeline'), 'Ctrl+KeyC': run('edit.copy', 'timeline'),
      'Ctrl+KeyX': run('edit.cut', 'lighting-points'), 'Ctrl+KeyZ': run('document.undo', 'global'), 'Ctrl+KeyA': run('edit.selectAll', 'lighting-points'),
      Home: run('transport.start', 'editor'), End: NATIVE, ArrowLeft: run('transport.prevFrame', 'editor'), ArrowRight: run('transport.nextFrame', 'editor'),
      ArrowUp: NATIVE, ArrowDown: NATIVE, Escape: run('transport.stop', 'timeline'), Space: run('transport.playPause', 'editor')
    });
    for (const target of [timeline, null]) expect(route(target, 'Delete', { page: 'cues', available: only('timeline edit.delete', 'lighting-points edit.delete') }))
      .toEqual(run('edit.delete', target === null ? 'lighting-points' : 'timeline'));
  });

  it('时间线的编辑键让开工具栏按钮、输入框、下拉框和播放器，片段、Cue 和音频波形按钮上照常编辑（和原来一样）', () => {
    for (const target of [playButton, { tag: 'input', parent: toolbar }, { tag: 'select', parent: toolbar }, { tag: 'textarea', parent: heading }, { tag: 'audio', parent: timeline }]) {
      expect(route(target, 'Delete', editor)).toEqual(NATIVE);
    }
    for (const name of ['timeline-clip', 'timeline-cue', 'timeline-media-waveform']) {
      expect(route({ tag: 'button', attributes: { class: name }, parent: lanes }, 'Delete', editor)).toEqual(run('edit.delete', 'timeline'));
    }
  });

  it('灯光时间线的窗口键（M 加灯光点、Delete/Backspace 删灯光点、Ctrl+A/C/X/V）：对话框里、模态对话框开着时都不动作；关掉后照常；输入框、按住、Alt 都不动作', () => {
    const points = { page: 'cues' as const, available: (_id: CommandId, scope: KeyScope) => scope === 'lighting-points' || scope === 'editor' };
    const keys = { Delete: 'edit.delete', Backspace: 'edit.delete', 'Ctrl+KeyA': 'edit.selectAll', 'Ctrl+KeyC': 'edit.copy', 'Ctrl+KeyX': 'edit.cut', 'Ctrl+KeyV': 'edit.paste' } as const;
    const mtc: Node = { tag: 'dialog', attributes: { class: 'modal-surface ui-dialog', open: '' }, parent: body };
    const close: Node = { tag: 'button', parent: { tag: 'header', parent: { tag: 'div', attributes: { class: 'ui-dialog-frame' }, parent: mtc } } };
    const panel: Node = { tag: 'section', attributes: { role: 'dialog', class: 'ui-popover' }, parent: body };
    for (const [chord, id] of Object.entries(keys)) {
      for (const target of [mtc, close, { tag: 'p', parent: mtc }, panel, { tag: 'button', parent: panel }, cueDialog, { tag: 'button', parent: cueFooter }]) {
        for (const modalOpen of [false, true]) expect(route(target, chord, { ...points, modalOpen })).toEqual(NATIVE);
      }
      for (const target of [body, null]) expect(route(target, chord, { ...points, modalOpen: true })).toEqual(NATIVE);
      for (const target of [body, clip, null]) expect(route(target, chord, points)).toEqual(run(id, 'lighting-points'));
    }
    expect(route(body, 'KeyM', points)).toEqual(run('lighting.addPoint', 'editor'));
    for (const target of [{ tag: 'input', parent: body }, { tag: 'textarea', parent: body }, { tag: 'select', parent: body }, { tag: 'div', attributes: { contenteditable: 'true' }, parent: body }]) {
      expect(route(target, 'Delete', points)).toEqual(NATIVE);
    }
    expect(route(body, 'Delete', { ...points, repeat: true })).toEqual(SWALLOW);
    expect(route(body, 'Alt+Delete', points)).toEqual(IGNORE);
    expect(route({ tag: 'div', attributes: ownKeys('Delete'), parent: body }, 'Delete', points)).toEqual(NATIVE);
  });
});

describe('时间线的键接到路由上（04 设计 K6）', () => {
  const cuePoints: Node = { tag: 'div', attributes: { class: 'waveform-cue-points' }, parent: lanes };
  const cuePoint: Node = { tag: 'button', attributes: { class: 'waveform-cue-point', ...ownKeys('Enter') }, parent: cuePoints };
  /** The Cue points take Delete and Escape with the focus in them (WaveformCuePoints' `when`); everything else is there. */
  const inCuePoints = { page: 'lighting' as const, available: () => true };

  it('灯光工作台的 Cue 点上 Delete、Backspace 删 Cue 点，Esc 只清选择不停节目，都比时间线和灯光点先问；按住只算一次；Enter 归 Cue 点自己', () => {
    for (const target of [cuePoint, cuePoints]) {
      for (const chord of ['Delete', 'Backspace']) expect(route(target, chord, inCuePoints)).toEqual(run('edit.delete', 'lighting'));
      expect(route(target, 'Escape', inCuePoints)).toEqual(run('edit.deselect', 'lighting'));
      expect(route(target, 'Delete', { ...inCuePoints, repeat: true })).toEqual(SWALLOW);
    }
    expect(route(cuePoint, 'Enter', inCuePoints)).toEqual(NATIVE);
    // No Cue point selected or focused: Delete goes on to the lighting points (the focus is on a button), Escape stops.
    const without = { page: 'lighting' as const, available: (id: CommandId, scope: KeyScope) => !(scope === 'lighting' && id === 'edit.delete') };
    expect(route(cuePoint, 'Delete', without)).toEqual(run('edit.delete', 'lighting-points'));
    expect(route(cuePoints, 'Delete', without)).toEqual(run('edit.delete', 'timeline'));
    expect(route(cuePoint, 'Backspace', without)).toEqual(run('edit.delete', 'lighting-points'));
    expect(route(cuePoint, 'Escape', { page: 'lighting', available: timelineHandlers })).toEqual(run('transport.stop', 'timeline'));
    // The editor has no Cue points: its Delete is the timeline's.
    expect(route(clip, 'Delete', { page: 'cues', available: () => true })).toEqual(run('edit.delete', 'timeline'));
  });

  it('编辑器的音频片段：S 是时间线的分割（和片段、Cue 一样），←→ 逐帧；Enter、Delete、Backspace 归片段自己', () => {
    const segment: Node = { tag: 'div', attributes: { class: 'audio-timeline-segment', role: 'button', ...ownKeys('Enter', 'Delete', 'Backspace') }, parent: lanes };
    expect(route(segment, 'KeyS', editor)).toEqual(run('edit.split', 'timeline'));
    expect(route(segment, 'ArrowLeft', editor)).toEqual(run('transport.prevFrame', 'editor'));
    expect(route(segment, 'Ctrl+KeyC', editor)).toEqual(run('edit.copy', 'timeline'));
    for (const chord of ['Enter', 'Delete', 'Backspace']) expect(route(segment, chord, editor)).toEqual(NATIVE);
  });

  it('灯光工作台的快捷键按这台电脑上改过的键走：改了以后原来的键不再是它', () => {
    const keymap = KEYMAP.map(entry => entry.scope === 'lighting' && entry.id === 'lighting.stamp' ? { ...entry, keys: [{ chord: 'KeyK' }] } : entry);
    expect(route(timeline, 'KeyK', { ...workbench, keymap })).toEqual(run('lighting.stamp', 'lighting'));
    expect(untouched(route(timeline, 'KeyM', { ...workbench, keymap }))).toBe(true);
  });
});

describe('首页的列表和拖动（修复 2 的歌卡、播放列表）', () => {
  const grid: Node = { tag: 'div', attributes: { class: 'home-grid', ...ownKeys(...HOME_OWN_KEYS.programGrid) }, parent: body };
  const card: Node = { tag: 'article', attributes: { 'data-program-id': 'a', ...ownKeys(...HOME_OWN_KEYS.programCard) }, parent: grid };
  const playlist: Node = { tag: 'button', attributes: { 'data-playlist-id': 'p', ...ownKeys(...HOME_OWN_KEYS.playlist) }, parent: body };

  it('歌卡上的方向键、Home、End 是卡片自己移焦点，不换歌；节目列表的 Ctrl+A、Delete 归列表；播放列表的 F2、菜单键归播放列表', () => {
    for (const chord of HOME_OWN_KEYS.programCard) expect(route(card, chord)).toEqual(NATIVE);
    for (const chord of HOME_OWN_KEYS.programGrid) expect(route(grid, chord)).toEqual(NATIVE);
    for (const chord of HOME_OWN_KEYS.playlist) expect(route(playlist, chord)).toEqual(NATIVE);
    // The grid itself, not a card: ↓ changes songs as it does today; Escape clears the selection and stops as today.
    expect(route(grid, 'ArrowDown')).toEqual(run('home.nextSong', 'global'));
    expect(route(card, 'Escape')).toEqual(run('transport.stop', 'global'));
    expect(route(card, 'Space')).toEqual(run('transport.playPause', 'global'));
  });

  it('拖歌卡、框选、拖播放列表时（DragSession）按 Esc 只取消拖动，取消后到松手前再按也不停节目', () => {
    for (const target of [card, grid, playlist, body]) {
      expect(route(target, 'Escape', { drag: 'active' })).toEqual({ kind: 'drag-cancel' });
      expect(route(target, 'Escape', { drag: 'cancelled' })).toEqual(SWALLOW);
    }
  });
});

it('输入法正在组字时什么都不碰；录键的输入框拿走所有键', () => {
  const recorder: Node = { tag: 'input', attributes: ownKeys('*'), parent: body };
  expect(routeKey({ chord: 'Space', repeat: false, composing: true, owner: null, inTimeline: false, modalOpen: false, overlays: [], drag: 'none', page: 'project',
    available: () => true, song: () => undefined })).toEqual(IGNORE);
  for (const chord of ['Escape', 'Ctrl+KeyS', 'Space', 'Ctrl+Digit3']) expect(route(recorder, chord)).toEqual(NATIVE);
  // Saving works in fields and dialogs.
  expect(route({ tag: 'input', parent: body }, 'Ctrl+KeyS')).toEqual(run('document.save', 'global'));
  expect(route(body, 'Ctrl+Shift+KeyS', { modalOpen: true })).toEqual(run('document.saveAs', 'global'));
  expect(route({ tag: 'input', parent: body }, 'Ctrl+KeyZ')).toEqual(NATIVE);
});

it('浮层开着时 Esc 关最上面那个，焦点在哪都一样（页面、输入框、面板里），除了自己用 Esc 的元素、模态对话框和拖动；焦点在浮层里时别的键归浮层（04 设计 K4）', () => {
  const below = { focusInside: false, blocks: true }, top = { focusInside: false, blocks: false };
  const panel: Node = { tag: 'section', attributes: { role: 'dialog' }, parent: body };
  for (const node of [body, null, { tag: 'input', parent: body }, { tag: 'button', parent: panel }, { tag: 'input', parent: panel }, { tag: 'div', attributes: { role: 'slider' }, parent: body }]) {
    expect(route(node, 'Escape', { overlays: [below, top] })).toEqual({ kind: 'overlay' });
  }
  expect(route({ tag: 'input', attributes: ownKeys('Escape'), parent: panel }, 'Escape', { overlays: [top] })).toEqual(NATIVE);
  expect(route({ tag: 'input', attributes: ownKeys('*'), parent: body }, 'Escape', { overlays: [top] })).toEqual(NATIVE);
  expect(route(body, 'Escape', { overlays: [top], modalOpen: true })).toEqual(NATIVE);
  expect(route(body, 'Escape', { overlays: [top], drag: 'active' })).toEqual({ kind: 'drag-cancel' });
  // The focus in a panel that is no dialog (the player's status details): its keys; outside it, Space plays.
  expect(route({ tag: 'button', parent: body }, 'Space', { overlays: [{ focusInside: true, blocks: false }] })).toEqual(NATIVE);
  expect(route({ tag: 'button', parent: body }, 'Space', { overlays: [top] })).toEqual(run('transport.playPause', 'global'));
});

describe('拖动层（04 设计 K5）', () => {
  const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' }, parent: body };
  const clip: Node = { tag: 'button', attributes: { class: 'timeline-clip' }, parent: timeline };
  const field: Node = { tag: 'input', parent: body };

  it('拖动中按 Delete、Backspace、Ctrl+Z、Ctrl+Y、Ctrl+Shift+Z、S、Ctrl+V、Ctrl+D 都不执行，工程不在拖到一半时变掉；三个页面都一样', () => {
    for (const page of ['project', 'cues', 'lighting'] as const) {
      for (const chord of ['Delete', 'Backspace', 'Ctrl+KeyZ', 'Ctrl+KeyY', 'Ctrl+Shift+KeyZ']) {
        for (const node of [body, timeline, clip, null]) expect([page, chord, route(node, chord, { page, drag: 'active', available: timelineHandlers })]).toEqual([page, chord, SWALLOW]);
        expect([page, chord, route(body, chord, { page, drag: 'cancelled', available: timelineHandlers })]).toEqual([page, chord, SWALLOW]);
      }
    }
    for (const chord of ['KeyS', 'Ctrl+KeyV', 'Ctrl+KeyD', 'Ctrl+KeyC', 'KeyM']) expect([chord, route(clip, chord, { page: 'cues', drag: 'active', available: timelineHandlers })]).toEqual([chord, SWALLOW]);
    // Without a drag undo runs as before.
    expect(route(body, 'Ctrl+KeyZ', { page: 'cues' })).toEqual(run('document.undo', 'global'));
  });

  it('拖动中在输入框里打字、在对话框里按键照旧：Delete、Ctrl+Z 是文字自己的；保存照常', () => {
    for (const chord of ['Delete', 'Backspace', 'Ctrl+KeyZ']) expect(untouched(route(field, chord, { page: 'cues', drag: 'active' }))).toBe(true);
    expect(untouched(route(body, 'Delete', { page: 'cues', drag: 'active', modalOpen: true }))).toBe(true);
    expect(route(body, 'Ctrl+KeyS', { page: 'cues', drag: 'active' })).toEqual(run('document.save', 'global'));
  });

  it('拖动中空格、↑↓、播放头的左右键和没拖动时一样（0.5.9 的行为不变）', () => {
    for (const page of ['project', 'cues', 'lighting'] as const) {
      for (const chord of ['Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'Home']) {
        expect([page, chord, route(body, chord, { page, drag: 'active', available: timelineHandlers })]).toEqual([page, chord, route(body, chord, { page, available: timelineHandlers })]);
      }
    }
  });

  it('拖动中按 Esc 只取消拖动，焦点在哪、开着什么都一样：输入框、对话框、设置页和连接页（blocks）开着时也是；第 7 题之前 Esc 不停止', () => {
    const settings = { focusInside: false, blocks: true };
    for (const where of [{ overlays: [settings] }, { modalOpen: true }, { overlays: [{ focusInside: true, blocks: false }] }, {}]) {
      for (const node of [body, field, clip, timeline, { tag: 'input', attributes: ownKeys('Escape'), parent: body }]) {
        expect(route(node, 'Escape', { ...where, page: 'cues', drag: 'active', available: timelineHandlers })).toEqual({ kind: 'drag-cancel' });
        expect(route(node, 'Escape', { ...where, page: 'cues', drag: 'cancelled', available: timelineHandlers })).toEqual(SWALLOW);
      }
    }
    // With no drag, Escape on the timeline is not taken for one.
    expect(route(timeline, 'Escape', { page: 'cues', available: timelineHandlers })).not.toEqual(SWALLOW);
  });
});
