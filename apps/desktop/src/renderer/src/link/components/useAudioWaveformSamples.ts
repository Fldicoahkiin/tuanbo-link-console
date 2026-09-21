import { useEffect, useState } from 'react';

/** Decode for visualization only. No audio graph or device output is created. */
export function useAudioWaveformSamples(url: string | null, enabled: boolean, rhythm: boolean) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBuffer(null); setError(null);
    if (!enabled || !url) return;
    const abort = new AbortController();
    const decode = async (): Promise<void> => {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`读取波形音频失败：${response.status}`);
      const data = await response.arrayBuffer();
      if (abort.signal.aborted) return;
      const context = new OfflineAudioContext(1, 1, 48000);
      const decoded = await context.decodeAudioData(data);
      if (!abort.signal.aborted) setBuffer(decoded);
    };
    void decode().catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(`精细波形解码失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => abort.abort();
  }, [url, enabled]);
  const filtered = useRhythmSamples(buffer, rhythm);
  return { buffer: rhythm ? filtered.buffer : buffer, error: error ?? filtered.error };
}

/** Filter only the visual reference. The original audio and playback are untouched. */
function useRhythmSamples(source: AudioBuffer | null, enabled: boolean) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBuffer(null); setError(null);
    if (!source || !enabled) return;
    let cancelled = false;
    const context = new OfflineAudioContext(source.numberOfChannels, source.length, source.sampleRate);
    const input = context.createBufferSource(); input.buffer = source;
    const highpass = context.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 45; highpass.Q.value = Math.SQRT1_2;
    const lowpass = context.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = 180; lowpass.Q.value = Math.SQRT1_2;
    input.connect(highpass).connect(lowpass).connect(context.destination); input.start();
    void context.startRendering().then(result => { if (!cancelled) setBuffer(result); }).catch((reason: unknown) => {
      if (!cancelled) setError(`节奏波形处理失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => { cancelled = true; };
  }, [source, enabled]);
  return { buffer, error };
}
