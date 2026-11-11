import { create } from 'zustand';
import { z } from 'zod';
import { chordLabel, chordOf } from '../keys/key-chord';

export const shortcutActions = { stamp: '在播放头打点', play: '播放 / 暂停', previous: '后退一帧', next: '前进一帧', start: '回到开头', end: '跳到结尾' } as const;
const actionSchema = z.enum(['stamp', 'play', 'previous', 'next', 'start', 'end']);
const bindingSchema = z.object({ id: z.string(), action: actionSchema, key: z.string().min(1) });
export type ShortcutBinding = z.infer<typeof bindingSchema>;
export const defaultShortcuts: ShortcutBinding[] = (['KeyM', 'Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const).map((key, index) => ({ id: key, action: actionSchema.options[index]!, key }));
const storageKey = 'tblink.timeline-shortcuts';
/** The chord a key press is saved and looked up as (`chordOf`, Meta included). */
export function shortcutKey(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string { return chordOf(event); }
/** The name of a saved key as people read it (`chordLabel`). */
export function shortcutLabel(key: string): string { return chordLabel(key); }
export function validateShortcuts(value: unknown): ShortcutBinding[] {
  const bindings = z.array(bindingSchema).parse(value);
  if (new Set(bindings.map(binding => binding.key)).size !== bindings.length) throw new Error('快捷键重复，请为每个操作使用不同的按键');
  return bindings;
}
export const useShortcutStore = create<{ bindings: ShortcutBinding[]; loaded: boolean; error: string | null; load: () => void; save: (bindings: ShortcutBinding[]) => void }>((set, get) => ({
  bindings: defaultShortcuts, loaded: false, error: null,
  load: () => {
    if (get().loaded) return;
    try { const saved = localStorage.getItem(storageKey); set({ bindings: saved === null ? defaultShortcuts : validateShortcuts(JSON.parse(saved)), loaded: true }); }
    catch (error) { set({ bindings: [], loaded: true, error: `快捷键读取失败：${String(error)}。请在设置里恢复默认快捷键。` }); }
  },
  save: (bindings) => {
    const validated = validateShortcuts(bindings);
    localStorage.setItem(storageKey, JSON.stringify(validated));
    set({ bindings: validated, loaded: true, error: null });
  }
}));
