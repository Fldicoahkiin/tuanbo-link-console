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
export function P1TimeMonitor({ player, title, positionMs, durationMs, frameRate, internal, outputTimecode }: {
  player: ProjectPlayer; title: string; positionMs: number; durationMs: number; frameRate: string; internal: boolean; outputTimecode: string;
}): JSX.Element {
  const { levels, error } = useStereoLevels(player);
  const sampleRate = useIntegrationStore((s) => s.profile?.internalPlayer?.audioSampleRate ?? 44100);
  const sending = internal && player.state.mtcEnabled && player.state.status === 'playing' && player.state.mtcSending && !player.state.error;
  return <section className="p1-time-monitor" aria-label="P1 播放监测" title={title}>
    <div className="monitor-readings">
      <dl>
        <div><dt>正计时</dt><dd aria-label={`正计时 ${clockText(positionMs)}`}>{clockText(positionMs)}</dd></div>
        <div><dt>倒计时</dt><dd className="monitor-remaining" aria-label={`倒计时 ${clockText(Math.max(0, durationMs - positionMs))}`}>{clockText(Math.max(0, durationMs - positionMs))}</dd></div>
      </dl>
      <div className="monitor-levels" role="group" aria-label="双声道电平">
        {levels.map((level, channel) => <div key={channel} className="monitor-channel" role="meter" aria-label={`${channel === 0 ? '左' : '右'}声道电平`} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(level * 60 - 60)} aria-valuetext={`${Math.round(level * 60 - 60)} dB`}>
          <div className="monitor-level-track">{Array.from({ length: 12 }, (_, index) => <i key={index} className={index < 2 ? 'peak' : index < 4 ? 'warning' : ''} data-lit={level > (11 - index) / 12} />)}</div>
          <small>{channel === 0 ? 'L' : 'R'}</small>
        </div>)}
      </div>
    </div>
    <div className="monitor-mtc" data-sending={sending} title={internal ? '已包含时间码偏移。没有发送时显示的是待发位置，不代表控台已经收到' : '最近接收到的外部 MTC 时间码'}>
      <span>MTC · {frameRate} fps</span>
      <strong className="monitor-mtc-clock" aria-label={`MTC 时间码 ${outputTimecode}`}>{outputTimecode}</strong>
      <span>{sending ? '发送中' : !internal ? outputTimecode === '—' ? '无信号' : '接收值' : player.state.status === 'paused' ? '已暂停' : '未发送'}</span>
      <span className="monitor-duration">总时长 {clockText(durationMs).slice(0, 8)}</span>
      <span>{internal ? `${sampleRate / 1000} kHz` : '跟随 P1'}</span>
    </div>
    {error ? <small role="alert">{error}</small> : null}
  </section>;
}
