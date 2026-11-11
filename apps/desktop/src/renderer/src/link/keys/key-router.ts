import { chordOf, type KeyChord } from './key-chord';
import { editsText, keyInTimeline, keyOwner, modalDialogOpen, windowKeepsKey, type OwnerTarget } from './key-owner';
import { routeKey, type KeyDrag, type RouteDecision } from './key-route';
import { KEYMAP, PAGE_SCOPES, type CommandId, type KeyPage, type KeyScope } from './keymap';

/*
 * The window's one key listener (04 设计 4.1, 4.2): a keydown listener on the window in the capture phase, before any
 * element or other listener sees the key. For every press it asks `routeKey` who acts, then does it. Components and
 * hooks hand it their handlers (`useKeyCommands`); it never changes the project or the show itself.
 *
 * K3 puts the window's keys on it: Space, Escape, ↑↓, a song's own shortcut, saving, undo and redo. K4 the panels
 * Escape closes (Popover, menus, the player's status details, the Cue menu, the connection and settings page): they
 * say they are open and how they close (`overlay`), and the router closes the top one. K5 the drags: a drag says it is
 * going on (`beginDrag`, DragSession and useCapturedDrag), the router cancels it on Escape and keeps that key, and the
 * keys that would change the project, from everything after it until the pointer is let go. The rest still has its
 * own listeners until the later steps, and the router leaves every key to them that they took before it:
 * - the lighting workbench's shortcut keys say which keys they take (`claim`) and act themselves (K6);
 * - the timeline's own keys act in the timeline, where the window's keys never did (K6).
 */

/** A key press, as the router reads it. */
export type KeyEvent = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'repeat' | 'isComposing'
  | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'> & { readonly target: unknown };

/** What a handler is told of the press: where the focus was, and the window's own handler of the same command. */
export type KeyPress = { target: OwnerTarget | null; global: () => void };
export type KeyHandler = (press: KeyPress) => void;
export type KeyHandlers = Partial<Record<CommandId, KeyHandler>>;
/** Whether a registration's handlers take this press. */
export type KeyWhen = (press: Pick<KeyPress, 'target'>) => boolean;
/** The songs' own shortcuts (`playback.shortcut`): the song a chord is the shortcut of, and playing it. */
export type SongShortcuts = { find(chord: KeyChord): string | undefined; play(itemId: string): void };
/** A listener not on the router yet that takes `event` itself; the window's keys leave such a key alone. */
export type KeyClaim = (event: KeyEvent, target: OwnerTarget | null) => boolean;
/**
 * A panel Escape closes, while `open` says so: `close` closes it, `contains` says the focus is in it (every key there
 * but Escape is its own), `blocks`: the page's and the window's keys wait while it is open (settings, connections).
 */
export type KeyOverlayEntry = { open: () => boolean; close: () => void; contains: (target: OwnerTarget) => boolean; blocks: boolean };
/**
 * A drag going on while the pointer is held: `escape` gives it up, `cancelled` once it did. `escape` is null for a
 * drag Escape cannot give up (the stage and OBS's live canvas, written as they go): Escape is only taken then.
 */
export type KeyDragEntry = { escape: (() => void) | null; cancelled: () => boolean };

type Registration = { scope: KeyScope; handlers: () => KeyHandlers; when: KeyWhen };
type View = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type Page = { querySelector(selectors: string): unknown };

/**
 * The page's handlers that act for the window's command on that page, before the window's own (04 设计 4.5): the home
 * player's play button and the program list's Escape on the home page, the timeline's play button in the editor and
 * the lighting workbench, which is what Space pressed there has done since 0.5.9.
 */
const HANDLER_SCOPES: Readonly<Record<KeyPage, readonly KeyScope[]>> = { project: ['home'], cues: PAGE_SCOPES.cues, lighting: PAGE_SCOPES.lighting };

const isOwnerTarget = (value: unknown): value is OwnerTarget => typeof value === 'object' && value !== null && 'closest' in value && typeof value.closest === 'function';

/** Whether `id` is one of the project's commands, which act beside the page's keys (see `act`). */
const isDocumentCommand = (id: CommandId): boolean => KEYMAP.some(entry => entry.id === id && entry.kind === 'document');

/** Removes `value` from `list` once; what the registering calls return. */
function remover<T>(list: T[], value: T): () => void {
  list.push(value);
  return () => { const index = list.indexOf(value); if (index >= 0) list.splice(index, 1); };
}

export class KeyRouter {
  private page: KeyPage = 'project';
  private readonly registrations: Registration[] = [];
  private readonly songs: SongShortcuts[] = [];
  private readonly claims: KeyClaim[] = [];
  private readonly overlays: KeyOverlayEntry[] = [];
  private readonly drags: KeyDragEntry[] = [];

  /** `document`: the page modal dialogs are looked for in, read on every press (none in tests without a page). */
  constructor(private readonly document: () => Page | null) {}

  /** Listens on `view` (the window) in the capture phase; the result stops. */
  install(view: View): () => void {
    const listener = (event: KeyboardEvent): void => this.dispatch(event);
    view.addEventListener('keydown', listener, true);
    return () => view.removeEventListener('keydown', listener, true);
  }

  /** The page on screen (LinkApp). */
  setPage(page: KeyPage): void {
    this.page = page;
  }

