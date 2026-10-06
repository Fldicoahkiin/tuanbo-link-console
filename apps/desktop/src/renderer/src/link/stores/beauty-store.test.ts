import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { neutralBeautyValues } from '@tb/schema';
import { useBeautyStore } from './beauty-store';

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) });
  useBeautyStore.setState({ library: { format: 'tblink-beauty', version: 1, values: { ...neutralBeautyValues }, presets: [] }, loaded: false, saved: false, error: null, past: [], future: [], gesture: null });
});
afterEach(() => vi.unstubAllGlobals());

it('既有预设缺少色调时保留原妆色；新色调可保存与撤销且不改变浓度', () => {
  const store = useBeautyStore.getState();
  const oldValues = Object.fromEntries(Object.entries(neutralBeautyValues).filter(([key]) => key !== 'lipstickTone' && key !== 'blushTone'));
  store.importLibrary(JSON.stringify({ format: 'tblink-beauty', version: 1, values: { ...oldValues, lipstick: 35 }, presets: [] }));
  expect(useBeautyStore.getState().error).toBeNull();
  expect(useBeautyStore.getState().library.values.lipstickTone).toBe(0);
  store.begin(); store.change('lipstickTone', -100); store.end();
  expect(useBeautyStore.getState().library.values.lipstick).toBe(35);
  store.undo(); expect(useBeautyStore.getState().library.values.lipstickTone).toBe(0);
  store.redo(); store.save();
  useBeautyStore.setState({ loaded: false }); store.load();
  expect(useBeautyStore.getState().library.values.lipstickTone).toBe(-100);
  expect(useBeautyStore.getState().library.values.lipstick).toBe(35);
});

it('一次滑动产生一次历史记录；替换预设后可撤销且新编辑清除重做', () => {
  const store = useBeautyStore.getState();
  store.begin(); store.change('smooth', 10); store.change('smooth', 20); store.change('smooth', 30); store.end();
  expect(useBeautyStore.getState().past).toHaveLength(1);
  store.undo(); expect(useBeautyStore.getState().library.values.smooth).toBe(0);
  store.redo(); expect(useBeautyStore.getState().library.values.smooth).toBe(30);
  store.undo(); store.replace({ ...neutralBeautyValues, slim: 40 });
  expect(useBeautyStore.getState().future).toHaveLength(0);
});

it('非法、未知版本、重复 ID 的导入保留原数据；合法导入不自动覆盖已保存内容', () => {
  const store = useBeautyStore.getState(); store.replace({ ...neutralBeautyValues, smooth: 25 }); store.save();
  const before = useBeautyStore.getState().library;
  for (const content of ['{', JSON.stringify({ ...before, version: 2 }), JSON.stringify({ ...before, values: { ...before.values, eye: 101 } }),
    JSON.stringify({ ...before, presets: [{ id: 'a', name: 'a', values: before.values }, { id: 'a', name: 'b', values: before.values }] })]) {
    store.importLibrary(content); expect(useBeautyStore.getState().library).toBe(before); expect(useBeautyStore.getState().error).toContain('导入失败');
  }
  store.importLibrary(JSON.stringify({ ...before, values: { ...before.values, eye: 12 } }));
  expect(useBeautyStore.getState().library.values.eye).toBe(12);
  useBeautyStore.setState({ loaded: false }); store.load();
  expect(useBeautyStore.getState().library.values.eye).toBe(0);
});

it('保存失败显示错误且不能声称已保存；预设名称不覆盖同名条目', () => {
  const store = useBeautyStore.getState(); expect(store.savePreset('日场')).toBe(true);
  expect(store.savePreset('日场')).toBe(false); expect(useBeautyStore.getState().library.presets).toHaveLength(1);
  vi.stubGlobal('localStorage', { setItem: () => { throw new Error('磁盘空间不足'); } });
  store.replace({ ...neutralBeautyValues, white: 10 }); store.save();
  expect(useBeautyStore.getState().saved).toBe(false); expect(useBeautyStore.getState().error).toContain('磁盘空间不足');
});
