/** Keys a focused control uses itself: typing, picking from a list or menu, sliders and resizers, and anything in a dialog. */
const OWN_KEYS = 'input,textarea,select,[contenteditable="true"],[role="slider"],[role="spinbutton"],[role="combobox"],[role="listbox"],[role="menu"],[role="menuitem"],[role="separator"],[role="dialog"],[role="alertdialog"],dialog';

/**
 * Space plays and pauses wherever it does not type or pick. A button keeps the focus after a click, so
 * Space used to press that button again: after clicking 「下一首」 or 「跳到结尾」, Space jumped to the next song (2026-11-09).
 */
export function spaceBelongsToControl(target: { closest(selectors: string): unknown } | null): boolean {
  return target !== null && target.closest(OWN_KEYS) !== null;
}

/** The focused element a key event came from, if any. */
export function keyTarget(event: Pick<KeyboardEvent, 'target'>): Element | null {
  return event.target instanceof Element ? event.target : null;
}
