import { takeKey } from '../playback-keys';

/** Space and Enter, the keys that press a focused button. */
const pressesButton = (event: Pick<KeyboardEvent, 'key'>): boolean => event.key === ' ' || event.key === 'Enter';

/**
 * Space or Enter going down on a focused MA2 executor key. A held-down key (Flash, Temp: `momentary`) is down for as
 * long as the key is: its first keydown presses it, and its repeats press nothing (`takeKey`).
 *
 * Any other key (Go and the like) is pressed by the button's own click, once per press of the key, and is left as it
 * is: Enter clicks the button, and Space is the page's play key or, without one, clicks it when let go. A held Enter's
 * repeats never reach it: the key router takes them first (keys/key-route.ts, `held`, K7), so the console no longer
 * goes on by as many Cues as the key repeated (0.5.9).
 */
export function executorKeyDown(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'preventDefault'>, momentary: boolean, press: () => void): void {
  if (momentary && pressesButton(event)) takeKey(event, press);
}

/** Space or Enter let go on a focused MA2 executor key: a held-down key lets go on the console with it. */
export function executorKeyUp(event: Pick<KeyboardEvent, 'key' | 'preventDefault'>, momentary: boolean, release: () => void): void {
  if (!momentary || !pressesButton(event)) return;
  event.preventDefault(); release();
}
