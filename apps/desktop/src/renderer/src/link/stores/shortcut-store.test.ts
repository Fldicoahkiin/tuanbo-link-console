import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandKeys } from '../keys/keymap';
import { V1_DEFAULTS } from '../keys/key-settings';
import { commandKeyLabel, currentKeymap, useShortcutStore } from './shortcut-store';

/*
 * The keys on this computer (K8, 04 设计 4.11): saved in `tblink.key-overrides`, only what was changed; 0.5.8's
 * `tblink.timeline-shortcuts` read once and never written, so going back to 0.5.8 finds it unchanged.
 */

let storage: Map<string, string>;
const writes: string[] = [];
const reload = (): void => { useShortcutStore.setState({ loaded: false }); useShortcutStore.getState().load(); };
const state = () => useShortcutStore.getState();

beforeEach(() => {
  storage = new Map();
  writes.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); storage.set(key, value); }
  });
  useShortcutStore.setState({ loaded: false, settings: { keys: {}, stop: null }, switchesOff: new Set(), error: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useShortcutStore.setState({ loaded: false, settings: { keys: {}, stop: null }, switchesOff: new Set(), error: null });
});

describe('旧的灯光快捷键（0.5.8）搬到新格式', () => {
  it('和默认一样的不写；改过的写成灯光工作台的键；旧的键名原样留着，以后也不写', () => {
    const old = JSON.stringify(V1_DEFAULTS.map(binding => binding.action === 'next' ? { ...binding, key: 'Period' } : binding));
    storage.set('tblink.timeline-shortcuts', old);
    reload();
    expect(state().error).toBeNull();
    expect(JSON.parse(storage.get('tblink.key-overrides')!)).toEqual({ version: 1, keys: { lighting: { 'transport.nextFrame': ['Period'] } } });
    expect(commandKeys(currentKeymap(), 'transport.nextFrame', 'lighting')).toEqual(['Period']);
    expect(commandKeys(currentKeymap(), 'lighting.stamp', 'lighting')).toEqual(['KeyM']);
    // Changing keys afterwards never touches the old key: 0.5.8 finds it as it left it.
    state().setKeys('lighting', 'lighting.stamp', ['KeyJ']);
    state().resetAll();
    expect(storage.get('tblink.timeline-shortcuts')).toBe(old);
    expect(writes.filter(key => key === 'tblink.timeline-shortcuts')).toEqual([]);
    // Read once: the new key is there now, the old one is not read again.
    storage.set('tblink.timeline-shortcuts', JSON.stringify(V1_DEFAULTS.map(binding => ({ ...binding, key: `Shift+${binding.key}` }))));
    reload();
    expect(commandKeys(currentKeymap(), 'lighting.stamp', 'lighting')).toEqual(['KeyM']);
  });

  it('只有默认键的旧设置搬过来什么都不改；备用键和删掉的键照搬', () => {
    storage.set('tblink.timeline-shortcuts', JSON.stringify(V1_DEFAULTS));
    reload();
    expect(JSON.parse(storage.get('tblink.key-overrides')!)).toEqual({ version: 1, keys: {} });
    storage.clear();
    storage.set('tblink.timeline-shortcuts', JSON.stringify([...V1_DEFAULTS.filter(binding => binding.action !== 'end'), { id: 'extra', action: 'stamp', key: 'Shift+KeyM' }]));
    reload();
    expect(state().settings.keys).toEqual({ lighting: { 'lighting.stamp': ['KeyM', 'Shift+KeyM'], 'transport.end': [] } });
    expect(commandKeyLabel('transport.end', 'lighting')).toBe('');
  });

  it('旧的键现在撞了新的默认键（打点设成了 N、K、S）：照旧留着，设置页标出来；S 让开，不算撞', async () => {
    const { keyMarks } = await import('../keys/key-settings');
    for (const [key, marked] of [['KeyN', '吸附开关'], ['KeyK', '暂停'], ['KeyS', null]] as const) {
      storage.clear();
      storage.set('tblink.timeline-shortcuts', JSON.stringify(V1_DEFAULTS.map(binding => binding.action === 'stamp' ? { ...binding, key } : binding)));
      reload();
      expect(commandKeys(currentKeymap(), 'lighting.stamp', 'lighting')).toEqual([key]);
      const mark = keyMarks(state().settings).commands.get('lighting lighting.stamp');
      if (marked === null) expect(mark).toBeUndefined(); else expect(mark).toContain(marked);
    }
    expect(currentKeymap().some(entry => entry.id === 'edit.splitMoved')).toBe(false);
  });

  it('读不出来就说出来：用默认键，不写新的键名，旧的照旧留着', () => {
    storage.set('tblink.timeline-shortcuts', 'invalid');
    reload();
    expect(state().error).toContain('读取失败');
    expect(storage.has('tblink.key-overrides')).toBe(false);
    expect(commandKeys(currentKeymap(), 'lighting.stamp', 'lighting')).toEqual(['KeyM']);
    storage.set('tblink.key-overrides', JSON.stringify({ version: 1, keys: { timeline: { 'edit.copy': ['KeyC'] } } }));
    reload();
    expect(state().error).toContain('不是能改的键');
    storage.set('tblink.key-overrides', '{"version":2}');
    reload();
    expect(state().error).toContain('读取失败');
    expect(storage.get('tblink.timeline-shortcuts')).toBe('invalid');
  });
});

