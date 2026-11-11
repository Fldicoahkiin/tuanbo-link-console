import { DIALOGS, isInside, OWN_KEYS, type KeyTarget } from './keys/key-owner';

// DIALOGS, modalDialogOpen, OWN_KEYS and the target helpers live in keys/key-owner.ts (04 设计 K2). The window's playback
// keys (Space, Escape, ↑↓, a song's own shortcut) are the key router's (keys/key-router.ts, K3); what is left here serves
// the listeners not on it yet: the timeline's, the panels' and the drags' (K4–K6).
export { DIALOGS, isInside, modalDialogOpen, type KeyTarget } from './keys/key-owner';

/**
 * Space plays and pauses wherever it does not type or pick. A button keeps the focus after a click, so
 * Space used to press that button again: after clicking 「下一首」 or 「跳到结尾」, Space jumped to the next song (2026-11-09).
 */
export function spaceBelongsToControl(target: KeyTarget | null): boolean {
  return isInside(target, OWN_KEYS);
}

/**
 * Whether a key belongs to an open dialog and not to the page behind it: it was pressed in one (`DIALOGS`), or a modal
 * one is open (`modalDialogOpen`) and the focus fell out of it onto the page. The one rule every key handler of the
 * page asks, so no key there stops or plays the show, edits the timeline or the project (0.5.9). The timeline's
 * editing keys knew dialogs only by their tag: with the focus on 「修改 Cue 卡点」 itself, Delete removed the selected
 * Cue points behind it, and with it on a dialog's button, Delete removed the selected lighting points.
 */
export function keyInDialog(target: KeyTarget | null, modalOpen: boolean): boolean {
  return modalOpen || isInside(target, DIALOGS);
}

/** The focused element a key event came from, if any. */
export function keyTarget(event: Pick<KeyboardEvent, 'target'>): Element | null {
  return event.target instanceof Element ? event.target : null;
}

/**
 * Takes a key the page acts on, its repeats included, and acts once per press. Held down, a key repeats its keydown,
 * and a repeat left alone reaches the focused button: Space makes the button take it and letting go clicks it. So
 * holding Space after clicking 「下一首」 paused the show and then jumped to the next song, and holding it in the editor
 * played and paused the song again for every repeat (0.5.9).
 */
export function takeKey(event: Pick<KeyboardEvent, 'repeat' | 'preventDefault'>, act: () => void): void {
  event.preventDefault();
  if (!event.repeat) act();
}
