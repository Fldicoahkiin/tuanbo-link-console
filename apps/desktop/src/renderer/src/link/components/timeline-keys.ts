import type { ShortcutBinding } from '../stores/shortcut-store';
import { DIALOGS, isInside, spaceBelongsToControl, takeKey, type KeyTarget } from '../playback-keys';

/*
 * The keys of the editor's and the lighting workbench's timeline (ReferenceTimeline, useTimelineStamp, TimelineToolbar):
 * what each key does, and where the keys go after a click. A held key acts once per press (`takeKey`).
 */

/**
 * Where Escape belongs to an open dialog, menu or panel, or to a field, which close or cancel with it. The dialogs in
 * the timeline (修改 Cue 卡点, 编辑歌曲段落, 编辑音频片段) are native <dialog> elements without a role: with the focus
 * on one or on its buttons, Escape stopped the show and the dialog stayed open (0.5.9).
 */
const OWN_ESCAPE = `details[open],${DIALOGS},[aria-expanded="true"],input,textarea,select`;

/**
 * The timeline's transport keys, before its editing keys. Escape stops the show and goes no further; in an open
 * menu, panel or field it is left to them. In the editor Space plays or pauses with a toolbar, track or clip button
 * focused too, the same as the play button, and is left to fields, lists and panels; the lighting workbench takes
 * Space with its shortcut keys first (`handleLightingShortcut`). Returns whether it took the key.
 */
export function handleTimelineTransportKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'repeat' | 'preventDefault' | 'stopPropagation'>, target: KeyTarget | null,
  page: { lightingWorkspace: boolean; stop: (() => void) | undefined; playPause: () => void }): boolean {
  if (event.key === 'Escape') {
    if (!page.stop || target === null || isInside(target, OWN_ESCAPE)) return false;
    event.stopPropagation();
    takeKey(event, page.stop);
    return true;
  }
  if (event.code !== 'Space' || page.lightingWorkspace || spaceBelongsToControl(target)) return false;
  takeKey(event, page.playPause);
  return true;
}

type ShortcutAction = ShortcutBinding['action'];

/**
 * The lighting workbench's shortcut keys (打点, play, frame steps, start and end), which a window listener in the
 * capture phase takes before anything else. `shortcut.action` is what the key is bound to; `covered` says a dialog or
 * the settings page is over the workbench. The play key works with a button focused too, as the play button does,
 * and the other keys leave buttons alone; fields, held-down controls and the Cue pool keep their keys.
 */
export function handleLightingShortcut(event: Pick<KeyboardEvent, 'repeat' | 'defaultPrevented' | 'preventDefault' | 'stopImmediatePropagation'>, target: KeyTarget | null,
  shortcut: { action: ShortcutAction | undefined; covered: () => boolean }, run: (action: ShortcutAction) => void): void {
  const { action } = shortcut;
  if (!action || event.defaultPrevented || shortcut.covered() || isInside(target, '.cue-pool-grid')) return;
  if (action === 'play' ? spaceBelongsToControl(target) : isInside(target, 'input,textarea,select,button,[role="button"],[role="menu"],[contenteditable="true"],[role="separator"]')) return;
  event.stopImmediatePropagation();
  takeKey(event, () => run(action));
}

/**
 * Whether a click on the timeline toolbar gives the keys back to the timeline, so M, ← and → keep working after a
 * button was clicked with the mouse (0.5.9). A button pressed from the keyboard keeps the focus. So does a button that
 * opens a menu or a panel: the menu takes the focus, and the panel closes on Escape and gives the focus back to its
 * button. `aria-expanded` is read before the page redraws, so "true" means this click closes the panel. Clicks in a
 * menu or panel the toolbar opened come through the toolbar on the page but are not in it.
 */
export function keysBackToTimeline<B extends { getAttribute(name: string): string | null }>(click: { detail: number; target: { closest(selectors: 'button'): B | null } | null },
  toolbar: { contains(button: B): boolean }): boolean {
  const button = click.target?.closest('button') ?? null;
  if (click.detail === 0 || button === null || !toolbar.contains(button)) return false;
  return button.getAttribute('aria-haspopup') === null || button.getAttribute('aria-expanded') === 'true';
}
