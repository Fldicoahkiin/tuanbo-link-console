import { parseChord, type KeyChord } from './key-chord';
import type { KeyOwner } from './key-owner';
import { KEYMAP, PAGE_SCOPES, type CommandId, type KeyBinding, type KeyEntry, type KeyPage, type KeyScope, type KeySwitch } from './keymap';

/*
 * Who acts on one key press, worked out in one place: 输入框 → 弹窗 → 拖动 → 页面 → 全局 (04 设计 4.3). A pure
 * function, so the rules are tested here alone. The key router (key-router.ts) asks it for every press and acts on the
 * window's keys (K3); the timeline's keys still act on their own listeners (K6), and what `routeKey` says of them is
 * what those listeners do.
 */

/** An open panel the page closes with Escape (a Popover, a detail view, the settings or connection page). */
export type KeyOverlay = {
  /** The focus is in it: every key but Escape is its own. */
  focusInside: boolean;
  /** The settings and connection pages: no key of the page or the window reaches the show while one is open. */
  blocks: boolean;
};

/** A drag going on (DragSession): `cancelled` once Escape gave it up and the pointer is still held. */
export type KeyDrag = 'none' | 'active' | 'cancelled';

export type RouteInput = {
  chord: KeyChord;
  /** A held key's repeat. */
  repeat: boolean;
  /** The input method is composing (`isComposing`, or the key is 'Process'). */
  composing: boolean;
  /** `keyOwner(target, chord)`. */
  owner: KeyOwner;
  /** `keyInTimeline(target)`. */
  inTimeline: boolean;
  /**
   * `windowKeepsKey(target, chord)`: the window's playback keys (stop, play, ↑↓, a song's own shortcut) leave the key
   * to the focused field, button or slider. Left out: wherever anything on the page keeps the key (`owner`).
   */
  windowKeeps?: boolean;
  /** `editsText(target)`: the focus types text, where undo and redo are the typing's. Left out: in a field. */
  editingText?: boolean;
  /**
   * A listener of the page that is not on the router yet takes the key: the lighting workbench's shortcut keys
   * (useTimelineStamp) until K6. The window's keys give way to it, as they always did.
   */
  pageTakes?: boolean;
  /** `modalDialogOpen(document)`. */
  modalOpen: boolean;
  /** Bottom to top. */
  overlays: readonly KeyOverlay[];
  drag: KeyDrag;
  page: KeyPage;
  /** The keys with the user's changes; KEYMAP when left out. */
  keymap?: readonly KeyEntry[];
  /** The switches turned off on this computer (`KeySwitch`); none when left out. */
  switchesOff?: ReadonlySet<KeySwitch>;
  /** Whether a handler for `id` is there in `scope` now (the editor has a song open, the player plays, ↑↓ change songs). */
  available: (id: CommandId, scope: KeyScope) => boolean;
  /** The song whose own shortcut `chord` is. */
  song: (chord: KeyChord) => string | undefined;
};

/**
 * - `ignore`: nobody takes it; the browser does what it does.
 * - `native`: left to the field, control, dialog or panel that has it.
 * - `overlay`: closes the top panel.
 * - `drag-cancel`: cancels the drag; `swallow`: taken, nothing done (a held key's repeat, Escape after a cancel).
 * - `run`: the command in that scope; `song`: plays that song.
 */
export type RouteDecision =
  | { kind: 'ignore' } | { kind: 'native' } | { kind: 'overlay' } | { kind: 'drag-cancel' } | { kind: 'swallow' }
  | { kind: 'run'; id: CommandId; scope: KeyScope }
  | { kind: 'song'; itemId: string };

type Candidate = { entry: KeyEntry; binding: KeyBinding };

const IGNORE: RouteDecision = { kind: 'ignore' }, NATIVE: RouteDecision = { kind: 'native' }, SWALLOW: RouteDecision = { kind: 'swallow' };

const throughFields = (binding: KeyBinding): boolean => binding.through !== undefined;
const throughDialogs = (binding: KeyBinding): boolean => binding.through === 'dialogs' || binding.through === 'all';

/** Runs `entry`, once per press when it says so. */
function act(input: RouteInput, entry: KeyEntry): RouteDecision {
  return entry.repeat === 'once' && input.repeat ? SWALLOW : { kind: 'run', id: entry.id, scope: entry.scope };
}

/**
 * Whether `entry` can take the key where the focus is: its area, the focused control or button, a handler there. A key
 * that gets through everything (`through: 'all'`) is not kept by a control or a button either.
 */
function reaches(input: RouteInput, { entry, binding }: Candidate): boolean {
  if (entry.area === 'timeline' && !input.inTimeline || entry.area === 'outside-timeline' && input.inTimeline) return false;
  if (binding.through === 'all') return input.available(entry.id, entry.scope);
  if (input.owner === 'control' && entry.kind !== 'document') return false;
  if (input.owner === 'button' && entry.buttons !== 'take' || input.owner === 'item' && entry.buttons === 'leave') return false;
  return input.available(entry.id, entry.scope);
}

