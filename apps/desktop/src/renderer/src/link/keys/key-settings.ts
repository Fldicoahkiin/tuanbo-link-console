import { z } from 'zod';
import { chordLabel, isSystemChord, parseChord, type KeyChord } from './key-chord';
import { documentChord } from './key-route';
import { KEYMAP, PAGE_SCOPES, resolveKeymap, STOP_ANYWHERE, type CommandId, type KeyEntry, type KeyOverrides, type KeyPage, type KeyScope } from './keymap';

/*
 * The keys the user changed on this computer (K8, 04 设计 4.11): how they are saved, what a key may be, and when two
 * commands would want the same key. Pure functions; the store (stores/shortcut-store.ts) keeps the state and saves it.
 *
 * Saved in `tblink.key-overrides`, only what differs from the table (keymap.ts):
 *   { "version": 1, "keys": { "lighting": { "lighting.stamp": ["KeyK"] } }, "stop": "Ctrl+F12" }
 * 0.5.8 saved the lighting workbench's six keys in `tblink.timeline-shortcuts`. It is read once, when the new key is
 * not there yet, and never written: going back to 0.5.8 finds it as it left it.
 */

/** What the user changed: keys by scope and command, and the stop key that gets through everything (null: Shift+Esc). */
export type KeySettings = { keys: KeyOverrides; stop: KeyChord | null };
export const NO_CHANGES: KeySettings = { keys: {}, stop: null };

export const KEY_SETTINGS_STORAGE = 'tblink.key-overrides';
/** 0.5.8's lighting keys: read once to move them, never written. */
export const V1_STORAGE = 'tblink.timeline-shortcuts';

/** The key table with `settings` in it, what the router and every key name read. */
export function settingsKeymap(settings: KeySettings, keymap: readonly KeyEntry[] = KEYMAP): readonly KeyEntry[] {
  return resolveKeymap(keymap, settings.keys, settings.stop ?? STOP_ANYWHERE);
}

/** The command's keys in the table itself. */
export function tableKeys(scope: KeyScope, id: CommandId): readonly KeyChord[] {
  return KEYMAP.find(entry => entry.scope === scope && entry.id === id)?.keys.map(binding => binding.chord) ?? [];
}

const ALL_SCOPES: readonly KeyScope[] = ['global', 'home', 'editor', 'lighting', 'timeline', 'lighting-points'];
const sameKeys =(a: readonly KeyChord[], b: readonly KeyChord[]): boolean => a.length === b.length && a.every((chord, index) => chord === b[index]);

/** `settings` with `chords` for `id` in `scope`, left out when they are the table's. */
export function withKeys(settings: KeySettings, scope: KeyScope, id: CommandId, chords: readonly KeyChord[]): KeySettings {
  const commands: Partial<Record<CommandId, readonly KeyChord[]>> = {};
  for (const entry of KEYMAP.filter(item => item.scope === scope)) {
    const keys = entry.id !== id ? settings.keys[scope]?.[entry.id] : sameKeys(chords, tableKeys(scope, id)) ? undefined : [...chords];
    if (keys !== undefined) commands[entry.id] = keys;
  }
  const keys: KeyOverrides = {};
  for (const name of ALL_SCOPES) {
    const kept = name === scope ? commands : settings.keys[name];
    if (kept !== undefined && Object.keys(kept).length > 0) keys[name] = kept;
  }
  return { ...settings, keys };
}

/** `settings` with `chord` as the stop key that gets through everything, left out when it is Shift+Esc. */
export function withStop(settings: KeySettings, chord: KeyChord): KeySettings {
  return { ...settings, stop: chord === STOP_ANYWHERE ? null : chord };
}

// —— Saving ——————————————————————————————————————————————————————————————————————————————

const chordSchema = z.string().refine(chord => parseChord(chord) !== null, { message: '有一个键的写法认不出' });
const commandsSchema = z.record(z.string(), z.array(chordSchema));
const storedSchema = z.object({
  version: z.literal(1),
  keys: z.object({ editor: commandsSchema.optional(), lighting: commandsSchema.optional(), timeline: commandsSchema.optional() }),
  stop: chordSchema.optional()
});
const SAVED_SCOPES = ['editor', 'lighting', 'timeline'] as const;

