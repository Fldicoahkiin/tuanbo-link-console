import type { LinkWaveform } from '@tb/schema';
import type { WaveformDisplay } from '../view-models/waveform-draw';
import { WaveformCanvas } from './ReferenceWaveform';
import './waveform.css';

/** One audio segment's waveform: the part of the source file it plays, from the song's levels (E10).
 * Clip edits keep source offsets, so trimming or moving a segment never generates the waveform again. */
export function AudioSegmentWaveform({ waveform, display, sourceStartMs, durationMs, pixelsPerSecond, scrollLeft, viewportWidth, startMs }: {
  waveform: LinkWaveform | null; display: WaveformDisplay; sourceStartMs: number; durationMs: number;
  pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; startMs: number;
}): JSX.Element {
  // Stable 256 px tiles: scrolling during playback redraws only when a tile boundary is crossed.
  const left = Math.floor(Math.max(0, scrollLeft - startMs / 1000 * pixelsPerSecond) / 256) * 256;
  const inViewport = startMs / 1000 * pixelsPerSecond < scrollLeft + viewportWidth
    && (startMs + durationMs) / 1000 * pixelsPerSecond > scrollLeft;
  const width = inViewport ? Math.max(0, Math.min(durationMs / 1000 * pixelsPerSecond - left, viewportWidth + 256)) : 0;
  const visibleStart = sourceStartMs / 1000 + left / pixelsPerSecond;
  const seconds = width / pixelsPerSecond;
  return <div className="audio-segment-waveform" style={{ left, width }}>
    {seconds > 0 && waveform ? <WaveformCanvas className="audio-segment-canvas" waveform={waveform} display={display} fill={1} normalize={false}
      startSample={visibleStart * waveform.sampleRate} endSample={(visibleStart + seconds) * waveform.sampleRate} /> : null}
  </div>;
}
