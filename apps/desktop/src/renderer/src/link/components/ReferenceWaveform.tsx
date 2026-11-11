import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { TimelineSpan } from '@tb/core/link';
import type { LinkMediaAsset, LinkWaveform, LinkWaveformResult, ReferenceMediaClip, RundownItem } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { TimelineDrag } from './TimelineItems';
import { timelineSpanWidth } from './timeline-geometry';
import { drawWaveformCanvas, type WaveformDisplay } from '../view-models/waveform-draw';
import { WaveformCache } from '../runtime/waveform-cache';
import { runWhenNotPlaying } from '../runtime/when-not-playing';

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
  const waveform = useSongWaveform(projectPath && url ? { projectPath, url, sha256: asset.sha256, durationMs } : null);
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
    {waveform.waveform ? <WaveformCanvas
      waveform={waveform.waveform} display="waveform" fill={0.82} normalize color="#8be7d4" maximumWidth={4096}
      startSample={(props.clip.sourceOffsetMs ?? 0) * waveform.waveform.sampleRate / 1000}
      endSample={((props.clip.sourceOffsetMs ?? 0) + clipDurationMs) * waveform.waveform.sampleRate / 1000}
    /> : null}
    <span className="timeline-media-audio-label">{error ? (error === '素材不包含音频轨道' ? '无音轨' : '音轨读取失败') : `${asset.name} · 内嵌音频`}</span>
    <i className="timeline-trim-handle end" title="拖动同步修剪音频与画面" onPointerDown={(event) => props.onTrimBegin(event, props.clip, 'end', asset.durationMs)} onPointerMove={props.onTrimMove} onPointerUp={props.onTrimEnd} onPointerCancel={props.onTrimCancel} />
  </button>;
}
