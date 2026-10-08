import { useMemo, useCallback } from 'react';
import { WaveSurferSurface } from './WaveSurferSurface';
import { WaveformEnvelope } from '../view-models/waveform-envelope';
const envelopes = new WeakMap<AudioBuffer, WaveformEnvelope[]>();

/** Only send the visible source interval to the library; clip edits retain source offsets. */
export function AudioSegmentWaveform({ samples, peaks, sourceStartMs, sourceDurationMs, durationMs, pixelsPerSecond, scrollLeft, viewportWidth, startMs }: {
  samples?: AudioBuffer | null;
  peaks: readonly number[]; sourceStartMs: number; sourceDurationMs: number; durationMs: number;
  pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; startMs: number;
}): JSX.Element {
  // Stable tiles avoid restarting waveform/FFT work on every playback scroll frame.
  const left = Math.floor(Math.max(0, scrollLeft - startMs / 1000 * pixelsPerSecond) / 256) * 256;
  const inViewport = startMs / 1000 * pixelsPerSecond < scrollLeft + viewportWidth
    && (startMs + durationMs) / 1000 * pixelsPerSecond > scrollLeft;
  const width = inViewport ? Math.max(0, Math.min(durationMs / 1000 * pixelsPerSecond - left, viewportWidth + 256)) : 0;
  const visibleStart = sourceStartMs / 1000 + left / pixelsPerSecond;
  const seconds = width / pixelsPerSecond;
  const channels = useMemo(() => {
    if (seconds <= 0) return [];
    if (samples) {
      const first = Math.max(0, Math.floor(visibleStart * samples.sampleRate));
      const last = Math.min(samples.length, Math.ceil((visibleStart + seconds) * samples.sampleRate));
      let cached = envelopes.get(samples);
      if (!cached) { cached = Array.from({length:samples.numberOfChannels},(_,index)=>new WaveformEnvelope(samples.getChannelData(index))); envelopes.set(samples,cached); }
      return cached.map(channel=>channel.range(first,last,width));
    }
    const rate = peaks.length / (sourceDurationMs / 1000);
    return [Float32Array.from(peaks.slice(Math.max(0, Math.floor(visibleStart * rate)), Math.ceil((visibleStart + seconds) * rate)))];
  }, [samples, peaks, visibleStart, seconds, sourceDurationMs, width]);
  const spectrumChannels = useCallback(() => samples ? Array.from({length:samples.numberOfChannels},(_,index)=>samples.getChannelData(index).slice(Math.max(0,Math.floor(visibleStart*samples.sampleRate)),Math.min(samples.length,Math.ceil((visibleStart+seconds)*samples.sampleRate)))) : channels, [samples,visibleStart,seconds,channels]);
  return <div className="audio-segment-waveform" style={{ left, width }}>
    {seconds > 0 && channels[0]?.length ? <WaveSurferSurface channels={channels} duration={seconds} allowSpectrum={Boolean(samples)} spectrumChannels={spectrumChannels} /> : null}
  </div>;
}
