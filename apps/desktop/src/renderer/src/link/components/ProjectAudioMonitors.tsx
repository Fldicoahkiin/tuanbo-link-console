import { Monitor } from 'lucide-react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { AudioSpectrum } from './AudioSpectrum';
export function ProjectSpectrumMonitor({ state, controller }: ProjectPlayer): JSX.Element {
  const lowPower = useDisplayPreferences((value) => value.lowPower);
  return <section className="home-spectrum-monitor" aria-label="实时音频频谱">
    {lowPower ? <div className="low-power-monitor"><Monitor /><span>低功耗模式</span><small>请在 OBS 中监看画面</small></div> : <AudioSpectrum controller={controller} state={state} />}
  </section>;
}

