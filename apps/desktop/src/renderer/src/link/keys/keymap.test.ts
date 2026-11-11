import { describe, expect, it } from 'vitest';
import { isSystemChord, parseChord } from './key-chord';
import { routeKey, type RouteInput } from './key-route';
import { commandKeys, KEYMAP, PAGE_SCOPES, type KeyEntry, type KeyScope } from './keymap';

const chordsOf = (scope: KeyScope): string[] => KEYMAP.filter(entry => entry.scope === scope).flatMap(entry => entry.keys.map(binding => binding.chord));

describe('快捷键表的自检', () => {
  it('同一范围里没有重复的键，同一条命令在同一范围只出现一次；只有时间线的 Esc 有两条：停止，和关掉「单按 Esc 停止」后的取消选中', () => {
    for (const scope of new Set(KEYMAP.map(entry => entry.scope))) {
      const chords = chordsOf(scope);
      const repeated = chords.filter((chord, index) => chords.indexOf(chord) !== index);
      expect(repeated, `${scope} 里有重复的键`).toEqual(scope === 'timeline' ? ['Escape'] : []);
      const ids = KEYMAP.filter(entry => entry.scope === scope).map(entry => entry.id);
      expect(new Set(ids).size, `${scope} 里有重复的命令`).toBe(ids.length);
    }
    // The stop's Escape works unless 「单按 Esc 停止」 is off, the deselect's only while it is: never both at once.
    const escapes = KEYMAP.filter(entry => entry.scope === 'timeline' && entry.keys.some(binding => binding.chord === 'Escape'));
    expect(escapes.map(entry => { const binding = entry.keys.find(item => item.chord === 'Escape'); return [entry.id, binding?.switch, binding?.whileOff]; }))
      .toEqual([['transport.stop', 'plainEscapeStops', undefined], ['edit.deselect', undefined, 'plainEscapeStops']]);
    for (const switchesOff of [new Set<'plainEscapeStops'>(), new Set(['plainEscapeStops' as const])]) {
      expect(escapes.filter(entry => commandKeys(KEYMAP, entry.id, 'timeline', switchesOff).includes('Escape'))).toHaveLength(1);
    }
  });

  it('页面自己的键（编辑器、灯光工作台）和两页共用的时间线不重复，只有灯光工作台 Cue 点上的 Delete、Backspace、Esc（只在 Cue 点里、比时间线先问）；灯光点和时间线重复的只有复制、粘贴、删除（04 设计 3.3 b、d，K6 由 timeline-commands 定归谁）', () => {
    const timeline = new Set(chordsOf('timeline'));
    expect(chordsOf('editor').filter(chord => timeline.has(chord))).toEqual([]);
    // The Cue points' Delete, Backspace and Escape (WaveformCuePoints, K6), asked before the timeline's and only with the focus in them.
    expect(chordsOf('lighting').filter(chord => timeline.has(chord)).sort()).toEqual(['Backspace', 'Delete', 'Escape']);
    expect(KEYMAP.filter(entry => entry.scope === 'lighting' && entry.keys.some(binding => timeline.has(binding.chord))).map(entry => entry.id)).toEqual(['edit.delete', 'edit.deselect']);
    expect(chordsOf('lighting-points').filter(chord => timeline.has(chord)).sort()).toEqual(['Backspace', 'Ctrl+KeyC', 'Ctrl+KeyV', 'Delete']);
  });

  it('每一项都有名字，每个键都按一种拼法写（chordOf）', () => {
    for (const entry of KEYMAP) {
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.keys.length, entry.id).toBeGreaterThan(0);
      for (const binding of entry.keys) expect(parseChord(binding.chord), `${entry.id} 的 ${binding.chord}`).not.toBeNull();
    }
  });

  it('能改的项不是 Windows 或输入法的系统组合；现在能改的只有灯光工作台的 6 个键', () => {
    const rebindable = KEYMAP.filter(entry => entry.rebindable);
    for (const entry of rebindable) for (const binding of entry.keys) expect(isSystemChord(binding.chord), `${entry.id} 的 ${binding.chord}`).toBe(false);
    expect(rebindable.map(entry => `${entry.scope} ${entry.id}`)).toEqual(['lighting lighting.stamp', 'lighting transport.playPause', 'lighting transport.prevFrame',
      'lighting transport.nextFrame', 'lighting transport.start', 'lighting transport.end']);
    // The keys the settings page has saved since 0.5.8 (stores/shortcut-store.ts defaultShortcuts).
    expect(rebindable.map(entry => entry.keys[0]!.chord)).toEqual(['KeyM', 'Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
  });

  it('和剪映的键不一样的地方都写了原因', () => {
    for (const entry of KEYMAP) {
      const same = entry.jianying !== null && entry.jianying.keys.join(' ') === entry.keys.map(binding => binding.chord).join(' ');
      if (entry.jianying !== null && !same) expect(entry.differsFromJianying, `${entry.scope} ${entry.id}`).toBeTruthy();
    }
  });

  it('表按 K7 的键写：Esc 和 Shift+Esc 停止，Ctrl+B 分割，S 只提示一次，M 在编辑器加标记，Shift+←/→ 5 帧，↑↓ 换歌只在首页', () => {
    const find = (scope: KeyScope, id: KeyEntry['id']) => KEYMAP.find(entry => entry.scope === scope && entry.id === id);
    const keys = (scope: KeyScope, id: KeyEntry['id']) => find(scope, id)?.keys.map(binding => binding.chord);
    expect(keys('global', 'transport.stop')).toEqual(['Escape', 'Shift+Escape']);
    expect(keys('timeline', 'transport.stop')).toEqual(['Escape', 'Shift+Escape']);
    expect(keys('timeline', 'edit.split')).toEqual(['Ctrl+KeyB']);
    expect(keys('timeline', 'edit.splitMoved')).toEqual(['KeyS']);
    expect(keys('editor', 'marker.add')).toEqual(['KeyM']);
    expect(keys('lighting', 'lighting.stamp')).toEqual(['KeyM']);
    expect(find('timeline', 'transport.backMany')?.label).toBe('后退 5 帧');
    expect(find('global', 'home.nextSong')?.pages).toEqual(['project']);
    expect(find('global', 'home.prevSong')?.pages).toEqual(['project']);
    expect(PAGE_SCOPES.project).toEqual([]);
  });

  it('界面上写的键从表里读：关掉「单按 Esc 停止」后只写 Shift+Esc', () => {
    expect(commandKeys(KEYMAP, 'transport.stop', 'global')).toEqual(['Escape', 'Shift+Escape']);
    expect(commandKeys(KEYMAP, 'transport.stop', 'global', new Set(['plainEscapeStops']))).toEqual(['Shift+Escape']);
    expect(commandKeys(KEYMAP, 'edit.split', 'timeline')).toEqual(['Ctrl+KeyB']);
    expect(commandKeys(KEYMAP, 'marker.add', 'lighting')).toEqual([]);
  });
});

/** A press on the page body of `page`, every handler there. */
function body(chord: string, overrides: Partial<RouteInput> = {}): RouteInput {
  return { chord, repeat: false, composing: false, owner: null, inTimeline: false, modalOpen: false, overlays: [], drag: 'none', page: 'project',
    available: () => true, song: () => undefined, ...overrides };
}

it('停止键（00-order 第 8 节第 1 题，K7）：Esc 照旧按顺序停止，Shift+Esc 穿过所有层，单按 Esc 可以在设置里关掉', () => {
  for (const entry of KEYMAP.filter(item => item.id === 'transport.stop')) {
    expect(entry.keys).toEqual([{ chord: 'Escape', switch: 'plainEscapeStops' }, { chord: 'Shift+Escape', through: 'all' }]);
  }
  // Shift+Escape is the only key that gets through every layer.
  expect(KEYMAP.flatMap(entry => entry.keys.filter(binding => binding.through === 'all').map(binding => `${entry.scope} ${entry.id} ${binding.chord}`)))
    .toEqual(['global transport.stop Shift+Escape', 'timeline transport.stop Shift+Escape']);
  const stop = { kind: 'run', id: 'transport.stop', scope: 'global' };
  for (const where of [{ modalOpen: true }, { owner: 'dialog' as const }, { owner: 'field' as const }, { owner: 'control' as const }, { owner: 'button' as const }, { drag: 'active' as const },
    { overlays: [{ focusInside: true, blocks: true }] }, {}]) {
    expect(routeKey(body('Shift+Escape', where))).toEqual(stop);
  }
  // A field that records keys still records Shift+Escape.
  expect(routeKey(body('Shift+Escape', { owner: 'capture' }))).toEqual({ kind: 'native' });
  // Escape alone stops as before, until the switch 「单按 Esc 停止」 is turned off.
  expect(routeKey(body('Escape'))).toEqual(stop);
  expect(routeKey(body('Escape', { switchesOff: new Set(['plainEscapeStops']) }))).toEqual({ kind: 'ignore' });
  expect(routeKey(body('Shift+Escape', { switchesOff: new Set(['plainEscapeStops']) }))).toEqual(stop);
});
