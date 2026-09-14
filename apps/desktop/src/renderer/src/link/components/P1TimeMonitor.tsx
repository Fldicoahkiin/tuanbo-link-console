import { useEffect, useState } from 'react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { useIntegrationStore } from '../stores/integration-store';

const DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
const SEGMENTS = [
  ['a', '4,0 18,0 21,3 18,6 4,6 1,3'], ['b', '19,7 22,4 22,22 19,25 16,22 16,10'],
  ['c', '19,27 22,30 22,48 19,51 16,48 16,30'], ['d', '4,50 18,50 21,53 18,56 4,56 1,53'],
  ['e', '3,27 6,30 6,48 3,51 0,48 0,30'], ['f', '3,5 6,8 6,22 3,25 0,22 0,8'],
  ['g', '4,25 18,25 21,28 18,31 4,31 1,28']
];
function clockText(ms: number): string {
  const value = Math.max(0, Math.floor(ms / 10));
  return [Math.floor(value / 360000), Math.floor(value / 6000) % 60, Math.floor(value / 100) % 60, value % 100].map((n) => String(n).padStart(2, '0')).join(':');
}
function DigitalClock({ ms, label, color, y }: { ms: number; label: string; color: string; y: number }): JSX.Element {
  const value = clockText(ms);
  return <g transform={`translate(110 ${y})`} fill={color} aria-label={`${label} ${value}`} role="img">{[...value].map((char, index) => {
    const x = index * 25 - (index > 2 ? 14 : 0) - (index > 5 ? 14 : 0) - (index > 8 ? 14 : 0);
    return char === ':' ? <g key={index} transform={`translate(${x} 0)`}><rect x="2" y="16" width="4" height="5" /><rect x="2" y="38" width="4" height="5" /></g> : <g key={index} transform={`translate(${x} 0)`}>{SEGMENTS.map(([segment, points]) => <polygon key={segment} points={points} opacity={DIGITS[Number(char)]?.includes(segment ?? '') ? 1 : 0.035} />)}</g>;
  })}</g>;
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
  const sending = internal && player.state.mtcEnabled && player.state.status === 'playing' && !player.state.error;
  return <section className="p1-time-monitor" aria-label="P1 播放监测" title={title}>
    <svg viewBox="0 0 480 260" role="group" aria-label="播放时间与双声道电平">
      <text x="240" y="33" textAnchor="middle" className="p1-track-title">{title.length > 30 ? `${title.slice(0, 27)}…` : title}</text>
      <text x="10" y="88">正计时：</text><DigitalClock ms={positionMs} label="正计时" color="#00ff00" y={57} />
      <text x="10" y="164">倒计时：</text><DigitalClock ms={Math.max(0, durationMs - positionMs)} label="倒计时" color="#ff0000" y={133} />
      <text x="10" y="216" className="p1-monitor-meta">总时长：{clockText(durationMs).slice(0, 8)} <tspan>采样率：{internal ? `${sampleRate / 1000} kHz` : '—'}</tspan></text>
      <text x="10" y="247" className="p1-monitor-meta">MIDI时间码(MTC-{frameRate}Hz)：<tspan fill={sending ? '#00ff00' : '#ff0000'}>{sending ? '发送中' : internal && player.state.status === 'paused' ? '已暂停' : '未发送'}</tspan><title>偏移后 MTC：{outputTimecode}；采样率为音频输出设置</title></text>
      {levels.map((level, channel) => <g key={channel} aria-label={`${channel === 0 ? '左' : '右'}声道电平`}>{Array.from({ length: 12 }, (_, index) => <rect key={index} x={400 + channel * 35} y={65 + index * 16} width="25" height="13" rx="3" fill={`hsl(${25 + index * 7} 100% 50%)`} opacity={level > (11 - index) / 12 ? 1 : 0.12} />)}</g>)}
    </svg>
    {error ? <small role="alert">{error}</small> : null}
  </section>;
}
