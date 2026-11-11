import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import type { InternalPlayerState } from '@tb/core/link';
import { useKeyOverlay } from '../keys/useKeyCommands';

export function PlayerStatusDetails({ error, errorTitle, notice, fault, engine }: Pick<InternalPlayerState, 'error' | 'errorTitle' | 'notice'> & { fault: string | null; engine: string }): JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = (): void => { if (details.current) details.current.open = false; summary.current?.focus(); };
  // While open, Escape closes it (the key router, while it is the top panel). The focus on its button is not in the
  // panel: Space there plays and pauses, as on any button.
  useKeyOverlay(open, { close, panel });
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details ref={details} className="player-diagnostics" onToggle={event => setOpen(event.currentTarget.open)} data-status={error || fault ? 'error' : notice ? 'notice' : 'clear'}>
    <summary ref={summary} aria-label="播放状态详情" title={error ? '播放出错，点击查看' : fault ? '部分输出出错，播放没有中断，点击查看' : notice ? '部分输出这次没有发出，点击查看' : '播放状态详情'}>{error || fault || notice ? <CircleAlert /> : <Info />}</summary>
    <div ref={panel} className="player-diagnostics-popover" role="region" aria-label="播放状态详情">
      <header><strong>播放状态</strong><button type="button" aria-label="关闭播放状态详情" onClick={close}><X /></button></header>
      <p>播放引擎：{engine}</p>
      {error ? <p className="player-error" role="alert">{errorTitle ? <strong>{errorTitle}：</strong> : null}{error}</p> : null}
      {fault ? <p className="player-error"><strong>输出出错（播放没有中断）：</strong>{fault}</p> : null}
      {notice ? <p className="player-notice" role="status">{notice}</p> : null}
      {!error && !fault && !notice ? <p>播放正常</p> : null}
    </div>
  </details>;
}
