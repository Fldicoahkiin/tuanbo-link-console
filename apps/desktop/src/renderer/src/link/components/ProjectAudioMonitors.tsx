import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Monitor, X } from 'lucide-react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { AudioSpectrum } from './AudioSpectrum';
export function ProjectSpectrumMonitor({ state, controller }: ProjectPlayer): JSX.Element {
  const lowPower = useDisplayPreferences((value) => value.lowPower);
  const [dismissed, setDismissed] = useState(false);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => { setDismissed(false); }, [state.error]);
  useEffect(() => {
    if (!state.error || dismissed) return;
    const dismissOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !notice.current?.contains(event.target)) setDismissed(true);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [state.error, dismissed]);
  return <section className="home-spectrum-monitor" aria-label="实时音频频谱">
    {lowPower ? <div className="low-power-monitor"><Monitor /><span>低功耗模式</span><small>请在 OBS 中监看画面</small></div> : <AudioSpectrum controller={controller} state={state} />}
    {state.error && !dismissed ? <div ref={notice} className="player-status-notice" role="alert">
      <header><strong><CircleAlert />{state.errorTitle ?? '播放操作失败'}</strong><button type="button" aria-label="关闭播放提示" title="关闭播放提示" onClick={() => setDismissed(true)}><X /></button></header>
      <div className="player-status-details"><p>{state.error}</p><small>请按上述提示处理后，再点击播放。</small></div>
    </div> : null}
  </section>;
}

