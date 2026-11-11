import { useEffect, useRef } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import type { InternalPlayerState } from '@tb/core/link';
import { escapeClosesPanel, modalDialogOpen } from '../playback-keys';
import { useKeyOverlay } from '../keys/useKeyCommands';

export function PlayerStatusDetails({ error, errorTitle, notice, fault, engine }: Pick<InternalPlayerState, 'error' | 'errorTitle' | 'notice'> & { fault: string | null; engine: string }): JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const close = (): void => { if (details.current) details.current.open = false; summary.current?.focus(); };
  // While open, the window's keys leave Escape to it, and it closes itself (its own listener, until K4).
  useKeyOverlay(() => details.current?.open === true);
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false;
    };
    const escape = (event: KeyboardEvent): void => {
      if (escapeClosesPanel(event, modalDialogOpen(document)) && details.current?.open) {
        event.preventDefault();
        details.current.open = false;
        summary.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return <details ref={details} className="player-diagnostics" data-status={error || fault ? 'error' : notice ? 'notice' : 'clear'}>
    <summary ref={summary} aria-label="播放状态详情" title={error ? '播放出错，点击查看' : fault ? '部分输出出错，播放没有中断，点击查看' : notice ? '部分输出这次没有发出，点击查看' : '播放状态详情'}>{error || fault || notice ? <CircleAlert /> : <Info />}</summary>
    <div className="player-diagnostics-popover" role="region" aria-label="播放状态详情">
      <header><strong>播放状态</strong><button type="button" aria-label="关闭播放状态详情" onClick={close}><X /></button></header>
      <p>播放引擎：{engine}</p>
      {error ? <p className="player-error" role="alert">{errorTitle ? <strong>{errorTitle}：</strong> : null}{error}</p> : null}
      {fault ? <p className="player-error"><strong>输出出错（播放没有中断）：</strong>{fault}</p> : null}
      {notice ? <p className="player-notice" role="status">{notice}</p> : null}
      {!error && !fault && !notice ? <p>播放正常</p> : null}
    </div>
  </details>;
}
