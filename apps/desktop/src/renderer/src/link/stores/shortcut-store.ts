import { create } from 'zustand';
import { z } from 'zod';
import { chordLabel, chordOf } from '../keys/key-chord';
import { commandKeys, KEYMAP, resolveKeymap, type CommandId, type KeyEntry, type KeyOverrides, type KeyScope, type KeySwitch } from '../keys/keymap';

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

/** The command of the key table each of the lighting workbench's six saved keys presses (keys/keymap.ts, `lighting`). */
const LIGHTING_COMMANDS = { stamp: 'lighting.stamp', play: 'transport.playPause', previous: 'transport.prevFrame', next: 'transport.nextFrame', start: 'transport.start', end: 'transport.end' } as const satisfies Record<ShortcutBinding['action'], CommandId>;

/**
 * The saved lighting keys (`tblink.timeline-shortcuts`, as 0.5.8 saves them) as the key table's own keys for the
 * lighting workbench: every action with the keys saved for it, none when nothing is saved for it (a setting that could
 * not be read leaves none). Read only: the saved keys stay as they are, so 0.5.8 still reads them.
 */
export function lightingKeyOverrides(bindings: readonly ShortcutBinding[]): KeyOverrides {
  return { lighting: Object.fromEntries(Object.entries(LIGHTING_COMMANDS).map(([action, id]) => [id, bindings.filter(binding => binding.action === action).map(binding => binding.key)])) };
}

let resolved: { bindings: readonly ShortcutBinding[]; keymap: readonly KeyEntry[] } | null = null;
/** The key table with this computer's lighting keys (key-router.ts reads it for every press). */
export function currentKeymap(): readonly KeyEntry[] {
  const { bindings } = useShortcutStore.getState();
  if (resolved?.bindings !== bindings) resolved = { bindings, keymap: resolveKeymap(KEYMAP, lightingKeyOverrides(bindings)) };
  return resolved.keymap;
}

/**
 * The keys turned off on this computer (keys/keymap.ts `KeySwitch`), saved apart from the lighting keys so that 0.5.8
 * still reads those (`tblink.timeline-shortcuts`): `{ "off": ["plainEscapeStops"] }`. Every key is on when nothing is saved.
 */
const switchesKey = 'tblink.key-switches';
const switchesSchema = z.object({ off: z.array(z.enum(['plainEscapeStops'])) });

/** The keys turned off on this computer (key-router.ts reads it for every press). */
export function currentSwitchesOff(): ReadonlySet<KeySwitch> {
  const store = useShortcutStore.getState();
  if (!store.loaded) store.load();
  return useShortcutStore.getState().switchesOff;
}

/** How a command's keys are written in the app (the toolbar, menus, hints): its keys that work now, 「或」 between them. */
export function commandKeyLabel(id: CommandId, scope: KeyScope): string {
  return commandKeys(currentKeymap(), id, scope, currentSwitchesOff()).map(chordLabel).join(' 或 ');
}

/** The first key of a command that works now, as a menu item shows it beside its name; '' without one. */
export function commandShortcut(id: CommandId, scope: KeyScope): string {
  const first = commandKeys(currentKeymap(), id, scope, currentSwitchesOff())[0];
  return first === undefined ? '' : chordLabel(first);
}

/** Whether this computer was told once that S no longer splits (split is Ctrl+B since 0.5.9, as in 剪映). */
const splitHintKey = 'tblink.split-key-hint';
export function splitHintShown(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(splitHintKey) !== null;
}
/** Remembers the hint was shown; false when it already was. */
export function markSplitHintShown(): boolean {
  if (splitHintShown()) return false;
  if (typeof localStorage !== 'undefined') localStorage.setItem(splitHintKey, 'shown');
  return true;
}

type ShortcutState = {
  bindings: ShortcutBinding[]; switchesOff: ReadonlySet<KeySwitch>; loaded: boolean; error: string | null;
  load: () => void; save: (bindings: ShortcutBinding[]) => void; setSwitch: (name: KeySwitch, on: boolean) => void;
};

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  bindings: defaultShortcuts, switchesOff: new Set(), loaded: false, error: null,
  load: () => {
    if (get().loaded) return;
    // No page storage (the unit tests): the table's own keys, every key on.
    if (typeof localStorage === 'undefined') { set({ loaded: true }); return; }
    const errors: string[] = [];
    let bindings: ShortcutBinding[] = defaultShortcuts, switchesOff: ReadonlySet<KeySwitch> = new Set();
    try { const saved = localStorage.getItem(storageKey); if (saved !== null) bindings = validateShortcuts(JSON.parse(saved)); }
    catch (error) { bindings = []; errors.push(`快捷键读取失败：${String(error)}。请在设置里恢复默认快捷键。`); }
    try { const saved = localStorage.getItem(switchesKey); if (saved !== null) switchesOff = new Set(switchesSchema.parse(JSON.parse(saved)).off); }
    catch (error) { errors.push(`「单按 Esc 停止」的设置读取失败：${String(error)}。现在按打开处理，请在设置里重新选一次。`); }
    set({ bindings, switchesOff, loaded: true, error: errors.length ? errors.join(' ') : null });
  },
  save: (bindings) => {
    const validated = validateShortcuts(bindings);
    localStorage.setItem(storageKey, JSON.stringify(validated));
    set({ bindings: validated, loaded: true, error: null });
  },
  setSwitch: (name, on) => {
    get().load();
    const next = new Set(get().switchesOff);
    if (on) next.delete(name); else next.add(name);
    localStorage.setItem(switchesKey, JSON.stringify({ off: [...next] }));
    set({ switchesOff: next });
  }
}));