/** The first of `candidates` that reaches the key (`reaches`), acted on. */
function first(input: RouteInput, candidates: readonly Candidate[]): RouteDecision | null {
  const found = candidates.find(candidate => reaches(input, candidate));
  return found ? act(input, found.entry) : null;
}

/**
 * The chord the project's keys are known by (useDocumentShortcuts, 0.5.9): with Ctrl held, Alt and the Windows key do
 * not count, nor does Shift with Y, so Ctrl+Alt+S saves and Ctrl+Shift+Y redoes, as they always did.
 */
function documentChord(chord: KeyChord): KeyChord {
  const parsed = parseChord(chord);
  if (!parsed?.ctrl) return chord;
  return ['Ctrl', ...(parsed.shift && parsed.code !== 'KeyY' ? ['Shift'] : []), parsed.code].join('+');
}

/** The chord the window's playback keys are known by (0.5.9): without Ctrl or Alt, Shift does not count, so Shift+Space plays. */
function windowChord(chord: KeyChord): KeyChord {
  const parsed = parseChord(chord);
  if (!parsed?.shift || parsed.ctrl || parsed.alt) return chord;
  return [...(parsed.meta ? ['Meta'] : []), parsed.code].join('+');
}

/** What the press does (see the file comment). */
export function routeKey(input: RouteInput): RouteDecision {
  if (input.composing) return IGNORE;
  if (input.owner === 'capture') return NATIVE;
  const switchedOff = input.switchesOff ?? new Set<KeySwitch>();
  const matching = (chord: KeyChord): Candidate[] => (input.keymap ?? KEYMAP).flatMap(entry => entry.keys
    .filter(binding => binding.chord === chord && (binding.switch === undefined || !switchedOff.has(binding.switch)))
    .map(binding => ({ entry, binding })));
  const candidates = matching(input.chord);
  const throughAll = first(input, candidates.filter(candidate => candidate.binding.through === 'all'));
  if (throughAll) return throughAll;
  const inDialog = input.owner === 'dialog' || input.modalOpen;
  // 工程: saving works everywhere, in fields and dialogs too; undo and redo but where text is typed or in a dialog.
  const editingText = input.editingText ?? input.owner === 'field';
  const project = matching(documentChord(input.chord)).find(({ entry, binding }) => entry.kind === 'document' && input.available(entry.id, entry.scope)
    && (!editingText || throughFields(binding)) && (!inDialog || throughDialogs(binding)));
  if (project) return act(input, project.entry);
  const others = candidates.filter(candidate => candidate.entry.kind !== 'document');
  // 输入框: the field's own keys, but for the commands that work in fields.
  if (input.owner === 'field' || input.owner === 'own') return first(input, others.filter(candidate => throughFields(candidate.binding))) ?? NATIVE;
  // 弹窗: every key pressed in an open dialog, or while a modal one is open, is the dialog's (keys7).
  if (inDialog) return first(input, others.filter(candidate => throughDialogs(candidate.binding))) ?? NATIVE;
  const top = input.overlays.at(-1);
  if (top && input.chord === 'Escape') return { kind: 'overlay' };
  if (top?.focusInside) return NATIVE;
  // The settings or connection page: no key of the page or the window reaches the show.
  if (input.overlays.some(overlay => overlay.blocks)) return NATIVE;
  // 拖动: Escape only cancels the drag, and is taken until the pointer is let go (keys7).
  if (input.drag !== 'none' && input.chord === 'Escape') return input.drag === 'active' ? { kind: 'drag-cancel' } : SWALLOW;
  if (input.pageTakes === true) return NATIVE;
  // 页面: the page's scopes in order.
  for (const scope of PAGE_SCOPES[input.page]) {
    const decision = first(input, others.filter(candidate => candidate.entry.scope === scope));
    if (decision) return decision;
  }
  // 全局: a song's own shortcut, then the window's keys, outside the timeline and what keeps them (`windowKeeps`).
  const windowKeeps = input.windowKeeps ?? input.owner !== null;
  const itemId = input.song(input.chord);
  if (itemId !== undefined && !input.inTimeline && !windowKeeps) return input.repeat ? SWALLOW : { kind: 'song', itemId };
  const window = matching(windowChord(input.chord)).find(({ entry }) => entry.scope === 'global' && entry.kind !== 'document'
    && !(entry.area === 'outside-timeline' && input.inTimeline) && !windowKeeps && input.available(entry.id, entry.scope));
  if (window) return act(input, window.entry);
  return input.owner === null ? IGNORE : NATIVE;
}
