import { describe, expect, it } from 'vitest';
import { parseChord } from './key-chord';
import { editsText, keyInTimeline, keyOwner, typesLines, windowKeepsKey, type OwnerTarget } from './key-owner';
import { routeKey, type RouteDecision, type RouteInput } from './key-route';
import { KeyRouter, type KeyEvent } from './key-router';
import { KEYMAP, type CommandId, type KeyPage, type KeyScope, type KeySwitch } from './keymap';

/*
 * 按键的规则测试（04 设计第 8 节，K7）：守用户定下的规则，和 lighting-workflow-rules.test.ts 一样。这些测试失败就是违反
 * 了规则，不能靠改测试过关。
 *
 * 用户的决定（00-order 第 8 节第 1 题，取代 04 设计 4.10 的“单按 Esc 不停止”）：
 * - Esc 照旧停止，按 输入框 → 弹窗 → 拖动 → 页面 → 全局 的顺序轮到它；
 * - Shift+Esc 是第二个停止键，在哪儿都能停止：弹窗开着、拖动中、输入框里。它是“弹窗里的键不碰节目”唯一的例外；
 * - 设置里有一个开关「单按 Esc 停止」，默认开；关掉后 Esc 只关面板、取消选中、取消拖动，每台电脑记住。
 * 第 7 题的其余部分：编辑器和灯光工作台照剪映（keymap.ts 的 `jianying`），首页的键不变，↑↓ 换歌只在首页，按住 Enter
 * 只算一次。源码扫描（keys/ 以外没有 keydown 监听、onKeyDown 都声明了 ownKeys）在 key-routing-scan.test.ts。
 */

/** An element the focus is on, matched by the selectors it stands for (`tag`, `.class`, `[name="value"]`), its parents included. */
type Node = { matches: readonly string[]; attributes?: Record<string, string>; parent?: Node };
function element(node: Node): OwnerTarget {
  return {
    closest: (selectors: string) => {
      for (let current: Node | undefined = node; current; current = current.parent) {
        const candidate = current;
        if (selectors.split(',').some(selector => candidate.matches.includes(selector.trim()))) return { getAttribute: (name: string) => candidate.attributes?.[name] ?? null };
      }
      return null;
    }
  };
}
const body: Node = { matches: ['body'] };
const field: Node = { matches: ['input'], parent: body };
const textarea: Node = { matches: ['textarea'], parent: body };
const button: Node = { matches: ['button'], parent: body };
const dialog: Node = { matches: ['dialog'], parent: body };
const inDialog: Node = { matches: ['input'], parent: dialog };
const timeline: Node = { matches: ['.reference-timeline'], parent: body };
const clip: Node = { matches: ['.timeline-clip'], parent: timeline };
const recorder: Node = { matches: ['input', '[data-own-keys="*"]'], parent: body };

type Where = { node?: Node | null; page?: KeyPage; repeat?: boolean; modalOpen?: boolean; overlays?: RouteInput['overlays']; drag?: RouteInput['drag'];
  switchesOff?: ReadonlySet<KeySwitch>; available?: RouteInput['available']; song?: RouteInput['song'] };
/**
 * Every handler of the table there, but the lighting workbench's Cue points' Delete and Escape, which take the key only
 * with the focus in the Cue points (WaveformCuePoints' `when`).
 */
const everywhere: RouteInput['available'] = (id, scope) => !(scope === 'lighting' && (id === 'edit.delete' || id === 'edit.deselect'));
/** `routeKey` for `chord` pressed on `node`, as the router asks it: `everywhere` unless `available` says otherwise. */
function route(chord: string, where: Where = {}): RouteDecision {
  const node = where.node === undefined ? body : where.node;
  const target = node === null ? null : element(node);
  return routeKey({ chord, repeat: where.repeat ?? false, composing: false, owner: keyOwner(target, chord), inTimeline: keyInTimeline(target),
    windowKeeps: windowKeepsKey(target, chord), editingText: editsText(target), typesLines: typesLines(target),
    modalOpen: where.modalOpen ?? false, overlays: where.overlays ?? [], drag: where.drag ?? 'none', page: where.page ?? 'project',
    switchesOff: where.switchesOff ?? new Set(), available: where.available ?? everywhere, song: where.song ?? (() => undefined) });
}
const run = (id: CommandId, scope: KeyScope): RouteDecision => ({ kind: 'run', id, scope });
const stops = (decision: RouteDecision): boolean => decision.kind === 'run' && decision.id === 'transport.stop';
const PAGES: readonly KeyPage[] = ['project', 'cues', 'lighting'];
const ESC_OFF: ReadonlySet<KeySwitch> = new Set(['plainEscapeStops']);
/** Every chord the table knows, the stop keys included. */
const CHORDS = [...new Set(KEYMAP.flatMap(entry => entry.keys.map(binding => binding.chord)))];

