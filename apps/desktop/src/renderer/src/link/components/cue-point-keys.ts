import { takeKey } from '../playback-keys';

/*
 * The Enter key on the lighting workbench's Cue points (WaveformCuePoints): a Cue point opens its edit dialog, 修改
 * Cue 卡点, and Enter there saves it. Held down, Enter repeats its keydown; the key router takes the repeats before the
 * Cue point or the dialog sees them (keys/key-route.ts, `held`, K7), so a held Enter no longer saves the Cue again.
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
