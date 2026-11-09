/**
 * Keys a focused control uses itself: typing, picking from a list or menu, sliders and resizers, anything in a dialog,
 * and controls held down for as long as Space or Enter is (`data-momentary`), such as the Flash and Temp keys of an MA2
 * executor: Space there flashes the light, it does not play or pause the show (taken away in 0.5.8).
 */
const OWN_KEYS = 'input,textarea,select,[contenteditable="true"],[role="slider"],[role="spinbutton"],[role="combobox"],[role="listbox"],[role="menu"],[role="menuitem"],[role="separator"],[role="dialog"],[role="alertdialog"],dialog,[data-momentary="true"]';

/** The element a key went to, as far as the key helpers look at it. */
export type KeyTarget = { closest(selectors: string): unknown };
/** Whether the key went to an element matching `selectors` or into one. */
export const isInside = (target: KeyTarget | null, selectors: string): boolean => target !== null && target.closest(selectors) !== null;

/**
 * Space plays and pauses wherever it does not type or pick. A button keeps the focus after a click, so
 * Space used to press that button again: after clicking 「下一首」 or 「跳到结尾」, Space jumped to the next song (2026-11-09).
 */
export function spaceBelongsToControl(target: KeyTarget | null): boolean {
  return isInside(target, OWN_KEYS);
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

/** What a key pressed anywhere in the window does while 联动台播放 plays the show. */
export type PlaybackKeyAction = { kind: 'song'; itemId: string } | { kind: 'play-button' } | { kind: 'stop' } | { kind: 'skip'; direction: -1 | 1 };
type PlaybackKeyEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'defaultPrevented'>;
export type PlaybackKeyContext = { paused: boolean; arrowKeys: boolean; song: (key: string) => string | undefined };

/**
 * The window's playback keys: a song's own shortcut plays that song, Space presses the play button of the page on
 * screen (see `registerPlayButton`), Escape stops, ↑↓ go to the previous or next song when that is turned on. The
 * timeline takes its own keys. While the settings or connection page is open (`paused`) none of these work, so Escape
 * there only closes the page (0.5.9). A held key repeats the same action; `handlePlaybackKey` does it once per press.
 */
export function playbackKeyAction(event: PlaybackKeyEvent, target: KeyTarget | null, context: PlaybackKeyContext): PlaybackKeyAction | null {
  const plain = !event.ctrlKey && !event.altKey, space = plain && event.code === 'Space';
  if (context.paused || event.metaKey || event.defaultPrevented || isInside(target, '.reference-timeline')
    || (space ? spaceBelongsToControl(target) : isInside(target, 'input,textarea,select,button,[contenteditable="true"],[role="slider"]'))) return null;
  const itemId = context.song([...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), event.code].join('+'));
  if (itemId) return { kind: 'song', itemId };
  if (space) return { kind: 'play-button' };
  if (plain && event.code === 'Escape') return { kind: 'stop' };
  if (plain && context.arrowKeys && (event.code === 'ArrowUp' || event.code === 'ArrowDown')) return { kind: 'skip', direction: event.code === 'ArrowUp' ? -1 : 1 };
  return null;
}

/** The player the window's playback keys go to. */
export type PlaybackKeyPlayer = { play(itemId: string): void; stop(): void; skip(direction: -1 | 1): void };

/** The window's keydown listener: does what `playbackKeyAction` says, once per press, and takes the key (`takeKey`). */
export function handlePlaybackKey(event: PlaybackKeyEvent & Pick<KeyboardEvent, 'repeat' | 'preventDefault'>, target: KeyTarget | null,
  context: PlaybackKeyContext, player: PlaybackKeyPlayer): void {
  const action = playbackKeyAction(event, target, context);
  if (!action) return;
  takeKey(event, () => {
    switch (action.kind) {
      case 'song': player.play(action.itemId); return;
      // The page's play button, never "the song played last" (0.5.9).
      case 'play-button': pressPlayButton(); return;
      case 'stop': player.stop(); return;
      case 'skip': player.skip(action.direction); return;
    }
  });
}

let playButton: (() => void) | null = null;

/**
 * Space does what the play button of the page on screen does (0.5.9): on the home page the player's button, which
 * plays the song it shows; in the editor and the lighting workbench the timeline's, which plays this song from the
 * playhead. The page hands over its button's action while it is on screen and calls the result when it leaves.
 */
export function registerPlayButton(press: () => void): () => void {
  playButton = press;
  return () => { if (playButton === press) playButton = null; };
}

/** Presses the play button of the page on screen; a page without one (no song open in the editor) does nothing. */
export function pressPlayButton(): void {
  playButton?.();
}

/**
 * Escape during a drag or a trim only cancels it and goes no further: the timeline and the window would otherwise take
 * the same press as "stop the show" (0.5.9). For listeners on window in the capture phase, which run first; drags use
 * it through `DragSession` (components/drag-session.ts).
 */
export function cancelDragOnEscape(event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>, dragging: boolean, cancel: () => void): void {
  if (event.key !== 'Escape' || !dragging) return;
  event.preventDefault(); event.stopPropagation(); cancel();
}