/** A key event for `chord` with the focus on `node`, whose marks the test reads. */
function keyEvent(chord: string, node: Node | null, repeat = false): KeyEvent & { prevented: boolean; stopped: boolean } {
  const parsed = parseChord(chord);
  if (!parsed) throw new Error(`读不懂这个键：${chord}`);
  const event = {
    code: parsed.code, key: parsed.code === 'Space' ? ' ' : parsed.code, ctrlKey: parsed.ctrl, altKey: parsed.alt, shiftKey: parsed.shift, metaKey: parsed.meta,
    repeat, isComposing: false, prevented: false, stopped: false, target: node === null ? null : element(node),
    get defaultPrevented() { return event.prevented; }, preventDefault: () => { event.prevented = true; }, stopPropagation: () => { event.stopped = true; }
  };
  return event;
}

describe('规则 1：一次按键只执行一条命令', () => {
  it('表里每个键、每个页面、每种焦点（空白处、时间线、片段、输入框、弹窗、模态弹窗、拖动中）：处理函数最多被叫一次', () => {
    for (const page of PAGES) for (const [node, modal, dragging] of [[body, false, false], [timeline, false, false], [clip, false, false], [field, false, false],
      [inDialog, false, false], [body, true, false], [body, false, true], [null, false, false]] as const) {
      const calls: string[] = [];
      const router = new KeyRouter(() => ({ querySelector: (selectors: string) => modal && selectors === 'dialog:modal' ? {} : null }));
      router.setPage(page);
      // Every command of the table registered in its scope, twice: only the last registered acts.
      for (const scope of new Set(KEYMAP.map(entry => entry.scope))) {
        for (const copy of ['先登记的', '后登记的']) {
          router.register(scope, () => Object.fromEntries(KEYMAP.filter(entry => entry.scope === scope).map(entry => [entry.id, () => { calls.push(`${copy} ${scope} ${entry.id}`); }])));
        }
      }
      if (dragging) router.beginDrag({ escape: () => { calls.push('取消拖动'); }, cancelled: () => false });
      for (const chord of CHORDS) {
        calls.length = 0;
        router.dispatch(keyEvent(chord, node));
        expect(calls.length, `${page} ${chord}`).toBeLessThanOrEqual(1);
        expect(calls.filter(call => call.startsWith('先登记的')), `${page} ${chord}`).toEqual([]);
      }
    }
  });
});

describe('规则 2：顺序是 输入框 → 弹窗 → 拖动 → 页面 → 全局', () => {
  it('一组固定的用例', () => {
    // 输入框: the field's own keys; a recording field takes every key, the stop keys and saving too.
    expect(route('Space', { node: field })).toEqual({ kind: 'native' });
    expect(route('Delete', { node: field, page: 'cues' })).toEqual({ kind: 'native' });
    for (const chord of ['Escape', 'Shift+Escape', 'Ctrl+KeyS']) expect(route(chord, { node: recorder })).toEqual({ kind: 'native' });
    // 弹窗: Escape closes the top panel, from a field too; a dialog keeps its keys.
    expect(route('Escape', { node: field, overlays: [{ focusInside: false, blocks: false }] })).toEqual({ kind: 'overlay' });
    expect(route('Space', { node: inDialog, page: 'cues' })).toEqual({ kind: 'native' });
    expect(route('Escape', { modalOpen: true })).toEqual({ kind: 'native' });
    // 拖动: Escape cancels the drag before the panel or the page sees it; nothing changes the project halfway.
    expect(route('Escape', { drag: 'active', overlays: [{ focusInside: false, blocks: false }], page: 'cues', node: timeline })).toEqual({ kind: 'drag-cancel' });
    expect(route('Ctrl+KeyB', { drag: 'active', page: 'cues', node: clip })).toEqual({ kind: 'swallow' });
    // 页面 before 全局: the editor's Space and Escape are the page's, outside the timeline the window's (which press the page's own handlers, key-router.ts).
    expect(route('Space', { node: clip, page: 'cues' })).toEqual(run('transport.playPause', 'editor'));
    expect(route('Escape', { node: clip, page: 'cues' })).toEqual(run('transport.stop', 'timeline'));
    expect(route('Escape', { page: 'cues' })).toEqual(run('transport.stop', 'global'));
    expect(route('Space', { page: 'project' })).toEqual(run('transport.playPause', 'global'));
  });
});

