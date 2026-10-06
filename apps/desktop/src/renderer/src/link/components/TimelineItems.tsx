import { displayedSceneDuration } from './timeline-snap-points';
import type { DragEvent, HTMLAttributes, MouseEvent, PointerEvent, ReactNode } from 'react';
import { resolveTimelineCueSpan, timecodeToMilliseconds, type TimelineSpan } from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip } from '@tb/schema';
import { formatTimelineTimecode, timelineSpanWidth } from './timeline-geometry';

export type TimelineDrag = {
  kind: 'clip' | 'cue';
  id: string;
  pointerId: number;
  originMs: number;
  previewMs: number;
  grabOffsetMs: number;
  startClientX: number;
  startClientY: number;
  previewOffsetY: number;
  originLayerId: string | undefined;
  targetLayerId: string | null | undefined;
  layerMovable: boolean;
  moved: boolean;
};

export function TimelineClip(props: {
  clip: ReferenceMediaClip;
  asset: LinkMediaAsset | undefined;
  resolvedStartMs: number;
  resolvedDurationMs: number;
  frameRate: MtcFrameRate;
  pixelsPerSecond: number;
  selected: boolean;
  active: boolean;
  locked: boolean;
  previewMs: number | null;
  previewDurationMs: number | null;
  previewOffsetY: number | null;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, kind: 'clip', id: string, originMs: number) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onTrimPointerDown: (event: PointerEvent<HTMLElement>, clip: ReferenceMediaClip, edge: 'start' | 'end', sourceDurationMs?: number) => void;
  onTrimPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onTrimPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onTrimPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>, clip: ReferenceMediaClip) => void;
}): JSX.Element {
  const originMs = props.resolvedStartMs;
  const startMs = props.previewMs ?? originMs;
  return <button
    aria-pressed={props.selected}
    onClick={props.onSelect}
    className={`timeline-clip ${props.selected ? 'is-selected' : ''} ${props.active ? 'is-active' : ''} ${props.locked ? 'is-locked' : ''} ${props.asset?.kind ?? 'missing'} ${props.previewMs !== null ? 'is-dragging' : ''}`}
    style={{
      left: startMs / 1_000 * props.pixelsPerSecond,
      width: timelineSpanWidth(props.previewDurationMs ?? props.resolvedDurationMs, props.pixelsPerSecond),
      translate: props.previewOffsetY === null ? undefined : `0 ${props.previewOffsetY}px`
    }}
    title={`${props.clip.label} · 左右拖动时间，上下拖动图层层级 · ${formatTimelineTimecode(startMs, props.frameRate)}`}
    onPointerDown={(event) => {
      if (!props.locked) props.onPointerDown(event, 'clip', props.clip.id, originMs);
      else { event.stopPropagation(); props.onSelect(); }
    }}
    onPointerMove={props.onPointerMove}
    onPointerUp={props.onPointerUp}
    onPointerCancel={props.onPointerCancel}
    onContextMenu={(event) => props.onContextMenu(event, props.clip)}
  ><i className="timeline-trim-handle start" title={props.locked ? '图层已锁定' : '拖动修剪片段入点'} onPointerDown={(event) => { if (props.locked) event.stopPropagation(); else props.onTrimPointerDown(event, props.clip, 'start', props.asset?.durationMs); }} onPointerMove={props.onTrimPointerMove} onPointerUp={props.onTrimPointerUp} onPointerCancel={props.onTrimPointerCancel} /><span>{props.clip.label}</span><small>{props.asset?.kind ?? '缺失'} · {formatTimelineTimecode(startMs, props.frameRate)}</small><i className="timeline-trim-handle end" title={props.locked ? '图层已锁定' : '拖动修剪片段出点'} onPointerDown={(event) => { if (props.locked) event.stopPropagation(); else props.onTrimPointerDown(event, props.clip, 'end', props.asset?.durationMs); }} onPointerMove={props.onTrimPointerMove} onPointerUp={props.onTrimPointerUp} onPointerCancel={props.onTrimPointerCancel} /></button>;
}

