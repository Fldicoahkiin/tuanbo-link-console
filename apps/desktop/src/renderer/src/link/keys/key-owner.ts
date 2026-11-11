import type { KeyChord } from './key-chord';

/*
 * Who a key belongs to before the page and the window get it: the focused field or control, an open dialog, or nobody.
 * DIALOGS, modalDialogOpen and OWN_KEYS came here from playback-keys.ts (keys7). The key router (key-router.ts) reads
 * them for every press; what is left of playback-keys.ts still calls them from there until K9.
 */

/**
 * An open dialog, which keeps every key pressed in it: Escape closes it, and no key there stops, plays or changes the
 * song. The app's modal dialogs are native <dialog> elements without a role (ModalSurface and Dialog, the lighting
 * attribute, Cue delete, attribute filter and category dialogs); the panels that open beside a button are
 * [role="dialog"] (Popover). Known by the role alone, a dialog of the first kind did not count: with the focus on it,
 * Escape stopped the show and the dialog stayed open (0.5.9).
 */
export const DIALOGS = 'dialog,[role="dialog"],[role="alertdialog"]';

/**
 * Whether a native modal dialog is open (`dialog:modal`). The page behind one cannot be reached, but the focus can
 * still fall out of it onto the page body, when its focused button goes away or is disabled, and the keys pressed
 * then went to the show. Only modal dialogs count: Space plays and pauses while a panel beside a button is open.
 */
export function modalDialogOpen(page: { querySelector(selectors: string): unknown }): boolean {
  return page.querySelector('dialog:modal') !== null;
}

/** Fields that type or pick: every key there is theirs. */
const FIELDS = 'input,textarea,select,[contenteditable="true"]';
/**
 * Controls that move, pick or resize with the keys, and controls held down for as long as Space or Enter is
 * (`data-momentary`), such as the Flash and Temp keys of an MA2 executor: Space there flashes the light, it does not
 * play or pause the show (taken away in 0.5.8).
 */
const CONTROLS = '[role="slider"],[role="spinbutton"],[role="combobox"],[role="listbox"],[role="menu"],[role="menuitem"],[role="separator"],[data-momentary="true"]';

/**
 * Keys a focused control uses itself: typing, picking from a list or menu, sliders and resizers, anything in a dialog,
 * and the held-down controls (`CONTROLS`).
 */
export const OWN_KEYS = `${FIELDS},${CONTROLS},${DIALOGS}`;

/** Where Escape closes or cancels something open: a details element, a menu or panel button that is open. */
const ESCAPE_CONTROLS = 'details[open],[aria-expanded="true"]';
/** The lighting workbench's Cue pool, which moves between its cells with the keys and is left its keys. */
const KEY_GRIDS = '.cue-pool-grid';
/**
 * The timeline's own buttons, edited with the timeline's keys: clips, Cues, audio waveforms, and the editor's audio
 * segments (a `role="button"`, which the timeline's keys have always edited: S splits the selected one, ← → step).
 */
const TIMELINE_ITEMS = '.timeline-clip,.timeline-cue,.timeline-media-waveform,.audio-timeline-segment';
/** Buttons and the player: they keep Enter and the keys the page leaves to buttons. */
const BUTTONS = 'button,[role="button"],audio';
/** The editor's and the lighting workbench's timeline. */
const TIMELINE = '.reference-timeline';

/** The element a key went to, as far as the key helpers look at it. */
export type KeyTarget = { closest(selectors: string): unknown };
/** Whether the key went to an element matching `selectors` or into one. */
export const isInside = (target: KeyTarget | null, selectors: string): boolean => target !== null && target.closest(selectors) !== null;

/** A key's element, which also says which keys it declared its own (`ownKeys`). */
export type OwnerTarget = { closest(selectors: string): { getAttribute(name: string): string | null } | null };

/**
 * Who a key belongs to:
 * - `capture`: an element that records keys (`data-own-keys="*"`), which takes every key, the stop key and Ctrl+S too;
 * - `own`: an element that declared this key its own (`ownKeys`);
 * - `dialog`: an open dialog (`DIALOGS`);
 * - `field`: a field that types or picks;
 * - `control`: a slider, list, menu, resizer, held-down control, the Cue pool; for Escape also an open details or an
 *   open menu or panel button;
 * - `item`: a clip, Cue or waveform on the timeline, a button the timeline edits with its keys;
 * - `button`: any other button, and the player;
 * - null: nothing on the page keeps it.
 */
