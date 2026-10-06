import { create } from 'zustand';
import { beautyLibrarySchema, beautyValuesSchema, neutralBeautyValues, type BeautyLibrary, type BeautyParameter, type BeautyValues } from '@tb/schema';

const STORAGE_KEY = 'tblink.beauty.library.1';
const initial = (): BeautyLibrary => ({ format: 'tblink-beauty', version: 1, values: { ...neutralBeautyValues }, presets: [] });
type State = {
  panelOpen: boolean; setPanelOpen: (open: boolean) => void;
  library: BeautyLibrary; loaded: boolean; error: string | null; saved: boolean;
  past: BeautyValues[]; future: BeautyValues[]; gesture: BeautyValues | null;
  load: () => void; begin: () => void; end: () => void;
  change: (key: BeautyParameter, value: number) => void;
  replace: (values: BeautyValues) => void; undo: () => void; redo: () => void;
  save: () => void; savePreset: (name: string) => boolean; deletePreset: (id: string) => void;
  importLibrary: (content: string) => void; clearError: () => void;
};
const same = (a: BeautyValues, b: BeautyValues): boolean => JSON.stringify(a) === JSON.stringify(b);
const history = (past: BeautyValues[], value: BeautyValues): BeautyValues[] => [...past.slice(-49), value];

export const useBeautyStore = create<State>((set, get) => ({
  panelOpen: false, setPanelOpen: panelOpen => set({ panelOpen }),
  library: initial(), loaded: false, error: null, saved: false, past: [], future: [], gesture: null,
  load: () => {
    if (get().loaded) return;
    try {
      const content = localStorage.getItem(STORAGE_KEY);
      set({ library: content ? beautyLibrarySchema.parse(JSON.parse(content)) : initial(), loaded: true, saved: Boolean(content) });
    } catch (error) { set({ loaded: true, error: `读取美颜预设失败，原存储未覆盖：${String(error)}` }); }
  },
  begin: () => { if (!get().gesture) set({ gesture: get().library.values }); },
  end: () => {
    const { gesture, library, past } = get();
    if (gesture && !same(gesture, library.values)) set({ past: history(past, gesture), future: [] });
    set({ gesture: null });
  },
  change: (key, value) => {
    if (!Number.isFinite(value)) return;
    const values = beautyValuesSchema.parse({ ...get().library.values, [key]: value });
    set({ library: { ...get().library, values }, saved: false });
  },
  replace: values => {
    get().end();
    const state = get();
    const parsed = beautyValuesSchema.parse(values);
    if (same(parsed, state.library.values)) return;
    set({ library: { ...state.library, values: parsed }, past: history(state.past, state.library.values), future: [], saved: false });
  },
  undo: () => {
    get().end(); const state = get(); const values = state.past.at(-1); if (!values) return;
    set({ library: { ...state.library, values }, past: state.past.slice(0, -1), future: [...state.future, state.library.values], saved: false });
  },
  redo: () => {
    get().end(); const state = get(); const values = state.future.at(-1); if (!values) return;
    set({ library: { ...state.library, values }, future: state.future.slice(0, -1), past: history(state.past, state.library.values), saved: false });
  },
  save: () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(beautyLibrarySchema.parse(get().library))); set({ saved: true, error: null }); }
    catch (error) { set({ saved: false, error: `保存美颜预设失败：${String(error)}` }); }
  },
  savePreset: name => {
    const trimmed = name.trim(); const state = get();
    if (!trimmed || trimmed.length > 30) { set({ error: '预设名称需要 1–30 个字符' }); return false; }
    if (state.library.presets.length >= 30) { set({ error: '最多保存 30 个预设，请先删除不需要的预设' }); return false; }
    if (state.library.presets.some(preset => preset.name === trimmed)) { set({ error: '已有同名预设，请使用其他名称' }); return false; }
    set({ library: { ...state.library, presets: [...state.library.presets, { id: crypto.randomUUID(), name: trimmed, values: { ...state.library.values } }] }, saved: false });
    get().save(); return get().saved;
  },
  deletePreset: id => { set({ library: { ...get().library, presets: get().library.presets.filter(preset => preset.id !== id) }, saved: false }); get().save(); },
  importLibrary: content => {
    try {
      if (content.length > 128_000) throw new Error('文件超过 128 KB');
      const library = beautyLibrarySchema.parse(JSON.parse(content));
      get().end(); set({ library, past: [], future: [], error: null, saved: false });
    } catch (error) { set({ error: `导入失败，当前参数未改变：${String(error)}` }); }
  },
  clearError: () => set({ error: null })
}));
