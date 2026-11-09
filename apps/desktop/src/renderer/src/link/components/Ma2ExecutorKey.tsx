import { useEffect, useState, type ReactNode } from 'react';
import type { Ma2ExecutorPage } from '@tb/schema';
import { ma2ExecutorFunctions } from '@tb/core/link';
import { executorKeyDown, executorKeyUp } from './ma2-executor-keys';

export function Ma2ExecutorKey({ item, page, index, primary = false, matched = true, children, input }: {
  item: Ma2ExecutorPage['items'][number]; page: number; index: number; primary?: boolean; matched?: boolean; children?: ReactNode;
  input: { press: (item: Ma2ExecutorPage['items'][number], page: number, button: number) => void; release: (item: Ma2ExecutorPage['items'][number], page: number, button: number) => void };
}): JSX.Element {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!held) return;
    const clear = (): void => setHeld(false);
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, [held]);
  const code = item.buttons?.[index] ?? (index === 0 ? item.button : null);
  const fn = code === null || code === undefined ? undefined : ma2ExecutorFunctions[code];
  const momentary = fn?.momentary === true;
  const label = primary ? `执行器 ${page}.${item.slot} · ${item.name}` : `执行器 ${page}.${item.slot} ${fn?.name ?? `按键 ${index + 1}`}`;
  const press = (): void => { setHeld(true); input.press(item, page, index); };
  const release = (): void => { setHeld(false); input.release(item, page, index); };
  // A held-down key (Flash, Temp) keeps Space and Enter for itself; the play keys leave it alone (playback-keys.ts).
  // Any key presses the console once per press of Space or Enter, however long it is held (ma2-executor-keys.ts).
  return <button className={primary ? 'ma2-executor-key' : undefined} data-search-match={matched} data-momentary={momentary ? 'true' : undefined} aria-label={label} aria-pressed={held} disabled={code === 0}
    title={`${item.name} · ${page} 页 ${item.slot} 格 · ${fn?.name ?? '控台执行器按键'} · 右键编辑`}
    onPointerDown={event => {
      if (event.button !== 0 || !momentary) return;
      event.currentTarget.setPointerCapture(event.pointerId); press();
    }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onBlur={release} onDragStart={release}
    onClick={event => { if (!momentary) { event.stopPropagation(); input.press(item, page, index); } }}
    onKeyDown={event => executorKeyDown(event, momentary, press)}
    onKeyUp={event => executorKeyUp(event, momentary, release)}>
    {children ?? fn?.name ?? '—'}
  </button>;
}