describe('改键', () => {
  it('改了立即生效，重新打开还在；和默认一样就不存；界面上的键名跟着变', () => {
    reload();
    state().setKeys('timeline', 'edit.split', ['KeyX']);
    expect(commandKeyLabel('edit.split', 'timeline')).toBe('X');
    reload();
    expect(commandKeyLabel('edit.split', 'timeline')).toBe('X');
    state().resetKeys('timeline', 'edit.split');
    expect(JSON.parse(storage.get('tblink.key-overrides')!)).toEqual({ version: 1, keys: {} });
    expect(commandKeyLabel('edit.split', 'timeline')).toBe('Ctrl+B');
  });

  it('撞了别的操作就拒绝，说出是哪一个；同一个操作在别的范围不算撞', () => {
    reload();
    expect(() => state().setKeys('editor', 'edit.trimLeft', ['KeyW'])).toThrow('「向右裁剪」');
    expect(() => state().setKeys('timeline', 'view.snap', ['KeyQ'])).toThrow('向左裁剪');
    expect(() => state().setKeys('lighting', 'lighting.stamp', ['KeyN'])).toThrow('吸附开关');
    expect(() => state().setKeys('timeline', 'edit.duplicate', ['Ctrl+KeyS'])).toThrow('保存工程');
    // Ctrl+Alt+S saves too (key-route.ts documentChord).
    expect(() => state().setKeys('timeline', 'edit.duplicate', ['Ctrl+Alt+KeyS'])).toThrow('保存工程');
    expect(() => state().setKeys('timeline', 'edit.duplicate', ['Ctrl+KeyX'])).toThrow('剪切画面片段');
    expect(() => state().setKeys('editor', 'marker.add', ['Space'])).toThrow('播放');
    expect(() => state().setKeys('lighting', 'transport.start', ['Shift+Escape'])).toThrow('Esc');
    expect(() => state().setKeys('lighting', 'transport.start', ['Meta+KeyH'])).toThrow('Windows');
    expect(() => state().setKeys('timeline', 'edit.copy', ['KeyC'])).toThrow('不能改');
    // M is the editor's marker and the workbench's stamp: two pages, no clash. ↑ is the home page's, not the editor's.
    state().setKeys('editor', 'transport.start', ['KeyH']);
    state().setKeys('lighting', 'transport.start', ['KeyH']);
    state().setKeys('editor', 'marker.add', ['KeyJ']);
    state().setKeys('lighting', 'lighting.stamp', ['KeyJ']);
    expect(storage.has('tblink.timeline-shortcuts')).toBe(false);
  });

  it('把 S 设回分割：提示 S 改了的那一条让开，S 分割', () => {
    reload();
    state().setKeys('timeline', 'edit.split', ['Ctrl+KeyB', 'KeyS']);
    expect(currentKeymap().some(entry => entry.id === 'edit.splitMoved')).toBe(false);
    expect(commandKeyLabel('edit.split', 'timeline')).toBe('Ctrl+B 或 S');
    state().resetKeys('timeline', 'edit.split');
    expect(currentKeymap().some(entry => entry.id === 'edit.splitMoved')).toBe(true);
  });

  it('随时停止的键：能改，记住，空格、单键、系统键和别的键都不行', () => {
    reload();
    state().setStopKey('Ctrl+F12');
    expect(commandKeyLabel('transport.stop', 'global')).toBe('Esc 或 Ctrl+F12');
    expect(commandKeyLabel('transport.stop', 'timeline')).toBe('Esc 或 Ctrl+F12');
    reload();
    expect(commandKeyLabel('transport.stop', 'global')).toBe('Esc 或 Ctrl+F12');
    expect(() => state().setStopKey('Ctrl+KeyB')).toThrow('在播放头分割');
    expect(() => state().setStopKey('Alt+F4')).toThrow('Windows');
    state().setStopKey('Shift+Escape');
    expect(JSON.parse(storage.get('tblink.key-overrides')!)).toEqual({ version: 1, keys: {} });
  });
});