describe('规则 3：停止键（00-order 第 8 节第 1 题）', () => {
  it('Esc 照旧停止：首页、编辑器、灯光工作台的空白处和时间线上，在别的层都不要它之后', () => {
    for (const page of PAGES) expect(stops(route('Escape', { page })), page).toBe(true);
    for (const page of ['cues', 'lighting'] as const) expect(stops(route('Escape', { page, node: timeline })), page).toBe(true);
    // The layers before it keep it: a field, a dialog, an open panel, a drag.
    expect(stops(route('Escape', { node: field }))).toBe(false);
    expect(stops(route('Escape', { node: inDialog }))).toBe(false);
    expect(stops(route('Escape', { overlays: [{ focusInside: false, blocks: false }] }))).toBe(false);
    expect(stops(route('Escape', { drag: 'active' }))).toBe(false);
  });

  it('Shift+Esc 在哪儿都只停止：三个页面，输入框里、弹窗里、模态弹窗开着、拖动中、设置页开着、按钮和控件上、时间线上；按住只停一次', () => {
    const where: Where[] = [{}, { node: field }, { node: textarea }, { node: inDialog }, { node: dialog }, { modalOpen: true }, { drag: 'active' }, { drag: 'cancelled' },
      { overlays: [{ focusInside: true, blocks: true }] }, { node: button }, { node: { matches: ['[role="slider"]'], parent: body } }, { node: timeline }, { node: clip }, { node: null }];
    for (const page of PAGES) for (const place of where) {
      const decision = route('Shift+Escape', { ...place, page });
      expect(stops(decision), `${page} ${JSON.stringify(place)}`).toBe(true);
      expect(route('Shift+Escape', { ...place, page, repeat: true }), `${page} 按住`).toEqual({ kind: 'swallow' });
    }
    // It stops only: the dialog stays open and the drag goes on (the router takes the key before them).
    const router = new KeyRouter(() => null);
    const log: string[] = [];
    router.register('global', () => ({ 'transport.stop': () => { log.push('停止'); } }));
    router.beginDrag({ escape: () => { log.push('取消拖动'); }, cancelled: () => false });
    const key = keyEvent('Shift+Escape', inDialog);
    router.dispatch(key);
    expect([log, key.prevented]).toEqual([['停止'], true]);
  });

  it('关掉「单按 Esc 停止」：Esc 在哪儿都不停止，只关面板、取消选中、取消拖动；Shift+Esc 照样停止', () => {
    for (const page of PAGES) for (const node of [body, timeline, clip, button, null]) {
      expect(stops(route('Escape', { page, node, switchesOff: ESC_OFF })), `${page}`).toBe(false);
      expect(stops(route('Shift+Escape', { page, node, switchesOff: ESC_OFF })), `${page}`).toBe(true);
    }
    expect(route('Escape', { switchesOff: ESC_OFF, overlays: [{ focusInside: false, blocks: false }] })).toEqual({ kind: 'overlay' });
    expect(route('Escape', { switchesOff: ESC_OFF, drag: 'active' })).toEqual({ kind: 'drag-cancel' });
    for (const page of ['cues', 'lighting'] as const) expect(route('Escape', { page, node: clip, switchesOff: ESC_OFF })).toEqual(run('edit.deselect', 'timeline'));
    // In the lighting workbench's Cue points Escape clears their selection, on or off (2026-09-21).
    for (const switchesOff of [new Set<KeySwitch>(), ESC_OFF]) expect(route('Escape', { page: 'lighting', node: clip, switchesOff, available: () => true })).toEqual(run('edit.deselect', 'lighting'));
    // On: the timeline's Escape stops and does not deselect.
    expect(route('Escape', { page: 'cues', node: clip })).toEqual(run('transport.stop', 'timeline'));
  });
});

