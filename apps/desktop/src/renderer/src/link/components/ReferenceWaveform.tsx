import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { TimelineSpan } from '@tb/core/link';
import type { LinkMediaAsset, ReferenceMediaClip } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { TimelineDrag } from './TimelineItems';
import { timelineSpanWidth } from './timeline-geometry';

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
    if (!projectPath || !url || !sha256 || durationMs === undefined) {
      setPeaks([]);
      setError(null);
      return;
    }
    void loadPeaks({ projectPath, url, sha256, durationMs }).then((value) => {
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
    return () => { cancelled = true; };
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
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    const draw = (): void => drawVisibleWaveform(canvas, { contentWidth, peaks, scrollLeft, viewportWidth });
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [contentWidth, peaks, scrollLeft, viewportWidth]);

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
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = (): void => drawClippedWaveform(canvas, props);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [props]);
  return <canvas ref={canvasRef} />;
}

function loadPeaks(source: ReferenceWaveformSource): Promise<number[]> {
  return linkDesktopViewModel.generateWaveform(source);
}

function drawVisibleWaveform(
  canvas: HTMLCanvasElement,
  props: { peaks: readonly number[]; scrollLeft: number; viewportWidth: number; contentWidth: number }
): void {
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D 不可用');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#63d8c1';
  context.lineWidth = Math.max(1, scale);
  const center = canvas.height / 2;
  const visibleStart = props.scrollLeft / Math.max(1, props.contentWidth);
  const visibleEnd = (props.scrollLeft + props.viewportWidth) / Math.max(1, props.contentWidth);
  const startIndex = Math.min(props.peaks.length, Math.max(0, Math.floor(visibleStart * props.peaks.length)));
  const endIndex = Math.min(props.peaks.length, Math.ceil(visibleEnd * props.peaks.length));
  const sortedLevels = [...props.peaks].sort((left, right) => left - right);
  const normalizationLevel = Math.max(0.001, sortedLevels[Math.floor(sortedLevels.length * 0.96)] ?? 1);
  context.beginPath();
  for (let index = startIndex; index < endIndex; index += 1) {
    const contentX = index / props.peaks.length * props.contentWidth;
    const x = (contentX - props.scrollLeft) / Math.max(1, props.viewportWidth) * canvas.width;
    const normalizedPeak = Math.min(1, (props.peaks[index] ?? 0) / normalizationLevel);
    const height = normalizedPeak * center * 0.88;
    context.moveTo(x, center - height);
    context.lineTo(x, center + height);
  }
  context.stroke();
}

function drawClippedWaveform(canvas: HTMLCanvasElement, props: {
  peaks: readonly number[];
  sourceDurationMs: number;
  sourceOffsetMs: number;
  clipDurationMs: number;
}): void {
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D 不可用');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#8be7d4';
  context.lineWidth = Math.max(1, scale);
  const startIndex = Math.max(0, Math.floor(props.sourceOffsetMs / props.sourceDurationMs * props.peaks.length));
  const endIndex = Math.min(props.peaks.length, Math.ceil((props.sourceOffsetMs + props.clipDurationMs) / props.sourceDurationMs * props.peaks.length));
  const visiblePeaks = props.peaks.slice(startIndex, Math.max(startIndex + 1, endIndex));
  const sortedLevels = [...visiblePeaks].sort((left, right) => left - right);
  const normalizationLevel = Math.max(0.001, sortedLevels[Math.floor(sortedLevels.length * 0.96)] ?? 1);
  const center = canvas.height / 2;
  context.beginPath();
  for (let index = 0; index < visiblePeaks.length; index += 1) {
    const x = index / Math.max(1, visiblePeaks.length - 1) * canvas.width;
    const height = Math.min(1, (visiblePeaks[index] ?? 0) / normalizationLevel) * center * 0.82;
    context.moveTo(x, center - height);
    context.lineTo(x, center + height);
  }
  context.stroke();
}
