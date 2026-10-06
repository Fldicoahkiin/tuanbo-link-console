import type { NativePlayerStatus } from '@tb/schema';
import type { AudioAnalysis } from './program-player';

/** Reads gain-adjusted samples measured inside WASAPI. Never creates a second
 * audio output or synthesizes a fake Web Audio node to animate the meters. */
export function nativeAudioAnalysis(read: () => NativePlayerStatus | null): AudioAnalysis {
  return {
    fftSize: 2048, frequencyBinCount: 1024,
    get sampleRate() { return read()?.sampleRate ?? 48000; },
    readSpectrum: values => {
      values.fill(0);
      const state = read();
      if (state?.status === 'playing' && state.analysis) values.set(state.analysis.spectrum.slice(0, values.length));
    },
    readPeaks: () => { const state = read(); return state?.status === 'playing' && state.analysis ? state.analysis.peaks : [0, 0]; }
  };
}
