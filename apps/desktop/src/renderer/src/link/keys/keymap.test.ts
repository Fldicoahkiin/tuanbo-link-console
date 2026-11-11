import { describe, expect, it } from 'vitest';
import { isSystemChord, parseChord } from './key-chord';
import { routeKey, type RouteInput } from './key-route';
import { KEYMAP, PAGE_SCOPES, type KeyEntry, type KeyScope } from './keymap';

const chordsOf = (scope: KeyScope): string[] => KEYMAP.filter(entry => entry.scope === scope).flatMap(entry => entry.keys.map(binding => binding.chord));

describe('快捷键表的自检', () => {
  it('同一范围里没有重复的键，同一条命令在同一范围只出现一次', () => {
    for (const scope of new Set(KEYMAP.map(entry => entry.scope))) {
      const chords = chordsOf(scope);
      expect(new Set(chords).size, `${scope} 里有重复的键`).toBe(chords.length);
      const ids = KEYMAP.filter(entry => entry.scope === scope).map(entry => entry.id);
      expect(new Set(ids).size, `${scope} 里有重复的命令`).toBe(ids.length);
    }
  });

  it('页面自己的键（编辑器、灯光工作台）和两页共用的时间线不重复；灯光点和时间线重复的只有现在已知的两份实现（04 设计 3.3 b、d，K6 合并）', () => {
    const timeline = new Set(chordsOf('timeline'));
    for (const scope of ['editor', 'lighting'] as const) expect(chordsOf(scope).filter(chord => timeline.has(chord))).toEqual([]);
    expect(chordsOf('lighting-points').filter(chord => timeline.has(chord)).sort()).toEqual(['Ctrl+KeyC', 'Ctrl+KeyV', 'Delete']);
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

  it('表按现在的键写：Esc 停止、S 分割、Shift+←/→ 一秒、↑↓ 换歌在所有页面（焦点不在时间线上时）', () => {
    const find = (scope: KeyScope, id: KeyEntry['id']) => KEYMAP.find(entry => entry.scope === scope && entry.id === id);
    expect(find('global', 'transport.stop')?.keys.map(binding => binding.chord)).toEqual(['Escape']);
    expect(find('timeline', 'transport.stop')?.keys.map(binding => binding.chord)).toEqual(['Escape']);
    expect(find('timeline', 'edit.split')?.keys.map(binding => binding.chord)).toEqual(['KeyS']);
    expect(find('editor', 'transport.backMany')?.label).toBe('后退一秒');
    expect(find('global', 'home.nextSong')?.area).toBe('outside-timeline');
    expect(PAGE_SCOPES.project).toEqual([]);
  });
});

/** A press on the page body of `page`, every handler there. */
function body(chord: string, overrides: Partial<RouteInput> = {}): RouteInput {
  return { chord, repeat: false, composing: false, owner: null, inTimeline: false, modalOpen: false, overlays: [], drag: 'none', page: 'project',
    available: () => true, song: () => undefined, ...overrides };
}

it('停止键的位置已经留好（00-order 第 8 节第 1 题，K7 才上线）：一条命令可以有两个键，Shift+Esc 穿过所有层，单按 Esc 可以被设置关掉；现在表里只有 Esc', () => {
  // Today: Escape only, the one a switch can turn off, and nothing gets through every layer.
  for (const entry of KEYMAP.filter(item => item.id === 'transport.stop')) {
    expect(entry.keys).toEqual([{ chord: 'Escape', switch: 'plainEscapeStops' }]);
  }
  expect(KEYMAP.flatMap(entry => entry.keys).filter(binding => binding.through === 'all')).toEqual([]);
  expect(routeKey(body('Shift+Escape', { modalOpen: true }))).toEqual({ kind: 'native' });

  // The same table with K7's stop key, as one place says it: Escape takes its turn, Shift+Escape gets through all.
  const k7 = KEYMAP.map(entry => entry.id === 'transport.stop'
    ? { ...entry, keys: [{ chord: 'Escape', switch: 'plainEscapeStops' as const }, { chord: 'Shift+Escape', through: 'all' as const }] } : entry);
  const stop = { kind: 'run', id: 'transport.stop', scope: 'global' };
  for (const where of [{ modalOpen: true }, { owner: 'dialog' as const }, { owner: 'field' as const }, { owner: 'control' as const }, { drag: 'active' as const },
    { overlays: [{ focusInside: true, blocks: true }] }, {}]) {
    expect(routeKey(body('Shift+Escape', { keymap: k7, ...where }))).toEqual(stop);
  }
  // A field that records keys still records Shift+Escape.
  expect(routeKey(body('Shift+Escape', { keymap: k7, owner: 'capture' }))).toEqual({ kind: 'native' });
  // Escape alone stops as today, until the switch 「单按 Esc 停止」 is turned off.
  expect(routeKey(body('Escape', { keymap: k7 }))).toEqual(stop);
  expect(routeKey(body('Escape', { keymap: k7, switchesOff: new Set(['plainEscapeStops']) }))).toEqual({ kind: 'ignore' });
  expect(routeKey(body('Shift+Escape', { keymap: k7, switchesOff: new Set(['plainEscapeStops']) }))).toEqual(stop);
});
