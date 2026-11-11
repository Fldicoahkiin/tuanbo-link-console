import { useEffect, useState } from 'react';
import { wantMa2WebRemote } from '../stores/ma2-web-remote-store';
import { Ma2WebRemoteLogin } from './Ma2WebRemoteLogin';
import { Button } from '../ui';
import { MA2_CONSOLE_LIVE_STALE_MS, type Ma2ConsoleCell } from '../view-models/ma2-console-page';
import type { Ma2ConsoleLive } from './useMa2ConsoleLive';
import './ma2-console-page.css';

/** The banner under the page's toolbar while the show is on: a blue dot and plain words, never red (a wait is not a failure). */
export function Ma2ConsoleBanner({ banner }: { banner: { title: string; text: string } | null }): JSX.Element | null {
  if (!banner) return null;
  return <div className="ma2-console-banner" role="status" title={`${banner.title} · ${banner.text}`}>
    <span className="ma2-console-banner-dot" aria-hidden="true"/><strong>{banner.title}</strong><span aria-hidden="true">·</span><span className="ma2-console-banner-text">{banner.text}</span>
  </div>;
}

/** What a cell adds to its keys: the console's state, this computer's last failed press, and the fader. */
export function Ma2ConsoleCellStatus({ cell, faderReady, onFader }: { cell: Ma2ConsoleCell; faderReady: boolean; onFader: (slot: number, value: number) => void }): JSX.Element | null {
  const live = cell.live;
  const state = cell.key.kind === 'failed' ? <span className="ma2-console-cell-line" data-tone="danger" role="alert" title={cell.key.message}>{cell.key.message}</span>
    : live.kind === 'live' ? <span className="ma2-console-cell-line" data-running={live.running} data-stale={live.stale} title={live.stale ? `控台超过 ${MA2_CONSOLE_LIVE_STALE_MS / 1000} 秒没有读回，显示的是之前的状态` : live.running ? `在跑${live.cue ? ` · ${live.cue}` : ''}` : '没在跑'}>
      <span className="ma2-console-run" aria-label={live.running ? '在跑' : '没在跑'}/>{live.cue || (live.running ? '在跑' : '—')}
    </span>
    : live.kind === 'changed' ? <span className="ma2-console-cell-line" data-tone="warning" title={live.message}>{live.message}</span>
    : live.kind === 'waiting' ? <span className="ma2-console-cell-line" data-tone="quiet">读取中…</span> : null;
  const fader = cell.fader;
  if (!state && !fader) return null;
  return <div className="ma2-console-cell-status">
    {state}
    {fader ? <div className="ma2-console-fader" data-state={fader.state}>
      <input type="range" aria-label={`推杆 ${cell.address}`} min={fader.min} max={fader.max} step={(fader.max - fader.min) / 1000 || 0.001} value={fader.value} disabled={!faderReady}
        onChange={event => onFader(cell.slot, event.currentTarget.valueAsNumber)}/>
      <output title={fader.note ? `控台当前值：${fader.text || '—'}` : undefined}>{fader.note ?? fader.text ?? '—'}</output>
    </div> : null}
  </div>;
}

/** The page's footer: how keys and faders reach the console, the web remote's state and, when it is not connected, “连接网页遥控”. */
export function Ma2ConsoleFooter({ footer, connecting, onConnect }: { footer: Ma2ConsoleLive['footer']; connecting: boolean; onConnect: Ma2ConsoleLive['connect'] }): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!footer.connect) setOpen(false); }, [footer.connect]);
  return <footer className="ma2-console-footer" aria-label="控台连接">
    <span className="ma2-console-footer-line" data-tone={footer.keysTone} title={footer.keys}>{footer.keys}</span>
    <span className="ma2-console-footer-line" data-tone={footer.webRemoteTone} role="status" title={footer.webRemote}>{footer.webRemote}</span>
    {footer.connect && !open ? <Button size="sm" variant="secondary" onClick={() => { wantMa2WebRemote(); setOpen(true); }}>连接网页遥控</Button> : null}
    {footer.connect && open ? <div className="ma2-console-login"><Ma2WebRemoteLogin connecting={connecting} action="连接网页遥控" onConnect={onConnect}/></div> : null}
  </footer>;
}
