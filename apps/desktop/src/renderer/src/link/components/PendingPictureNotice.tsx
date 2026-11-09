import { useEffect, useRef, useState } from 'react';
import { Notice } from '../ui';
import type { PictureNotice } from '../view-models/picture-on-air';
import './timeline-pending.css';

/** The line above the editor's tracks, under its toolbar, for as long as 联动台播放 holds the song
 * (view-models/picture-on-air): that picture edits made meanwhile wait for 停止 and a replay, counting
 * deletions, which the timeline no longer draws, or that this window cannot confirm which version OBS
 * plays. The tracks move once when playback starts or stops, never in the middle of an edit, and a
 * press in progress keeps the row as it was until it is released. Not in the toolbar: at 1280 × 720 its
 * one row has no room left. */
export function PendingPictureNotice({ notice }: { notice: PictureNotice | null }): JSX.Element | null {
  const shown = useSteadyWhilePressed(notice !== null);
  if (!shown) return null;
  return <div className="timeline-pending-notice">{notice
    ? <Notice compact tone={notice.tone} title={notice.text} tooltip={`${notice.text}。${notice.detail}`}>{notice.detail}</Notice>
    : null}</div>;
}

/** Tells `changed` when a pointer press begins and ends anywhere in `target` (the window): a release, a
 * cancel or the window losing focus ends it. Returns the way to stop. */
export function watchPointerPress(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, changed: (pressed: boolean) => void): () => void {
  const down = (): void => changed(true), up = (): void => changed(false);
  // Options as objects: Node's EventTarget, which the tests use, ignores a bare `true` when removing.
  const listeners = [['pointerdown', down, true], ['pointerup', up, true], ['pointercancel', up, true], ['blur', up, false]] as const;
  for (const [type, listener, capture] of listeners) target.addEventListener(type, listener, { capture });
  return () => { for (const [type, listener, capture] of listeners) target.removeEventListener(type, listener, { capture }); };
}

/** A press in progress and the value it holds; null while nothing is pressed. */
export type HeldPress = { value: boolean } | null;

/** The press after a pointer goes down (`pressed`) or up: one going down holds `value`, what is shown at that
 * moment, unless a press already holds one (a second finger or button); one going up lets go. */
export function nextPress(current: HeldPress, pressed: boolean, value: boolean): HeldPress {
  return pressed ? current ?? { value } : null;
}

/** `value`, except while a pointer is pressed: then it stays what it was when the press began, so a part
 * being dragged or trimmed never moves under the pointer because the song started or ended meanwhile. */
function useSteadyWhilePressed(value: boolean): boolean {
  const [press, setPress] = useState<HeldPress>(null);
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  useEffect(() => watchPointerPress(window, pressed => {
    const shown = latest.current;
    setPress(current => nextPress(current, pressed, shown));
  }), []);
  return press ? press.value : value;
}
