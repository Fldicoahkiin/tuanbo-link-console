import type { KeyChord } from './key-chord';
import type { KeyOwner } from './key-owner';
import { KEYMAP, PAGE_SCOPES, type CommandId, type KeyBinding, type KeyEntry, type KeyPage, type KeyScope, type KeySwitch } from './keymap';

/*
 * Who acts on one key press, worked out in one place: 输入框 → 弹窗 → 拖动 → 页面 → 全局 (04 设计 4.3). A pure
 * function, so the rules are tested here alone. Not wired yet: the window's and the timeline's listeners still act on
 * their own (04 设计 K3–K6); `routeKey` gives what they do today for the keys in KEYMAP.
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

/** What the press does (see the file comment). */
export function routeKey(input: RouteInput): RouteDecision {
  if (input.composing) return IGNORE;
  if (input.owner === 'capture') return NATIVE;
  const switchedOff = input.switchesOff ?? new Set<KeySwitch>();
  const candidates: Candidate[] = (input.keymap ?? KEYMAP).flatMap(entry => entry.keys
    .filter(binding => binding.chord === input.chord && (binding.switch === undefined || !switchedOff.has(binding.switch)))
    .map(binding => ({ entry, binding })));
  const throughAll = first(input, candidates.filter(candidate => candidate.binding.through === 'all'));
  if (throughAll) return throughAll;
  // 输入框: the field's own keys, but for the commands that work in fields (saving).
  if (input.owner === 'field' || input.owner === 'own') return first(input, candidates.filter(candidate => throughFields(candidate.binding))) ?? NATIVE;
  // 弹窗: every key pressed in an open dialog, or while a modal one is open, is the dialog's (keys7), saving aside.
  if (input.owner === 'dialog' || input.modalOpen) return first(input, candidates.filter(candidate => throughDialogs(candidate.binding))) ?? NATIVE;
  const top = input.overlays.at(-1);
  if (top && input.chord === 'Escape') return { kind: 'overlay' };
  if (top?.focusInside) return NATIVE;
  const blocked = input.overlays.some(overlay => overlay.blocks);
  // 拖动: Escape only cancels the drag, and is taken until the pointer is let go (keys7).
  if (input.drag !== 'none' && input.chord === 'Escape') return input.drag === 'active' ? { kind: 'drag-cancel' } : SWALLOW;
  const open = blocked ? candidates.filter(candidate => candidate.entry.kind === 'document') : candidates;
  // 页面: the page's scopes in order, then 全局: a song's own shortcut before the window's keys.
  for (const scope of PAGE_SCOPES[input.page]) {
    const decision = first(input, open.filter(candidate => candidate.entry.scope === scope));
    if (decision) return decision;
  }
  const itemId = blocked ? undefined : input.song(input.chord);
  if (itemId !== undefined && !input.inTimeline && input.owner === null) return input.repeat ? SWALLOW : { kind: 'song', itemId };
  const global = first(input, open.filter(candidate => candidate.entry.scope === 'global'));
  if (global) return global;
  return input.owner === null && !blocked ? IGNORE : NATIVE;
}