describe('规则 4：首页的键不变，↑↓ 换歌只在首页', () => {
  it('首页：空格按播放按钮，↑↓ 换歌（开了「方向键切歌」时），歌曲自己的快捷键播那首歌', () => {
    expect(route('Space')).toEqual(run('transport.playPause', 'global'));
    expect(route('ArrowUp')).toEqual(run('home.prevSong', 'global'));
    expect(route('ArrowDown')).toEqual(run('home.nextSong', 'global'));
    expect(route('ArrowDown', { available: (id, scope) => scope === 'global' && id !== 'home.nextSong' })).toEqual({ kind: 'ignore' });
    expect(route('Ctrl+Digit3', { song: chord => chord === 'Ctrl+Digit3' ? '第三首' : undefined })).toEqual({ kind: 'song', itemId: '第三首' });
  });

  it('编辑器和灯光工作台里 ↑↓ 不换歌：时间线里是剪辑点，别处不做事', () => {
    for (const page of ['cues', 'lighting'] as const) for (const node of [body, button, null]) {
      for (const chord of ['ArrowUp', 'ArrowDown']) {
        const decision = route(chord, { page, node });
        expect(decision.kind === 'run' && decision.id.startsWith('home.'), `${page} ${chord}`).toBe(false);
      }
    }
    expect(route('ArrowUp', { page: 'cues', node: timeline })).toEqual(run('transport.prevEditPoint', 'timeline'));
    expect(route('ArrowDown', { page: 'lighting', node: clip })).toEqual(run('transport.nextEditPoint', 'timeline'));
  });
});

describe('规则 5：编辑器和灯光工作台照剪映', () => {
  it('表里写了剪映的键的，键和剪映一样；不一样的都写了原因', () => {
    for (const entry of KEYMAP) {
      if (entry.jianying === null) continue;
      const same = entry.jianying.keys.join(' ') === entry.keys.map(binding => binding.chord).join(' ');
      expect(same || Boolean(entry.differsFromJianying), `${entry.scope} ${entry.id}`).toBe(true);
    }
  });

  it('剪映的分割是 Ctrl+B（S 不再分割），Q/W 修剪到播放头，N 吸附，编辑器的 M 加标记', () => {
    expect(route('Ctrl+KeyB', { page: 'cues', node: clip })).toEqual(run('edit.split', 'timeline'));
    expect(route('KeyS', { page: 'cues', node: clip })).not.toEqual(run('edit.split', 'timeline'));
    expect(route('KeyQ', { page: 'cues', node: clip })).toEqual(run('edit.trimLeft', 'editor'));
    expect(route('KeyW', { page: 'cues', node: clip })).toEqual(run('edit.trimRight', 'editor'));
    expect(route('KeyN', { page: 'lighting', node: timeline })).toEqual(run('view.snap', 'timeline'));
    expect(route('KeyM', { page: 'cues' })).toEqual(run('marker.add', 'editor'));
    expect(route('KeyM', { page: 'lighting' })).toEqual(run('lighting.stamp', 'lighting'));
  });
});