  /** Hands over `handlers` in `scope` while `when` says so; later registrations are asked first. The result takes them back. */
  register(scope: KeyScope, handlers: () => KeyHandlers, when: KeyWhen = () => true): () => void {
    return remover(this.registrations, { scope, handlers, when });
  }

  songShortcuts(songs: SongShortcuts): () => void {
    return remover(this.songs, songs);
  }

  claim(claim: KeyClaim): () => void {
    return remover(this.claims, claim);
  }

  overlay(entry: KeyOverlayEntry): () => void {
    return remover(this.overlays, entry);
  }

  beginDrag(entry: KeyDragEntry): () => void {
    return remover(this.drags, entry);
  }

  /** What one press does (see the file comment). */
  dispatch(event: KeyEvent): void {
    const target = isOwnerTarget(event.target) ? event.target : null;
    const chord = chordOf(event);
    const decision = routeKey({
      chord, repeat: event.repeat, composing: event.isComposing || event.key === 'Process',
      owner: keyOwner(target, chord), inTimeline: keyInTimeline(target), windowKeeps: windowKeepsKey(target, chord), editingText: editsText(target),
      pageTakes: this.claims.some(claim => claim(event, target)),
      modalOpen: this.modalOpen(), overlays: this.openOverlays().map(overlay => ({ focusInside: target !== null && overlay.contains(target), blocks: overlay.blocks })),
      drag: this.drag(), page: this.page,
      available: (id, scope) => this.handler(id, [scope], target) !== undefined,
      song: key => this.songs.at(-1)?.find(key)
    });
    // A key a listener before the router already took (a panel closing on Escape) is left alone by the window's
    // playback keys, as it was (0.5.9); saving, undo and redo never looked (useDocumentShortcuts).
    if (event.defaultPrevented && !(decision.kind === 'run' && isDocumentCommand(decision.id))) return;
    this.act(decision, event, target);
  }

  /*
   * A key the router acts on is taken from the browser (`preventDefault`) and goes on to the page as it did: the
   * window's keys, saving, undo and redo all acted last and never kept a key from a listener after them (0.5.9). The
   * listeners still off the router see it as before, with `defaultPrevented` set: the timeline still splits a clip on
   * Ctrl+S, and the counters on the window still hear Escape. Stopping the key there waits until every
   * listener is on the router (K4–K6).
   */

  private act(decision: RouteDecision, event: KeyEvent, target: OwnerTarget | null): void {
    switch (decision.kind) {
      // Left to the field, control, dialog or browser.
      case 'ignore': case 'native': return;
      // Escape during a drag: it gives the drag up, and goes no further, so that the timeline's Escape does not stop
      // the show (keys7, 0.5.9). The router stops this key itself, as the drag's own listener did before K5.
      case 'drag-cancel':
        event.preventDefault(); event.stopPropagation();
        for (const drag of this.cancellable()) drag.escape?.();
        return;
      // The top panel, the one opened last (K4).
      case 'overlay':
        event.preventDefault();
        this.openOverlays().at(-1)?.close();
        return;
      case 'swallow':
        // During a drag a swallowed key (Escape after a cancel, a key that would change the project) goes no further
        // either: the timeline's own keys do not look whether the router took it (K5).
        event.preventDefault();
        if (this.drag() !== 'none') event.stopPropagation();
        return;
      case 'song': {
        const songs = this.songs.at(-1);
        event.preventDefault();
        songs?.play(decision.itemId);
        return;
      }
      case 'run': {
        const scopes = decision.scope === 'global' ? [...HANDLER_SCOPES[this.page], 'global' as const] : [decision.scope];
        const handler = this.handler(decision.id, scopes, target);
        const own = this.handler(decision.id, ['global'], target);
        event.preventDefault();
        handler?.({ target, global: () => { if (own !== handler) own?.({ target, global: () => undefined }); } });
        return;
      }
    }
  }

  /** The handler for `id`, asked in the order of `scopes`, the latest registration first, that takes a press on `target`. */
  private handler(id: CommandId, scopes: readonly KeyScope[], target: OwnerTarget | null): KeyHandler | undefined {
    for (const scope of scopes) {
      for (let index = this.registrations.length - 1; index >= 0; index -= 1) {
        const registration = this.registrations[index]!;
        if (registration.scope !== scope) continue;
        const handler = registration.handlers()[id];
        if (handler && registration.when({ target })) return handler;
      }
    }
    return undefined;
  }

  /**
   * Whether a dialog or a panel is over the page: a modal dialog, or any panel Escape closes. The lighting workbench's
   * shortcut keys wait then (useTimelineStamp), as they did for every dialog and panel on screen.
   */
  covered(): boolean {
    return this.modalOpen() || this.openOverlays().length > 0;
  }

  /** The open panels, the one opened last at the end. */
  private openOverlays(): KeyOverlayEntry[] {
    return this.overlays.filter(overlay => overlay.open());
  }

  private modalOpen(): boolean {
    const page = this.document();
    return page !== null && modalDialogOpen(page);
  }

  private drag(): KeyDrag {
    if (this.drags.length === 0) return 'none';
    return this.cancellable().length > 0 ? 'active' : 'cancelled';
  }

  /** The drags Escape still gives up. */
  private cancellable(): KeyDragEntry[] {
    return this.drags.filter(drag => drag.escape !== null && !drag.cancelled());
  }
}

/** The app's router, installed on the window by LinkApp. */
export const keyRouter = new KeyRouter(() => typeof document === 'undefined' ? null : document);
