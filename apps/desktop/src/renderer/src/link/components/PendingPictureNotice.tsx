import { useEffect, useRef, useState } from 'react';
import { Notice } from '../ui';
import type { PictureNotice } from '../view-models/picture-on-air';
import './timeline-pending.css';

/** The line above the editor's tracks, under its toolbar, for as long as 联动台播放 holds the song
 * (view-models/picture-on-air): that picture edits made meanwhile wait for 停止 and a replay, counting
 * deletions, which the timeline no longer draws, or that this window cannot confirm which version OBS
 * plays. The tracks move once when playback starts or stops, never in the middle of an edit: a press or
 * a drag in progress keeps the row as it was until it is over (holdWhilePressed). Not in the toolbar: at
 * 1280 × 720 its one row has no room left. */
export function PendingPictureNotice({ notice }: { notice: PictureNotice | null }): JSX.Element | null {
  const shown = useSteadyWhilePressed(notice !== null);
  if (!shown) return null;
  return <div className="timeline-pending-notice">{notice
    ? <Notice compact tone={notice.tone} title={notice.text} tooltip={`${notice.text}。${notice.detail}`}>{notice.detail}</Notice>
    : null}</div>;
}

/** Where presses are watched: the window. */
export type PressTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Tells `changed` when a press begins and ends anywhere in `target` (the window). A press is a pointer held down,
 * or a native drag, such as a part dragged in from the media library: Chromium takes the pointer over for it with a
 * pointercancel, and it ends with a drop or a dragend instead of a pointerup.
 *
 * An end is told a task later, once every handler of that event ran. The timeline works out where a dragged part
 * lands from the layout at the release (useTimelineItemDrag: elementFromPoint); told at once, React would remove or
 * insert the row in the microtask between the window's listener and the timeline's own, and the part would land on
 * the track 28 px away, possibly a hidden or locked one. A press or drag beginning before then goes on holding (a
 * quick double click). Losing focus ends a press at once: nothing in the window sees its release. Returns the way to
 * stop, which also drops an end not told yet.
 */
export function watchPointerPress(target: PressTarget, changed: (pressed: boolean) => void): () => void {
  let dragging = false, ending: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => { clearTimeout(ending); ending = undefined; };
  const begin = (drag: boolean) => (): void => { settle(); dragging = drag; changed(true); };
  const end = (): void => { settle(); dragging = false; ending = setTimeout(() => { ending = undefined; changed(false); }, 0); };
  // A native drag goes on after the pointercancel that hands the pointer over to it.
  const cancel = (): void => { if (!dragging) end(); };
  const leave = (): void => { settle(); dragging = false; changed(false); };
  // Captured, so a press is seen before the timeline's handlers, and a release that a handler stops still counts.
  // Options as objects: Node's EventTarget, which the tests use, ignores a bare `true` when removing.
  const listeners = [['pointerdown', begin(false), true], ['dragstart', begin(true), true], ['pointerup', end, true], ['pointercancel', cancel, true],
    ['drop', end, true], ['dragend', end, true], ['blur', leave, false]] as const;
  for (const [type, listener, capture] of listeners) target.addEventListener(type, listener, { capture });
  return () => { settle(); for (const [type, listener, capture] of listeners) target.removeEventListener(type, listener, { capture }); };
}

/** A press in progress and the value it holds; null while nothing is pressed. */
export type HeldPress = { value: boolean } | null;

/**
 * Keeps a value steady while a press goes on in `target` (watchPointerPress): `hold` hears how the press changes.
 * A press beginning holds `shown()`, what shows at that moment, unless a press already holds one (a second finger);
 * its end lets go.
 */
export function holdWhilePressed(target: PressTarget, shown: () => boolean, hold: (next: (current: HeldPress) => HeldPress) => void): () => void {
  return watchPointerPress(target, pressed => {
    const value = shown();
    hold(current => pressed ? current ?? { value } : null);
  });
}

/** What shows for `value`: that, except while `press` holds what showed when it began. */
export function shownWhilePressed(press: HeldPress, value: boolean): boolean {
  return press ? press.value : value;
}

/** `value`, except while a pointer is pressed or a drag goes on: then it stays what it was when that began, so a
 * part being dragged or trimmed never moves under the pointer because the song started or ended meanwhile. */
function useSteadyWhilePressed(value: boolean): boolean {
  const [press, setPress] = useState<HeldPress>(null);
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  useEffect(() => holdWhilePressed(window, () => latest.current, setPress), []);
  return shownWhilePressed(press, value);
}
