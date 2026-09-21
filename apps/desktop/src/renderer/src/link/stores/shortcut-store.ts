import { create } from 'zustand';
import { z } from 'zod';

export const shortcutActions = { stamp: '在播放头打点', play: '播放 / 暂停', previous: '后退一帧', next: '前进一帧', start: '回到开头', end: '跳到结尾' } as const;
const actionSchema = z.enum(['stamp', 'play', 'previous', 'next', 'start', 'end']);
const bindingSchema = z.object({ id: z.string(), action: actionSchema, key: z.string().min(1) });
export type ShortcutBinding = z.infer<typeof bindingSchema>;
export const defaultShortcuts: ShortcutBinding[] = (['KeyM', 'Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const).map((key, index) => ({ id: key, action: actionSchema.options[index]!, key }));
const storageKey = 'tblink.timeline-shortcuts';
export function shortcutKey(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  return [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.metaKey ? ['Meta'] : []), event.code].join('+');
}
export function shortcutLabel(key: string): string { return key.replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1').replace('Space', '空格'); }
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
    catch (error) { set({ bindings: [], loaded: true, error: `快捷键加载失败：${String(error)}。请在设置中恢复默认。` }); }
  },
  save: (bindings) => {
    const validated = validateShortcuts(bindings);
    localStorage.setItem(storageKey, JSON.stringify(validated));
    set({ bindings: validated, loaded: true, error: null });
  }
}));
