import { takeKey } from '../playback-keys';

/*
 * The Enter key on the lighting workbench's Cue points (WaveformCuePoints): a Cue point opens its edit dialog, 修改
 * Cue 卡点, and Enter there saves it. Held down, Enter repeats its keydown, and the repeats go to the dialog once it is
 * open.
 */

type EnterKey = Pick<KeyboardEvent, 'key' | 'repeat' | 'preventDefault'>;

/**
 * Enter going down on a focused Cue point opens its edit dialog (`open`), once per press: held down, Enter opened the
 * dialog again for every repeat (0.5.9). A Cue point that cannot be edited (the timeline is read only or its track is
 * locked) leaves Enter alone.
 */
export function cuePointEnter(event: EnterKey, editable: boolean, open: () => void): void {
  if (event.key !== 'Enter' || !editable) return;
  takeKey(event, open);
}

/**
 * Enter going down in the edit dialog: a fresh press saves it, as Enter does in a form; a repeat does not. The Enter
 * held down on the Cue point goes on repeating in the dialog, and every repeat saved the Cue unchanged: it was rewritten
 * and, with live sync on, written to the console each time (0.5.9).
 */
export function editDialogEnter(event: EnterKey): void {
  if (event.key === 'Enter' && event.repeat) event.preventDefault();
}
