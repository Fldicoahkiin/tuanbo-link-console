import { useEffect, useRef, useState } from 'react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useDisplayPreferences } from '../stores/display-preferences-store';

export function AudioSpectrum({ controller, state }: ProjectPlayer): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const lowPower = useDisplayPreferences((value) => value.lowPower);
  useEffect(() => {
    setError(null);
    const target = canvas.current;
    target?.getContext('2d')?.clearRect(0, 0, target.width, target.height);
    if (lowPower || !controller || state.status !== 'playing') return;
    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      stream = controller.captureMonitoringStream();
      if (!stream) throw new Error('播放中的音频监测连接不可用');
      context = new AudioContext();
      void context.resume().catch((failure: unknown) => setError(`频谱启动失败：${String(failure)}`));
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const sampleRate = context.sampleRate;
      setError(null);
      timer = setInterval(() => {
        const target = canvas.current;
        const paint = target?.getContext('2d');
        if (!target || !paint) return;
        analyser.getByteFrequencyData(values);
        paint.clearRect(0, 0, target.width, target.height);
        const bars = 24;
        for (let index = 0; index < bars; index++) {
          const first = Math.max(1, Math.floor(40 * (16000 / 40) ** (index / bars) * analyser.fftSize / sampleRate));
          const last = Math.min(values.length, Math.max(first + 1, Math.ceil(40 * (16000 / 40) ** ((index + 1) / bars) * analyser.fftSize / sampleRate)));
          let energy = 0;
          for (let bin = first; bin < last; bin++) energy += (values[bin] ?? 0) ** 2;
          const height = Math.sqrt(energy / (last - first)) / 255 * target.height;
          paint.fillStyle = `hsl(${180 - index / (bars - 1) * 170} 78% 55%)`;
          paint.fillRect(index * target.width / bars, target.height - height, target.width / bars - 4, height);
        }
      }, 50);
    } catch (failure) { setError(`频谱监测失败：${String(failure)}`); }
    return () => {
      if (timer) clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (context) void context.close().catch((failure: unknown) => setError(`频谱关闭失败：${String(failure)}`));
    };
  }, [controller, state.status, lowPower]);
  const status = lowPower ? '低功耗 · 频谱已暂停' : state.status === 'paused' ? '已暂停' : state.status === 'stopped' ? '等待播放' : state.status === 'preparing' ? '正在准备音频' : state.status === 'error' ? '播放异常' : null;
  return <div className="audio-spectrum-display"><canvas ref={canvas} width={640} height={200} aria-label="音频频谱" />{error ? <small role="alert">{error}</small> : status ? <small>{status}</small> : null}</div>;
}
