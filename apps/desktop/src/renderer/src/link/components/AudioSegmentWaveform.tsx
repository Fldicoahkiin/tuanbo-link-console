import type { LinkWaveform } from '@tb/schema';
import type { WaveformDisplay } from '../view-models/waveform-draw';
import { WaveformCanvas } from './ReferenceWaveform';
import './waveform.css';

/** One audio segment's waveform: the part of the source file it plays, from the song's levels (E10).
 * Clip edits keep source offsets, so trimming or moving a segment never generates the waveform again. */
export function AudioSegmentWaveform({ waveform, display, sourceStartMs, durationMs, pixelsPerSecond, windowLeft, windowWidth, startMs }: {
  waveform: LinkWaveform | null; display: WaveformDisplay; sourceStartMs: number; durationMs: number;
  /** The part of the content drawn (the scroll block's window, 0.5.9 E5): a scroll inside it draws nothing again. */
  pixelsPerSecond: number; windowLeft: number; windowWidth: number; startMs: number;
}): JSX.Element {
  // Stable 256 px tiles over the window.
  const left = Math.floor(Math.max(0, windowLeft - startMs / 1000 * pixelsPerSecond) / 256) * 256;
  const inViewport = startMs / 1000 * pixelsPerSecond < windowLeft + windowWidth
    && (startMs + durationMs) / 1000 * pixelsPerSecond > windowLeft;
  const width = inViewport ? Math.max(0, Math.min(durationMs / 1000 * pixelsPerSecond - left, windowWidth + 256)) : 0;
  const visibleStart = sourceStartMs / 1000 + left / pixelsPerSecond;
  const seconds = width / pixelsPerSecond;
  return <div className="audio-segment-waveform" style={{ left, width }}>
    {seconds > 0 && waveform ? <WaveformCanvas className="audio-segment-canvas" waveform={waveform} display={display} fill={1} normalize={false}
      startSample={visibleStart * waveform.sampleRate} endSample={(visibleStart + seconds) * waveform.sampleRate} /> : null}
  </div>;
}
