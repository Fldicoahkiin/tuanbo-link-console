import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { LinkWaveform, LinkWaveformResult, RundownItem } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { drawWaveformCanvas, type WaveformDisplay } from '../view-models/waveform-draw';
import { WaveformCache } from '../runtime/waveform-cache';
import { runWhenNotPlaying } from '../runtime/when-not-playing';
import { TimelineCanvasLayer, type CanvasPaint } from './TimelineCanvasLayer';
import type { TimelineScroll } from './timeline-scroll';

const waveformCache = new WaveformCache(source => linkDesktopViewModel.generateWaveform(source));

export type ReferenceWaveformSource = {
  projectPath: string;
  url: string;
  sha256: string;
  durationMs: number;
};

/** The one place a song's waveform source is put together (home player, editor, lighting workbench).
 * `url` must come from useReferenceAudioUrl, which only hands out the link of this very song. */
export function useSongWaveformSource(audio: Pick<NonNullable<RundownItem['referenceAudio']>, 'sha256' | 'durationMs'> | undefined | null, projectPath: string | null, url: string | null): ReferenceWaveformSource | null {
  const sha256 = audio?.sha256; const durationMs = audio?.durationMs;
  return useMemo(() => sha256 !== undefined && durationMs !== undefined && projectPath && url
    ? { projectPath, url, sha256, durationMs }
    : null, [durationMs, projectPath, sha256, url]);
}

/** The one hook for a song's waveform (home player, editor, lighting workbench): the main process's levels,
 * shared through one cache. An older cache is shown at once and replaced after its one rebuild. */
export function useSongWaveform(source: ReferenceWaveformSource | null): {
  waveform: LinkWaveform | null;
  error: string | null;
} {
  const [waveform, setWaveform] = useState<LinkWaveform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectPath = source?.projectPath;
  const url = source?.url;
  const sha256 = source?.sha256;
  const durationMs = source?.durationMs;

  useEffect(() => {
    let cancelled = false;
    setWaveform(null);
    setError(null);
    if (!projectPath || !url || !sha256 || durationMs === undefined) return;
    const lease = waveformCache.acquire({ projectPath, url, sha256, durationMs });
    const show = (value: LinkWaveformResult): void => {
      if (cancelled) return;
      setWaveform(value.waveform);
      setError(value.state === 'rebuild-failed' ? value.error : null);
    };
    const message = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
    let dropRebuild = (): void => undefined;
    void lease.result.then((value) => {
      show(value);
      if (cancelled || value.state !== 'unverified') return;
      // An old cache is shown while it is rebuilt once from this song's file, then replaced. The rebuild
      // decodes the whole song, so it waits until nothing is playing.
      dropRebuild = runWhenNotPlaying(() => { void lease.settled().then(show, (reason: unknown) => { if (!cancelled) setError(message(reason)); }); });
    }, (reason: unknown) => {
      if (!cancelled) {
        setWaveform(null);
        setError(message(reason));
      }
    });
    return () => { cancelled = true; dropRebuild(); lease.release(); };
  }, [durationMs, projectPath, sha256, url]);

  return { waveform, error };
}

/**
 * One canvas showing `[startSample, endSample)` of the source. Colour and label font come from the canvas's
 * own CSS (`color`, `font`) unless `color` is given. `data-ready` is set once a drawing is on it.
 */
export function WaveformCanvas(props: {
  waveform: LinkWaveform; display: WaveformDisplay; startSample: number; endSample: number; fill: number; normalize: boolean;
  color?: string; maximumWidth?: number; className?: string; style?: CSSProperties;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { waveform, display, startSample, endSample, fill, normalize, color, maximumWidth } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    delete canvas.dataset.ready;
    // ResizeObserver supplies post-layout geometry. Reading the canvas bounds
    // here forces another full editor layout while a page is being mounted.
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (!bounds || bounds.height <= 0) return;
      const style = getComputedStyle(canvas);
      drawWaveformCanvas(canvas, bounds, waveform, { display, startSample, endSample, fill, normalize, color: color ?? style.color, labels: display === 'spectrum' ? style.color : null, font: style.font, ...(maximumWidth === undefined ? {} : { maximumWidth }) });
      canvas.dataset.ready = 'true';
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [waveform, display, startSample, endSample, fill, normalize, color, maximumWidth]);
  return <canvas ref={canvasRef} className={props.className} style={props.style} data-waveform-engine="peaks" data-waveform-display={display} />;
}

/**
 * The song's waveform on the editor timeline's canvas layer (0.5.9 E5): the visible part of the song, drawn again
 * at each scroll without React, from the same levels as every other waveform (one `useSongWaveform`). The colour
 * comes from the CSS at each drawing.
 */
export function TimelineWaveformLayer({ waveform, scroll, pixelsPerSecond, viewportWidth, contentWidth }: {
  waveform: LinkWaveform; scroll: TimelineScroll; pixelsPerSecond: number; viewportWidth: number; contentWidth: number;
}): JSX.Element {
  const paint = useCallback<CanvasPaint>((canvas, view) => {
    const style = getComputedStyle(canvas), span = Math.max(1, contentWidth);
    drawWaveformCanvas(canvas, view, waveform, { display: 'waveform', startSample: view.scrollLeft / span * waveform.sampleCount, endSample: (view.scrollLeft + view.width) / span * waveform.sampleCount, fill: 0.88, normalize: true, color: style.color, labels: null, font: style.font });
  }, [contentWidth, waveform]);
  return <TimelineCanvasLayer className="timeline-waveform-canvas" scroll={scroll} pixelsPerSecond={pixelsPerSecond} viewportWidth={viewportWidth} paint={paint} />;
}

/** The home player's whole-song waveform (no scroll). */
export function TimelineWaveformCanvas(props: {
  waveform: LinkWaveform;
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
}): JSX.Element {
  const { contentWidth, waveform, scrollLeft, viewportWidth } = props;
  const visibleStart = scrollLeft / Math.max(1, contentWidth) * waveform.sampleCount;
  const visibleEnd = (scrollLeft + viewportWidth) / Math.max(1, contentWidth) * waveform.sampleCount;
  return <WaveformCanvas
    className="timeline-waveform-canvas"
    waveform={waveform} display="waveform" startSample={visibleStart} endSample={visibleEnd} fill={0.88} normalize color="#63d8c1"
    style={{ left: scrollLeft, width: viewportWidth }}
  />;
}