/** The reason of a failure as a sentence (a Zod failure as its list of problems). */
export function failureText(error: unknown): string {
  if (error instanceof z.ZodError) return z.prettifyError(error);
  return error instanceof Error ? error.message : String(error);
}

/** The saved settings; throws when they cannot be read, or name a command whose keys cannot be changed. */
export function parseKeySettings(text: string): KeySettings {
  const stored = storedSchema.parse(JSON.parse(text));
  let settings: KeySettings = { keys: {}, stop: stored.stop ?? null };
  for (const scope of SAVED_SCOPES) {
    for (const [id, chords] of Object.entries(stored.keys[scope] ?? {})) {
      const entry = KEYMAP.find(item => item.scope === scope && item.id === id && item.rebindable);
      if (!entry) throw new Error(`存着的「${id}」不是能改的键`);
      settings = withKeys(settings, scope, entry.id, chords);
    }
  }
  return settings;
}

export function serializeKeySettings(settings: KeySettings): string {
  return JSON.stringify({ version: 1, keys: settings.keys, ...(settings.stop === null ? {} : { stop: settings.stop }) });
}

const v1Actions = ['stamp', 'play', 'previous', 'next', 'start', 'end'] as const;
const v1Schema = z.array(z.object({ id: z.string(), action: z.enum(v1Actions), key: z.string().min(1) }));
export type V1Binding = z.infer<typeof v1Schema>[number];
/** What 0.5.8 saved when nothing was changed. */
export const V1_DEFAULTS: readonly V1Binding[] = (['KeyM', 'Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const)
  .map((key, index) => ({ id: key, action: v1Actions[index] ?? 'stamp', key }));
/** The command of the key table each of 0.5.8's six actions is (scope `lighting`). */
const V1_COMMANDS = { stamp: 'lighting.stamp', play: 'transport.playPause', previous: 'transport.prevFrame', next: 'transport.nextFrame', start: 'transport.start', end: 'transport.end' } as const satisfies Record<V1Binding['action'], CommandId>;

/** 0.5.8's saved lighting keys, as 0.5.8 checked them (no key twice). */
export function readV1(value: unknown): V1Binding[] {
  const bindings = v1Schema.parse(value);
  if (new Set(bindings.map(binding => binding.key)).size !== bindings.length) throw new Error('有两个操作用了同一个键');
  return bindings;
}

/**
 * 0.5.8's lighting keys as settings: every action whose keys are not the table's, with the keys saved for it (none
 * when all were deleted). A key that now is another command's too is kept; the settings page marks it (`keyMarks`).
 */
export function migrateV1(text: string): KeySettings {
  const bindings = readV1(JSON.parse(text));
  let settings = NO_CHANGES;
  for (const action of v1Actions) settings = withKeys(settings, 'lighting', V1_COMMANDS[action], bindings.filter(binding => binding.action === action).map(binding => binding.key));
  return settings;
}

// —— What a key may be ——————————————————————————————————————————————————————————————————————

const PAGES: readonly KeyPage[] = ['project', 'cues', 'lighting'];

/** The pages a command works on. */
export function entryPages(entry: KeyEntry): KeyPage[] {
  const pages = entry.scope === 'global' ? PAGES : PAGES.filter(page => PAGE_SCOPES[page].includes(entry.scope));
  return entry.pages === undefined ? [...pages] : pages.filter(page => entry.pages?.includes(page));
}

/** The command's name without what the brackets add. */
export function shortLabel(entry: KeyEntry): string {
  return entry.label.replace(/（[^）]*）$/, '');
}

const isModifier = (code: string): boolean => /^(Control|Shift|Alt|Meta|OS)/.test(code);

/** Why `chord` cannot be a command's key, whoever has it; null when it can. */
export function chordProblem(chord: KeyChord): string | null {
  const parsed = parseChord(chord);
  if (!parsed || isModifier(parsed.code)) return '只按了 Ctrl、Alt 或 Shift，请再加一个键。';
  if (isSystemChord(chord)) return `${chordLabel(chord)} 是 Windows 或输入法自己用的键，联动台收不到，请换一个。`;
  if (parsed.code === 'Escape') return 'Esc 留给停止、关闭面板和取消拖动，不能给别的操作，请换一个。';
  if (['Tab', 'Enter', 'NumpadEnter'].includes(parsed.code)) return `${chordLabel(chord)} 用来在界面上切换和确认，不能当快捷键，请换一个。`;
  return null;
}

/** Whether `other` takes `chord` (a project key with Ctrl also with Alt held, as the router reads it, key-route.ts). */
const takes = (other: KeyEntry, chord: KeyChord): boolean =>
  other.keys.some(binding => binding.chord === chord || other.kind === 'document' && binding.chord === documentChord(chord));

/** The other command that has `chord` on a page `entry` works on; the same command in another scope is not another. */
function takenBy(keymap: readonly KeyEntry[], entry: KeyEntry, chord: KeyChord): KeyEntry | undefined {
  const pages = entryPages(entry);
  return keymap.find(other => other.id !== entry.id && other.id !== 'edit.splitMoved' && entryPages(other).some(page => pages.includes(page)) && takes(other, chord));
}

const takenText = (chord: KeyChord, other: KeyEntry): string =>
  `${chordLabel(chord)} 已经是「${shortLabel(other)}」的键。请换一个，或者先把「${shortLabel(other)}」改成别的键。`;

/**
 * Why `chords` (keys newly given to `id` in `scope`, `keymap` already with them) cannot be: one the key can never be
 * (`chordProblem`), or one another command has on the same page (no key silently stops working). Null when they can.
 */
export function keyProblem(keymap: readonly KeyEntry[], scope: KeyScope, id: CommandId, chords: readonly KeyChord[]): string | null {
  const entry = keymap.find(item => item.scope === scope && item.id === id);
  if (!entry) return null;
  if (!entry.rebindable) return `「${shortLabel(entry)}」的键不能改。`;
  const all = entry.keys.map(binding => binding.chord);
  const twice = all.find((chord, index) => all.indexOf(chord) !== index);
  if (twice !== undefined) return `「${shortLabel(entry)}」已经有 ${chordLabel(twice)} 了。`;
  return chords.map(chord => chordTrouble(keymap, entry, chord)).find(text => text !== null) ?? null;
}

/** Why `entry` cannot have `chord`: what the key can never be, or another command that has it. */
function chordTrouble(keymap: readonly KeyEntry[], entry: KeyEntry, chord: KeyChord): string | null {
  const other = takenBy(keymap, entry, chord);
  return chordProblem(chord) ?? (other ? takenText(chord, other) : null);
}

/** Keys that type, move the cursor or delete in a field: the stop key that works in fields too cannot be one of them. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['Space', 'Enter', 'NumpadEnter', 'Tab', 'Backspace', 'Delete', 'Insert',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Why `chord` cannot be the stop key that gets through everything (00-order 第 8 节第 1 题, K8): it works in fields,
 * dialogs and drags, so it must not be a key that types or edits there; Windows' own keys never reach the window; no
 * other command may have it on any page; and there must be one. Null when it can.
 */
export function stopKeyProblem(keymap: readonly KeyEntry[], chord: KeyChord): string | null {
  const parsed = parseChord(chord);
  if (!parsed || isModifier(parsed.code)) return '只按了 Ctrl、Alt 或 Shift，请再加一个键。';
  if (isSystemChord(chord)) return `${chordLabel(chord)} 是 Windows 或输入法自己用的键，联动台收不到，请换一个。`;
  const functionKey = /^F([1-9]|1[0-2])$/.test(parsed.code);
  if (TEXT_KEYS.has(parsed.code)) return `${chordLabel(chord)} 在输入框里用来打字、移动光标或删字，不能用来随时停止，请换一个。`;
  if (!parsed.ctrl && !parsed.alt && !parsed.shift && !functionKey) {
    return parsed.code === 'Escape' ? '单按 Esc 已经能停止（在上面的开关里设）。随时停止请另选一个：按住 Ctrl、Alt 或 Shift 再按一个键，或者用 F1–F12。'
      : `单按 ${chordLabel(chord)} 在输入框里会打成字。随时停止请按住 Ctrl、Alt 或 Shift 再按一个键，或者用 F1–F12。`;
  }
  if (parsed.shift && !parsed.ctrl && !parsed.alt && !functionKey && parsed.code !== 'Escape') {
    return `${chordLabel(chord)} 在输入框里会打出字。随时停止请用 Ctrl 或 Alt 加一个键、Shift+Esc，或者 F1–F12。`;
  }
  const stop = keymap.find(entry => entry.scope === 'global' && entry.id === 'transport.stop');
  const other = stop ? takenBy(keymap, stop, chord) : undefined;
  return other ? takenText(chord, other) : null;
}

/** The stop key that gets through everything now. */
export function stopAnywhere(keymap: readonly KeyEntry[]): KeyChord {
  return keymap.find(entry => entry.scope === 'global' && entry.id === 'transport.stop')?.keys.find(binding => binding.through === 'all')?.chord ?? STOP_ANYWHERE;
}

/**
 * What is wrong with the keys kept from before (moved from 0.5.8, or saved when the table had other keys): by
 * `${scope} ${id}`, and the stop key's. The settings page marks them; the keys stay until the user changes them.
 */
export function keyMarks(settings: KeySettings): { commands: ReadonlyMap<string, string>; stop: string | null } {
  const keymap = settingsKeymap(settings);
  const commands = new Map<string, string>();
  for (const scope of SAVED_SCOPES) {
    for (const id of Object.keys(settings.keys[scope] ?? {})) {
      const entry = keymap.find(item => item.scope === scope && item.id === id);
      if (!entry) continue;
      const problem = entry.keys.map(binding => chordTrouble(keymap, entry, binding.chord)).find(text => text !== null);
      if (problem) commands.set(`${scope} ${id}`, problem);
    }
  }
  return { commands, stop: settings.stop === null ? null : stopKeyProblem(keymap, settings.stop) };
}

/** Why a command's key cannot be changed, in a few words (the settings page); null when it can. */
export function fixedReason(entry: KeyEntry): string | null {
  if (entry.rebindable) return null;
  if (entry.id === 'transport.playPause') return '空格固定';
  if (entry.id === 'transport.stop' || entry.id === 'edit.deselect') return '跟着 Esc';
  if (entry.id === 'home.prevSong' || entry.id === 'home.nextSong') return '首页的键不改';
  if (entry.id === 'edit.splitMoved') return '给 S 设了操作就不再提示';
  return '通用键';
}

// —— A song's own shortcut ——————————————————————————————————————————————————————————————————

const PAGE_NAMES: Readonly<Record<KeyPage, string>> = { project: '首页', cues: '编辑器', lighting: '灯光工作台' };

/**
 * Why `chord` cannot be a song's shortcut: Windows' own keys, the stop keys, and the project's keys, which are acted on
 * before a song's (key-route.ts), so the song would never play. Null when it can.
 */
export function songKeyProblem(keymap: readonly KeyEntry[], chord: KeyChord): string | null {
  if (isSystemChord(chord)) return `${chordLabel(chord)} 是 Windows 或输入法自己用的键，联动台收不到，请换一个。`;
  const stop = keymap.find(entry => entry.scope === 'global' && entry.id === 'transport.stop');
  if (chord === 'Escape' || stop?.keys.some(binding => binding.chord === chord)) return `${chordLabel(chord)} 是停止键，不能给歌曲用，请换一个。`;
  const project = keymap.find(entry => entry.kind === 'document' && takes(entry, chord));
  return project ? `${chordLabel(chord)} 是「${shortLabel(project)}」的键，按了不会播这首歌，请换一个。` : null;
}

/**
 * A note when `chord` is also a key of the editor or the lighting workbench outside the timeline: on those pages their
 * key is acted on first and the song does not play there. A song never plays with the focus in the timeline anyway
 * (key-route.ts), so the timeline's own keys need no note. Null when there is nothing to say.
 */
export function songKeyNote(keymap: readonly KeyEntry[], chord: KeyChord): string | null {
  const found = (['cues', 'lighting'] as const).flatMap(page => {
    const entry = keymap.find(item => item.scope !== 'global' && item.area !== 'timeline' && entryPages(item).includes(page) && item.keys.some(binding => binding.chord === chord));
    return entry ? [{ page: PAGE_NAMES[page], name: shortLabel(entry) }] : [];
  });
  const first = found[0];
  if (!first) return null;
  const where = found.every(item => item.name === first.name) ? `在${found.map(item => item.page).join('和')}里，${chordLabel(chord)} 是「${first.name}」`
    : `${chordLabel(chord)} ${found.map(item => `在${item.page}里是「${item.name}」`).join('，')}`;
  return `${where}，在${found.length > 1 ? '那两页' : '那一页'}按它不会播这首歌。`;
}
