import { describe, expect, it, vi } from 'vitest';
import { defaultShortcuts, shortcutKey, useShortcutStore, validateShortcuts } from './shortcut-store';

describe('快捷键配置', () => {
  it('拒绝同一组合重复绑定，允许给打点添加备用组合', () => {
    expect(() => validateShortcuts([...defaultShortcuts, { id: 'duplicate', action: 'next', key: 'KeyM' }])).toThrow('重复');
    expect(validateShortcuts([...defaultShortcuts, { id: 'extra', action: 'stamp', key: 'Shift+KeyM' }])).toHaveLength(7);
    expect(shortcutKey({ code: 'KeyM', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })).toBe('Shift+KeyM');
  });
  it('修改后保存本机并可重新加载，损坏配置明确报错且不启用默认键', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    try {
      const changed = defaultShortcuts.map(binding => binding.action === 'stamp' ? { ...binding, key: 'KeyK' } : binding);
      useShortcutStore.getState().save(changed);
      useShortcutStore.setState({ bindings: [], loaded: false }); useShortcutStore.getState().load();
      expect(useShortcutStore.getState().bindings).toEqual(changed);
      storage.set('tblink.timeline-shortcuts', 'invalid');
      useShortcutStore.setState({ loaded: false }); useShortcutStore.getState().load();
      expect(useShortcutStore.getState().error).toContain('读取失败');
      expect(useShortcutStore.getState().bindings).toEqual([]);
    } finally { vi.unstubAllGlobals(); useShortcutStore.setState({ loaded: false, bindings: defaultShortcuts, error: null }); }
  });
});