export function CueLane(props: {
  viewport: { left: number; width: number };
  order?: number;
  cues: LinkCue[];
  frameRate: MtcFrameRate;
  selectedCueId: string | null;
  device: 'all' | 'obs' | 'midi' | 'lighting';
  pixelsPerSecond: number;
  drag: TimelineDrag | null;
  lanePointer: Pick<HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  onBeginDrag: (event: PointerEvent<HTMLButtonElement>, kind: 'cue', id: string, originMs: number) => void;
  onMoveDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onEndDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancelDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onSelectCue?: (cueId: string) => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>, cue: LinkCue) => void;
  children?: ReactNode;
  layerId?: string;
  locked?: boolean;
  visible?: boolean;
  dropTarget?: boolean;
  draggingItem?: boolean;
  visualClipMode?: boolean;
  activeCueIds?: ReadonlySet<string>;
  visualCueSpans?: ReadonlyMap<string, TimelineSpan>;
  resizeDrag?: { id: string; previewStartMs: number; previewDurationMs: number } | null;
  onTrimPointerDown?: (event: PointerEvent<HTMLElement>, cue: LinkCue, durationMs: number, edge: 'start' | 'end') => void;
  onTrimPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  onTrimPointerUp?: (event: PointerEvent<HTMLElement>) => void;
  onTrimPointerCancel?: (event: PointerEvent<HTMLElement>) => void;
}): JSX.Element {
  const collisionCounts = new Map<string, number>();
  return <div className={`timeline-lane cue-lane ${props.device}-lane ${props.locked ? 'is-locked' : ''} ${props.visible === false ? 'is-hidden' : ''} ${props.dropTarget ? 'is-drop-target' : ''} ${props.draggingItem ? 'has-item-drag' : ''}`} style={{ order: props.order }} data-visual-layer-id={props.layerId} data-layer-locked={props.locked === undefined ? undefined : String(props.locked)} {...props.lanePointer} onDragOver={props.onDrop ? (event) => event.preventDefault() : undefined} onDrop={props.onDrop}>{props.children}{props.cues.flatMap((cue) => {
    const actionCount = cue.actions.filter((action) => actionMatchesDevice(action, props.device)).length;
    const emptyCue = cue.actions.length === 0;
    if (actionCount === 0 && !(props.device === 'all' && emptyCue) && !(props.device === 'obs' && emptyCue)) return [];
    const sceneName = cue.actions.find((action) => action.kind === 'obs.setProgramScene')?.sceneName;
    const visualSpan = props.visualCueSpans?.get(cue.id) ?? (cue.durationMs !== undefined && cue.actions.some((action) => action.kind === 'obs.setProgramScene') ? resolveTimelineCueSpan(cue, props.frameRate) : undefined);
    const originMs = visualSpan?.startMs ?? timecodeToMilliseconds(cue.timecode, props.frameRate);
    const visualShow = props.visualClipMode && (visualSpan !== undefined || sceneName !== undefined);
    // An untimed scene keeps its existing 112px display width until the user drags an edge.
    const visualDurationMs = visualSpan?.durationMs ?? (visualShow ? displayedSceneDuration(cue, props.pixelsPerSecond) : 0);
    const resizing = props.resizeDrag?.id === cue.id ? props.resizeDrag : null;
    const startMs = resizing?.previewStartMs
      ?? (props.drag?.kind === 'cue' && props.drag.id === cue.id ? props.drag.previewMs : originMs);
    const renderedDurationMs = resizing?.previewDurationMs ?? visualDurationMs;
    const itemDrag = props.drag?.kind === 'cue' && props.drag.id === cue.id ? props.drag : null;
    const collisionKey = String(startMs);
    const collisionIndex = collisionCounts.get(collisionKey) ?? 0;
    collisionCounts.set(collisionKey, collisionIndex + 1);
    const left = startMs / 1000 * props.pixelsPerSecond + (visualShow ? 0 : collisionIndex * 10);
    const width = visualShow ? timelineSpanWidth(renderedDurationMs, props.pixelsPerSecond) : 112;
    if (!itemDrag && !resizing && props.selectedCueId !== cue.id && (left + width < props.viewport.left - 112 || left > props.viewport.left + props.viewport.width + 112)) return [];
    const cueKind = cueActionKind(cue);
    return [<button aria-pressed={props.selectedCueId === cue.id} onClick={() => props.onSelectCue?.(cue.id)} onContextMenu={(event) => props.onContextMenu?.(event, cue)} className={`timeline-cue cue-kind-${cueKind} ${visualShow ? 'visual-obs-clip' : ''} ${props.selectedCueId === cue.id ? 'is-selected' : ''} ${props.activeCueIds?.has(cue.id) ? 'is-active' : ''} ${props.locked ? 'is-locked' : ''} ${itemDrag?.moved ? 'is-dragging' : ''}`} key={`${props.device}:${cue.id}`} style={{ left: startMs / 1_000 * props.pixelsPerSecond + (visualShow ? 0 : collisionIndex * 10), top: 2, translate: itemDrag?.moved ? `0 ${itemDrag.previewOffsetY}px` : undefined, ...(visualShow ? { width: timelineSpanWidth(renderedDurationMs, props.pixelsPerSecond) } : {}) }} title={props.locked ? '图层已锁定' : `${emptyCue ? `${cue.name} · 待配置动作` : `${cue.name} · ${actionCount} 个动作`} · ${formatTimelineTimecode(startMs, props.frameRate)} · 左右拖动时间，上下拖动图层层级`} onPointerDown={(event) => { if (!props.locked) props.onBeginDrag(event, 'cue', cue.id, originMs); else { event.stopPropagation(); props.onSelectCue?.(cue.id); } }} onPointerMove={props.onMoveDrag} onPointerUp={props.onEndDrag} onPointerCancel={props.onCancelDrag}>
      {visualShow && props.onTrimPointerDown && !props.locked ? <i className="timeline-trim-handle start" title="拖动修改开始时间" onPointerDown={(event) => props.onTrimPointerDown?.(event, cue, visualDurationMs, 'start')} onPointerMove={props.onTrimPointerMove} onPointerUp={props.onTrimPointerUp} onPointerCancel={props.onTrimPointerCancel} /> : null}
      <span>{sceneName ?? cue.name}</span>{sceneName === undefined ? <small>{visualShow ? `时长 ${formatDuration(renderedDurationMs)}` : `${actionCount} · ${formatTimelineTimecode(startMs, props.frameRate)}`}</small> : null}
      {visualShow && props.onTrimPointerDown && !props.locked ? <i className="timeline-trim-handle end" title="拖动修改结束时间" onPointerDown={(event) => props.onTrimPointerDown?.(event, cue, visualDurationMs, 'end')} onPointerMove={props.onTrimPointerMove} onPointerUp={props.onTrimPointerUp} onPointerCancel={props.onTrimPointerCancel} /> : null}
    </button>];
  })}</div>;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(2)}s`;
}

function actionMatchesDevice(action: LinkCue['actions'][number], device: 'all' | 'obs' | 'midi' | 'lighting'): boolean {
  if (device === 'all') return true;
  if (device === 'obs') return action.kind.startsWith('obs.');
  if (!('portProfileId' in action)) return false;
  const isLighting = action.portProfileId === 'lighting-output';
  return device === 'lighting' ? isLighting : !isLighting;
}

function cueActionKind(cue: LinkCue): 'empty' | 'obs' | 'midi' | 'lighting' | 'mixed' {
  if (cue.actions.length === 0) return 'empty';
  const kinds = new Set(cue.actions.map((action) => {
    if (action.kind.startsWith('obs.')) return 'obs' as const;
    return 'portProfileId' in action && action.portProfileId === 'lighting-output' ? 'lighting' as const : 'midi' as const;
  }));
  return kinds.size === 1 ? [...kinds][0]! : 'mixed';
}
