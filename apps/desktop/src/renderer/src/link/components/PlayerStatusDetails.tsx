import { useEffect, useRef } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import type { InternalPlayerState } from '../runtime/internal-playback-controller';

export function PlayerStatusDetails({ error, errorTitle, notice }: Pick<InternalPlayerState, 'error' | 'errorTitle' | 'notice'>): JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const close = (): void => { if (details.current) details.current.open = false; summary.current?.focus(); };
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false;
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && details.current?.open) {
        event.preventDefault();
        details.current.open = false;
        summary.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return <details ref={details} className="player-diagnostics" data-status={error ? 'error' : notice ? 'notice' : 'clear'}>
    <summary ref={summary} aria-label="播放状态详情" title={error ? '播放异常，点击查看' : notice ? '部分通道未参与，点击查看' : '播放状态详情'}>{error || notice ? <CircleAlert /> : <Info />}</summary>
    <div className="player-diagnostics-popover" role="region" aria-label="播放状态详情">
      <header><strong>播放状态</strong><button type="button" aria-label="关闭播放状态详情" onClick={close}><X /></button></header>
      {error ? <p className="player-error" role="alert">{errorTitle ? <strong>{errorTitle}：</strong> : null}{error}</p> : null}
      {notice ? <p className="player-notice" role="status">{notice}</p> : null}
      {!error && !notice ? <p>暂无播放异常</p> : null}
    </div>
  </details>;
}
