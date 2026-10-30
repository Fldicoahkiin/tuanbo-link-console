import { useEffect, useState } from 'react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { useIntegrationStore } from '../stores/integration-store';

function clockText(ms: number): string {
  const value = Math.max(0, Math.floor(ms / 10));
  return [Math.floor(value / 360000), Math.floor(value / 6000) % 60, Math.floor(value / 100) % 60, value % 100].map((n) => String(n).padStart(2, '0')).join(':');
}
function useStereoLevels(player: ProjectPlayer): { levels: number[]; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState([0, 0]);
  const lowPower = useDisplayPreferences((s) => s.lowPower);
  useEffect(() => {
    setError(null);
    setLevels([0, 0]);
    if (lowPower || player.state.status !== 'playing' || !player.controller) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      const analysis = player.controller.getAudioAnalysis();
      if (!analysis) throw new Error('读不到正在播放的音频，电平暂时无法显示');
      setError(null);
      timer = setInterval(() => setLevels(analysis.readPeaks().map((peak) => {
        return Math.max(0, Math.min(1, (20 * Math.log10(Math.max(peak, 0.001)) + 60) / 60));
      })), 80);
    } catch (error) { console.error('双声道电平监测失败', error); setError(`电平显示失败：${String(error)}`); }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [player.controller, player.state.status, lowPower]);
  return { levels, error };
}
/**
 * Timecode and clocks next to the home player (2026-10-30 rework). The MTC the console reads comes
 * first and largest; elapsed and remaining time and the stereo levels follow.
 */
export function P1TimeMonitor({ player, title, positionMs, durationMs, frameRate, internal, outputTimecode }: {
  player: ProjectPlayer; title: string; positionMs: number; durationMs: number; frameRate: string; internal: boolean; outputTimecode: string;
}): JSX.Element {
  const { levels, error } = useStereoLevels(player);
  const sampleRate = useIntegrationStore((s) => s.profile?.internalPlayer?.audioSampleRate ?? 44100);
  const sending = internal && player.state.mtcEnabled && player.state.status === 'playing' && player.state.mtcSending && !player.state.error;
  const state = sending ? '发送中' : !internal ? outputTimecode === '—' ? '无信号' : '接收值' : player.state.status === 'paused' ? '已暂停' : '未发送';
  const remaining = clockText(Math.max(0, durationMs - positionMs));
  return <section className="home-clock" data-sending={sending} aria-label="时间码与计时" title={title}>
    <header className="home-clock-heading">
      <span>MTC · {frameRate} fps</span>
      <span className="home-clock-state" data-sending={sending} title={internal ? '已包含时间码偏移。没有发送时显示的是待发位置，不代表控台已经收到' : '最近接收到的外部 MTC 时间码'}>{state}</span>
    </header>
    <strong className="home-clock-mtc" aria-label={`MTC 时间码 ${outputTimecode}`}>{outputTimecode}</strong>
    <dl className="home-clock-readings">
      <div><dt>正计时</dt><dd aria-label={`正计时 ${clockText(positionMs)}`}>{clockText(positionMs)}</dd></div>
      <div><dt>倒计时</dt><dd data-kind="remaining" aria-label={`倒计时 ${remaining}`}>{remaining}</dd></div>
    </dl>
    <div className="home-levels" role="group" aria-label="双声道电平">
      {levels.map((level, channel) => <div key={channel} className="home-level" role="meter" aria-label={`${channel === 0 ? '左' : '右'}声道电平`} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(level * 60 - 60)} aria-valuetext={`${Math.round(level * 60 - 60)} dB`}>
        <small aria-hidden="true">{channel === 0 ? 'L' : 'R'}</small>
        <span className="home-level-track">{Array.from({ length: 12 }, (_, index) => <i key={index} data-zone={index > 9 ? 'peak' : index > 7 ? 'warning' : 'normal'} data-lit={level > index / 12} />)}</span>
      </div>)}
    </div>
    <footer className="home-clock-footer">
      <span className="home-clock-duration">总时长 {clockText(durationMs).slice(0, 8)}</span>
      <span>{internal ? `${sampleRate / 1000} kHz` : '跟随 P1'}</span>
    </footer>
    {error ? <small className="home-clock-error" role="alert">{error}</small> : null}
  </section>;
}