export type KeyOwner = 'capture' | 'own' | 'dialog' | 'field' | 'control' | 'item' | 'button' | null;

/**
 * Who `chord`, pressed on `target`, belongs to (see `KeyOwner`). A key an element or any element around it declared
 * (`ownKeys`) is theirs: a row of a list declares Enter, the list around it the arrows, and both are kept on the row.
 */
export function keyOwner(target: OwnerTarget | null, chord: KeyChord): KeyOwner {
  if (target === null) return null;
  if (target.closest('[data-own-keys="*"]') !== null) return 'capture';
  if (target.closest(`[data-own-keys~="${chord}"]`) !== null) return 'own';
  if (isInside(target, DIALOGS)) return 'dialog';
  if (isInside(target, FIELDS)) return 'field';
  if (isInside(target, `${CONTROLS},${KEY_GRIDS}`) || chord === 'Escape' && isInside(target, ESCAPE_CONTROLS)) return 'control';
  if (isInside(target, TIMELINE_ITEMS)) return 'item';
  if (isInside(target, BUTTONS)) return 'button';
  return null;
}

/**
 * Where the window's playback keys are left alone, as they have been since 0.5.9 (useInternalPlayer): Space, with or
 * without Shift, wherever a control uses it (`OWN_KEYS`), so it still plays and pauses on a button; the other keys
 * (Escape, ↑↓, a song's own shortcut) in a field, on a button or a slider. A key a control around the focus takes for
 * itself is declared with `ownKeys` instead.
 */
const WINDOW_KEEPERS = 'input,textarea,select,button,[contenteditable="true"],[role="slider"]';

/** Whether the window's playback keys leave `chord` pressed on `target` alone (`WINDOW_KEEPERS`). */
export function windowKeepsKey(target: KeyTarget | null, chord: KeyChord): boolean {
  return isInside(target, chord === 'Space' || chord === 'Shift+Space' ? OWN_KEYS : WINDOW_KEEPERS);
}

/** Inputs that do not type: Ctrl+Z there undoes the project, as on the page (useDocumentShortcuts). */
const NON_TEXT_INPUTS = ['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit'].map(type => `input[type="${type}"]`).join(',');

/** Whether the focus types text, where Ctrl+Z and Ctrl+Y undo and redo the typing, not the project. */
export function editsText(target: KeyTarget | null): boolean {
  return isInside(target, 'textarea,[contenteditable="true"]') || isInside(target, 'input') && !isInside(target, NON_TEXT_INPUTS);
}

/** Whether a key went into the editor's or the lighting workbench's timeline. */
export function keyInTimeline(target: KeyTarget | null): boolean {
  return isInside(target, TIMELINE);
}

/** The attribute that declares `chords` an element's own keys, or every key with `'*'` (a field that records keys). */
export function ownKeys(...chords: readonly KeyChord[]): { 'data-own-keys': string } {
  return { 'data-own-keys': chords.join(' ') };
}

/**
 * The keys the home page's lists use themselves, declared with `ownKeys` since the router takes the keys first
 * (04 设计 K3). A song card moves the focus with the arrows, Home and End and takes them (useProgramViewport), and
 * plays its song with Enter (ProjectLibrary);
 * the program grid selects all with Ctrl+A and deletes the selected songs with Delete; a playlist renames with F2 and
 * opens its menu with the menu key or Shift+F10. The grid's Escape is not among them: it clears the selection and
 * stops the show, both through the home page's stop (ProgramGrid), as it did before the router. Moving cards and playlists are drags (DragSession), whose
 * Escape the drag layer of `routeKey` takes.
 */
export const HOME_OWN_KEYS = {
  programCard: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'],
  programGrid: ['Ctrl+KeyA', 'Delete'],
  playlist: ['F2', 'ContextMenu', 'Shift+F10']
} as const satisfies Record<string, readonly KeyChord[]>;
