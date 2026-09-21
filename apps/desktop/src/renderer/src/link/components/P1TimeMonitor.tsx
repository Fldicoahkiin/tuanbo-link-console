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
    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      stream = player.controller.captureMonitoringStream();
      if (!stream) throw new Error('播放中的音频监测连接不可用');
      context = new AudioContext();
      void context.resume().catch((failure: unknown) => setError(`电平监测启动失败：${String(failure)}`));
      const source = context.createMediaStreamSource(stream);
      const splitter = context.createChannelSplitter(2);
      source.connect(splitter);
      const audioContext = context;
      setError(null);
      const analysers = [0, 1].map((channel) => { const analyser = audioContext.createAnalyser(); analyser.fftSize = 1024; splitter.connect(analyser, channel); return analyser; });
      const samples = new Float32Array(1024);
      timer = setInterval(() => setLevels(analysers.map((analyser) => {
        analyser.getFloatTimeDomainData(samples);
        const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        return Math.max(0, Math.min(1, (20 * Math.log10(Math.max(peak, 0.001)) + 60) / 60));
      })), 80);
    } catch (error) { console.error('双声道电平监测失败', error); setError(`电平监测失败：${String(error)}`); }
    return () => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (context) void context.close().catch((error: unknown) => console.error('电平监测关闭失败', error));
    };
  }, [player.controller, player.state.status, lowPower]);
  return { levels, error };
}
export function P1TimeMonitor({ player, title, positionMs, durationMs, frameRate, internal, outputTimecode }: {
  player: ProjectPlayer; title: string; positionMs: number; durationMs: number; frameRate: string; internal: boolean; outputTimecode: string;
}): JSX.Element {
  const { levels, error } = useStereoLevels(player);
  const sampleRate = useIntegrationStore((s) => s.profile?.internalPlayer?.audioSampleRate ?? 44100);
  const sending = internal && player.state.mtcEnabled && player.state.status === 'playing' && player.state.mtcSentPositionMs != null && !player.state.error;
  return <section className="p1-time-monitor" aria-label="P1 播放监测" title={title}>
    <header><span>播放监测</span><strong title={title}>{title}</strong></header>
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
    <footer><span>总时长 {clockText(durationMs).slice(0, 8)}</span><span>{internal ? `${sampleRate / 1000} kHz` : '外部主控'}</span></footer>
    <div className="monitor-mtc" data-sending={sending} title={`偏移后 MTC：${outputTimecode}；采样率为音频输出设置`}><span>MTC · {frameRate} fps</span><strong>{sending ? '发送中' : internal && player.state.status === 'paused' ? '已暂停' : '未发送'}</strong></div>
    {error ? <small role="alert">{error}</small> : null}
  </section>;
}