describe('规则 6：按住 Enter 只算一次，按住 once 的命令只执行一次', () => {
  it('按住 Enter 的重复在哪儿都被路由拿走（空白处、按钮、Go 执行器键、Cue 点、修改框的输入框、模态弹窗），多行文字框里照常换行', () => {
    const cuePoint: Node = { matches: ['button', '[data-own-keys~="Enter"]'], parent: timeline };
    const momentary: Node = { matches: ['button', '[data-momentary="true"]'], parent: body };
    for (const chord of ['Enter', 'NumpadEnter']) {
      for (const node of [body, button, cuePoint, momentary, inDialog, dialog, field, null]) {
        for (const page of PAGES) expect(route(chord, { node, page, repeat: true }), `${chord} ${page}`).toEqual({ kind: 'held' });
      }
      expect(route(chord, { node: inDialog, modalOpen: true, repeat: true })).toEqual({ kind: 'held' });
      expect(route(chord, { node: textarea, repeat: true })).not.toEqual({ kind: 'held' });
      expect(route(chord, { node: { matches: ['[contenteditable="true"]'], parent: body }, repeat: true })).not.toEqual({ kind: 'held' });
      // The first press is left to the button, the Cue point, the form.
      expect(route(chord, { node: button })).not.toEqual({ kind: 'held' });
    }
  });

  it('从 ma2-executor-keys.test.ts、cue-point-keys.test.ts 搬来：Go 键按住 Enter，重复的不传给按钮，也不被浏览器当成点击；修改框里按住的 Enter 不当保存', () => {
    const router = new KeyRouter(() => null);
    const goKey: Node = { matches: ['button'], parent: { matches: ['.ma2-executor-grid'], parent: body } };
    const keys = [keyEvent('Enter', goKey), keyEvent('Enter', goKey, true), keyEvent('Enter', goKey, true), keyEvent('Enter', goKey, true)];
    for (const key of keys) router.dispatch(key);
    // The first reaches the button (its click presses Go once); the repeats are taken and go no further.
    expect(keys.map(key => [key.prevented, key.stopped])).toEqual([[false, false], [true, true], [true, true], [true, true]]);
    const form: Node = { matches: ['input'], parent: { matches: ['form'], parent: { matches: ['dialog'], parent: timeline } } };
    const held = [keyEvent('Enter', form, true), keyEvent('Enter', form, true)], fresh = keyEvent('Enter', form);
    for (const key of [...held, fresh]) router.dispatch(key);
    expect([...held, fresh].map(key => key.prevented)).toEqual([true, true, false]);
    // Other keys held in the dialog are its own: typing the time, Tab, Backspace.
    for (const chord of ['Digit1', 'Tab', 'Backspace']) {
      const key = keyEvent(chord, form, true);
      router.dispatch(key);
      expect([chord, key.prevented, key.stopped]).toEqual([chord, false, false]);
    }
  });

  it('once 的命令按住只执行一次', () => {
    for (const entry of KEYMAP.filter(item => item.repeat === 'once' && item.kind !== 'document')) {
      for (const binding of entry.keys) {
        const page = entry.scope === 'lighting' ? 'lighting' : entry.scope === 'global' || entry.scope === 'home' ? 'project' : 'cues';
        const node = entry.area === 'timeline' ? clip : body;
        const decision = route(binding.chord, { page, node, repeat: true });
        expect(decision.kind === 'run' && decision.id === entry.id && decision.scope === entry.scope, `${entry.scope} ${entry.id} ${binding.chord}`).toBe(false);
      }
    }
  });
});

describe('规则 7：弹窗开着时，除了停止键和保存，别的键都不碰节目', () => {
  it('焦点在弹窗里、或模态弹窗开着焦点在页面上：表里每个键都留给弹窗，只有 Shift+Esc 停止、Ctrl+S 和 Ctrl+Shift+S 保存', () => {
    const allowed = new Map([['Shift+Escape', 'transport.stop'], ['Ctrl+KeyS', 'document.save'], ['Ctrl+Shift+KeyS', 'document.saveAs']]);
    for (const page of PAGES) for (const place of [{ node: inDialog }, { node: dialog }, { node: body, modalOpen: true }, { node: clip, modalOpen: true }] as Where[]) {
      for (const chord of CHORDS) {
        const decision = route(chord, { ...place, page });
        if (decision.kind !== 'run') { expect(['native', 'ignore', 'held'], `${page} ${chord}`).toContain(decision.kind); continue; }
        expect([chord, decision.id], page).toEqual([chord, allowed.get(chord)]);
      }
    }
  });
});
