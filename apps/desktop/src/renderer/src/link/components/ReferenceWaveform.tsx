import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { TimelineSpan } from '@tb/core/link';
import type { LinkMediaAsset, ReferenceMediaClip } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { TimelineDrag } from './TimelineItems';
import { timelineSpanWidth } from './timeline-geometry';
import { waveformColumns, waveformNormalization } from '../view-models/waveform-viewport';
import { WaveformCache } from '../runtime/waveform-cache';

const waveformCache = new WaveformCache(source => linkDesktopViewModel.generateWaveform(source));

export type ReferenceWaveformSource = {
  projectPath: string;
  url: string;
  sha256: string;
  durationMs: number;
};

export function useReferenceWaveformPeaks(source: ReferenceWaveformSource | null): {
  peaks: number[];
  error: string | null;
} {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const projectPath = source?.projectPath;
  const url = source?.url;
  const sha256 = source?.sha256;
  const durationMs = source?.durationMs;

  useEffect(() => {
    let cancelled = false;
    setPeaks([]);
    setError(null);
    if (!projectPath || !url || !sha256 || durationMs === undefined) {
      setPeaks([]);
      setError(null);
      return;
    }
    const lease = waveformCache.acquire({ projectPath, url, sha256, durationMs });
    void lease.result.then((value) => {
      if (!cancelled) {
        setPeaks(value);
        setError(null);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setPeaks([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; lease.release(); };
  }, [durationMs, projectPath, sha256, url]);

  return { peaks, error };
}

export function TimelineWaveformCanvas(props: {
  peaks: readonly number[];
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { contentWidth, peaks, scrollLeft, viewportWidth } = props;
  const normalizationLevel = useMemo(() => waveformNormalization(peaks), [peaks]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    // ResizeObserver supplies post-layout geometry. Reading the canvas bounds
    // here forces another full editor layout while a page is being mounted.
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) drawVisibleWaveform(canvas, bounds, { contentWidth, peaks, scrollLeft, viewportWidth, normalizationLevel });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [contentWidth, peaks, scrollLeft, viewportWidth, normalizationLevel]);

  return <canvas
    className="timeline-waveform-canvas"
    ref={canvasRef}
    style={{ left: scrollLeft, width: viewportWidth }}
  />;
}

export function TimelineMediaWaveforms(props: {
  projectPath: string | null;
  assets: LinkMediaAsset[];
  clips: ReferenceMediaClip[];
  clipSpans: ReadonlyMap<string, TimelineSpan>;
  pixelsPerSecond: number;
  selectedAudioClipId: string | null;
  activeClipIds: ReadonlySet<string>;
  resizeDrag: { id: string; previewStartMs: number; previewDurationMs: number } | null;
  drag: TimelineDrag | null;
  onBeginDrag: (event: PointerEvent<HTMLButtonElement>, kind: 'clip', id: string, originMs: number) => void;
  onMoveDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onEndDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancelDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onTrimBegin: (event: PointerEvent<HTMLElement>, clip: ReferenceMediaClip, edge: 'start' | 'end', sourceDurationMs?: number) => void;
  onTrimMove: (event: PointerEvent<HTMLElement>) => void;
  onTrimEnd: (event: PointerEvent<HTMLElement>) => void;
  onTrimCancel: (event: PointerEvent<HTMLElement>) => void;
}): JSX.Element {
  const assets = new Map(props.assets.map((asset) => [asset.id, asset]));
  return <>{props.clips.map((clip) => {
    const asset = assets.get(clip.assetId);
    if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio') || clip.embeddedAudioEnabled === false) return null;
    const span = props.clipSpans.get(clip.id);
    if (!span) throw new Error(`时间线解析结果缺少音频片段：${clip.id}`);
    return <TimelineMediaWaveform key={clip.id} {...props} asset={asset} clip={clip} resolvedStartMs={span.startMs} resolvedDurationMs={span.durationMs} />;
  })}</>;
}

function TimelineMediaWaveform(props: {
  projectPath: string | null;
  asset: LinkMediaAsset;
  clip: ReferenceMediaClip;
  resolvedStartMs: number;
  resolvedDurationMs: number;
  pixelsPerSecond: number;
  selectedAudioClipId: string | null;
  activeClipIds: ReadonlySet<string>;
  resizeDrag: { id: string; previewStartMs: number; previewDurationMs: number } | null;
  drag: TimelineDrag | null;
  onBeginDrag: (event: PointerEvent<HTMLButtonElement>, kind: 'clip', id: string, originMs: number) => void;
  onMoveDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onEndDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancelDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onTrimBegin: (event: PointerEvent<HTMLElement>, clip: ReferenceMediaClip, edge: 'start' | 'end', sourceDurationMs?: number) => void;
  onTrimMove: (event: PointerEvent<HTMLElement>) => void;
  onTrimEnd: (event: PointerEvent<HTMLElement>) => void;
  onTrimCancel: (event: PointerEvent<HTMLElement>) => void;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const projectPath = props.projectPath;
  const asset = props.asset;
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setUrl(null);
      setSourceError(null);
      return;
    }
    void linkDesktopViewModel.ensureMediaAudioUrl({
      projectPath,
      relativePath: asset.relativePath,
      sha256: asset.sha256,
      kind: asset.kind
    }).then((value) => {
      if (!cancelled) {
        setUrl(value);
        setSourceError(null);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setUrl(null);
        setSourceError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [asset.kind, asset.relativePath, asset.sha256, projectPath]);
  const durationMs = asset.durationMs ?? (props.clip.sourceOffsetMs ?? 0) + props.clip.durationMs;
  const waveform = useReferenceWaveformPeaks(projectPath && url
    ? { projectPath, url, sha256: asset.sha256, durationMs }
    : null);
  const originMs = props.resolvedStartMs;
  const startMs = props.resizeDrag?.id === props.clip.id
    ? props.resizeDrag.previewStartMs
    : props.drag?.kind === 'clip' && props.drag.id === props.clip.id ? props.drag.previewMs : originMs;
  const clipDurationMs = props.resizeDrag?.id === props.clip.id ? props.resizeDrag.previewDurationMs : props.resolvedDurationMs;
  const style: CSSProperties = {
    left: startMs / 1_000 * props.pixelsPerSecond,
    width: timelineSpanWidth(clipDurationMs, props.pixelsPerSecond)
  };
  const error = sourceError ?? waveform.error;
  return <button type="button" className={`timeline-media-waveform ${props.selectedAudioClipId === props.clip.id ? 'is-selected' : ''} ${props.activeClipIds.has(props.clip.id) ? 'is-active' : ''} ${error ? 'has-error' : ''}`} style={style} title={error ?? `${asset.name} · 单击选中，Delete 或顶部垃圾桶关闭音频`} onPointerDown={(event) => props.onBeginDrag(event, 'clip', props.clip.id, originMs)} onPointerMove={props.onMoveDrag} onPointerUp={props.onEndDrag} onPointerCancel={props.onCancelDrag}>
    <i className="timeline-trim-handle start" title="拖动同步修剪音频与画面" onPointerDown={(event) => props.onTrimBegin(event, props.clip, 'start', asset.durationMs)} onPointerMove={props.onTrimMove} onPointerUp={props.onTrimEnd} onPointerCancel={props.onTrimCancel} />
    {waveform.peaks.length > 0 ? <ClippedWaveformCanvas
      peaks={waveform.peaks}
      sourceDurationMs={durationMs}
      sourceOffsetMs={props.clip.sourceOffsetMs ?? 0}
      clipDurationMs={clipDurationMs}
    /> : null}
    <span className="timeline-media-audio-label">{error ? (error === '素材不包含音频轨道' ? '无音轨' : '音轨读取失败') : `${asset.name} · 内嵌音频`}</span>
    <i className="timeline-trim-handle end" title="拖动同步修剪音频与画面" onPointerDown={(event) => props.onTrimBegin(event, props.clip, 'end', asset.durationMs)} onPointerMove={props.onTrimMove} onPointerUp={props.onTrimEnd} onPointerCancel={props.onTrimCancel} />
  </button>;
}

function ClippedWaveformCanvas(props: {
  peaks: readonly number[];
  sourceDurationMs: number;
  sourceOffsetMs: number;
  clipDurationMs: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { peaks, sourceDurationMs, sourceOffsetMs, clipDurationMs } = props;
  const visiblePeaks = useMemo(() => {
    const start = Math.max(0, Math.floor(sourceOffsetMs / sourceDurationMs * peaks.length));
    const end = Math.min(peaks.length, Math.ceil((sourceOffsetMs + clipDurationMs) / sourceDurationMs * peaks.length));
    return peaks.slice(start, Math.max(start + 1, end));
  }, [peaks, sourceDurationMs, sourceOffsetMs, clipDurationMs]);
  const normalizationLevel = useMemo(() => waveformNormalization(visiblePeaks), [visiblePeaks]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) drawClippedWaveform(canvas, bounds, visiblePeaks, normalizationLevel);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [visiblePeaks, normalizationLevel]);
  return <canvas ref={canvasRef} />;
}

function drawVisibleWaveform(
  canvas: HTMLCanvasElement,
  bounds: { width: number; height: number },
  props: { peaks: readonly number[]; scrollLeft: number; viewportWidth: number; contentWidth: number; normalizationLevel: number }
): void {
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制波形');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#63d8c1';
  context.lineWidth = Math.max(1, scale);
  const center = canvas.height / 2;
  const visibleStart = props.scrollLeft / Math.max(1, props.contentWidth);
  const visibleEnd = (props.scrollLeft + props.viewportWidth) / Math.max(1, props.contentWidth);
  const startIndex = Math.min(props.peaks.length, Math.max(0, Math.floor(visibleStart * props.peaks.length)));
  const endIndex = Math.min(props.peaks.length, Math.ceil(visibleEnd * props.peaks.length));
  const columns = waveformColumns(props.peaks, startIndex, endIndex, canvas.width);
  context.beginPath();
  for (let x = 0; x < columns.length; x += 1) {
    const normalizedPeak = Math.min(1, columns[x]! / props.normalizationLevel);
    const height = normalizedPeak * center * 0.88;
    context.moveTo(x, center - height);
    context.lineTo(x, center + height);
  }
  context.stroke();
}

function drawClippedWaveform(canvas: HTMLCanvasElement, bounds: { width: number; height: number }, visiblePeaks: readonly number[], normalizationLevel: number): void {
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.min(4096, Math.floor(bounds.width * scale)));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制波形');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#8be7d4';
  context.lineWidth = Math.max(1, scale);
  const center = canvas.height / 2;
  const columns = waveformColumns(visiblePeaks, 0, visiblePeaks.length, canvas.width);
  context.beginPath();
  for (let x = 0; x < columns.length; x += 1) {
    const height = Math.min(1, columns[x]! / normalizationLevel) * center * 0.82;
    context.moveTo(x, center - height);
    context.lineTo(x, center + height);
  }
  context.stroke();
}
