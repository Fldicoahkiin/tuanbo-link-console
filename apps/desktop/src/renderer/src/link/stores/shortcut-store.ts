import { create } from 'zustand';
import { z } from 'zod';
import { chordLabel, type KeyChord } from '../keys/key-chord';
import { commandKeys, type CommandId, type KeyEntry, type KeyScope, type KeySwitch } from '../keys/keymap';
import {
  failureText, keyProblem, KEY_SETTINGS_STORAGE, migrateV1, NO_CHANGES, parseKeySettings, serializeKeySettings, settingsKeymap, stopKeyProblem,
  tableKeys, V1_STORAGE, withKeys, withStop, type KeySettings
} from '../keys/key-settings';

/*
 * The keys on this computer (K8): the ones the user changed (keys/key-settings.ts, saved in `tblink.key-overrides`)
 * and the switches (`tblink.key-switches`). The key router reads them on every press (`currentKeymap`,
 * `currentSwitchesOff`); the names of the keys on screen too (`commandKeyLabel`, `commandShortcut`), so a change shows
 * at once. 0.5.8's `tblink.timeline-shortcuts` is read once to move its keys over and never written.
 */

let resolved: { settings: KeySettings; keymap: readonly KeyEntry[] } | null = null;
/** The key table with this computer's keys (key-router.ts reads it for every press). */
export function currentKeymap(): readonly KeyEntry[] {
  const store = useShortcutStore.getState();
  if (!store.loaded) store.load();
  const { settings } = useShortcutStore.getState();
  if (resolved?.settings !== settings) resolved = { settings, keymap: settingsKeymap(settings) };
  return resolved.keymap;
}

/**
 * The keys turned off on this computer (keys/keymap.ts `KeySwitch`): `{ "off": ["plainEscapeStops"] }`. Every key is
 * on when nothing is saved.
 */
const switchesKey = 'tblink.key-switches';
const switchesSchema = z.object({ off: z.array(z.enum(['plainEscapeStops'])) });

/** The keys turned off on this computer (key-router.ts reads it for every press). */
export function currentSwitchesOff(): ReadonlySet<KeySwitch> {
  const store = useShortcutStore.getState();
  if (!store.loaded) store.load();
  return useShortcutStore.getState().switchesOff;
}

/**
 * How a command's keys are written in the app (the toolbar, menus, hints): its keys that work now, 「或」 between them.
 * A component that keeps showing it reads the store (`useKeyNames`) so it follows a change.
 */
export function commandKeyLabel(id: CommandId, scope: KeyScope): string {
  return commandKeys(currentKeymap(), id, scope, currentSwitchesOff()).map(chordLabel).join(' 或 ');
}

/** The first key of a command that works now, as a menu item shows it beside its name; '' without one. */
export function commandShortcut(id: CommandId, scope: KeyScope): string {
  const first = commandKeys(currentKeymap(), id, scope, currentSwitchesOff())[0];
  return first === undefined ? '' : chordLabel(first);
}

/** Redraws the component when the keys or the switches change, for the key names it shows (`commandKeyLabel`). */
export function useKeyNames(): void {
  useShortcutStore(state => state.settings);
  useShortcutStore(state => state.switchesOff);
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

/** Saves `settings`; throws a sentence when the page storage refuses. */
function write(settings: KeySettings): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(KEY_SETTINGS_STORAGE, serializeKeySettings(settings)); }
  catch (error) { throw new Error(`快捷键没有保存成功：${failureText(error)}。请再试一次。`); }
}

/** The settings saved on this computer, 0.5.8's moved over when there are none yet; the problems met on the way. */
function readSettings(): { settings: KeySettings; errors: string[] } {
  try {
    const saved = localStorage.getItem(KEY_SETTINGS_STORAGE);
    if (saved !== null) return { settings: parseKeySettings(saved), errors: [] };
    const old = localStorage.getItem(V1_STORAGE);
    if (old === null) return { settings: NO_CHANGES, errors: [] };
    const settings = migrateV1(old);
    try { write(settings); return { settings, errors: [] }; }
    catch (error) { return { settings, errors: [`${failureText(error)}下次打开时会再搬一次。`] }; }
  } catch (error) {
    return { settings: NO_CHANGES, errors: [`快捷键设置读取失败：${failureText(error)}。现在用的是默认快捷键；改过的键请在设置的「快捷键」里重新设一次。`] };
  }
}

type ShortcutState = {
  /** What the user changed (keys/key-settings.ts). */
  settings: KeySettings;
  switchesOff: ReadonlySet<KeySwitch>;
  loaded: boolean;
  /** Why the saved keys or switches could not be read; shown on the settings page and beside the 打点 button. */
  error: string | null;
  load: () => void;
  /** Gives `id` in `scope` these keys; throws a sentence when it cannot (`keyProblem`) or saving fails. */
  setKeys: (scope: KeyScope, id: CommandId, chords: readonly KeyChord[]) => void;
  /** The table's keys again for `id` in `scope`; throws when another command has one of them now. */
  resetKeys: (scope: KeyScope, id: CommandId) => void;
  /** The stop key that gets through everything; throws when it cannot be (`stopKeyProblem`). */
  setStopKey: (chord: KeyChord) => void;
  /** Every key the table's again. */
  resetAll: () => void;
  setSwitch: (name: KeySwitch, on: boolean) => void;
};

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  settings: NO_CHANGES, switchesOff: new Set(), loaded: false, error: null,
  load: () => {
    if (get().loaded) return;
    // No page storage (the unit tests): the table's own keys, every key on.
    if (typeof localStorage === 'undefined') { set({ loaded: true }); return; }
    const { settings, errors } = readSettings();
    let switchesOff: ReadonlySet<KeySwitch> = new Set();
    try { const saved = localStorage.getItem(switchesKey); if (saved !== null) switchesOff = new Set(switchesSchema.parse(JSON.parse(saved)).off); }
    catch (error) { errors.push(`「单按 Esc 停止」的设置读取失败：${failureText(error)}。现在按打开处理，请在设置里重新选一次。`); }
    set({ settings, switchesOff, loaded: true, error: errors.length ? errors.join(' ') : null });
  },
  setKeys: (scope, id, chords) => {
    get().load();
    const before = commandKeys(currentKeymap(), id, scope);
    const next = withKeys(get().settings, scope, id, chords);
    const problem = keyProblem(settingsKeymap(next), scope, id, chords.filter(chord => !before.includes(chord)));
    if (problem) throw new Error(problem);
    write(next);
    set({ settings: next, error: null });
  },
  resetKeys: (scope, id) => get().setKeys(scope, id, tableKeys(scope, id)),
  setStopKey: (chord) => {
    get().load();
    const next = withStop(get().settings, chord);
    const problem = stopKeyProblem(settingsKeymap(next), chord);
    if (problem) throw new Error(problem);
    write(next);
    set({ settings: next, error: null });
  },
  resetAll: () => {
    get().load();
    write(NO_CHANGES);
    set({ settings: NO_CHANGES, error: null });
  },
  setSwitch: (name, on) => {
    get().load();
    const next = new Set(get().switchesOff);
    if (on) next.delete(name); else next.add(name);
    localStorage.setItem(switchesKey, JSON.stringify({ off: [...next] }));
    set({ switchesOff: next });
  }
}));
