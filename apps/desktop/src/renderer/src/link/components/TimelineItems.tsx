import type { MouseEvent, PointerEvent } from 'react';
import { cueTakesTime, resolveTimelineCueSpan, timecodeToMilliseconds, type TimelineSpan } from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip } from '@tb/schema';
import { formatTimelineTimecode, timelineSpanWidth } from './timeline-geometry';
import { offAirTitle, type OffAirPart } from './timeline-air';

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

type PointerHandlers<E extends HTMLElement> = {
  onPointerMove: (event: PointerEvent<E>) => void;
  onPointerUp: (event: PointerEvent<E>) => void;
  onPointerCancel: (event: PointerEvent<E>) => void;
};

/** What an item shows while it is dragged or trimmed: its preview place and
 * length. Covered parts are not drawn then; they belong to the old place. */
export type TimelineItemPreview = { startMs: number | null; durationMs: number | null; offsetY: number | null };

type ItemProps = {
  frameRate: MtcFrameRate;
  pixelsPerSecond: number;
  selected: boolean;
  active: boolean;
  locked: boolean;
  offAir: readonly OffAirPart[];
  preview: TimelineItemPreview;
  drag: PointerHandlers<HTMLButtonElement> & { onPointerDown: (event: PointerEvent<HTMLButtonElement>, originMs: number) => void };
  trim: PointerHandlers<HTMLElement> & { onPointerDown: (event: PointerEvent<HTMLElement>, edge: 'start' | 'end') => void };
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function TimelineClip(props: ItemProps & { clip: ReferenceMediaClip; asset: LinkMediaAsset | undefined; span: TimelineSpan }): JSX.Element {
  const startMs = props.preview.startMs ?? props.span.startMs;
  const offAir = props.preview.startMs === null && props.preview.durationMs === null ? props.offAir : [];
  return <button
    aria-pressed={props.selected}
    onClick={props.onSelect}
    className={`timeline-clip ${props.selected ? 'is-selected' : ''} ${props.active ? 'is-active' : ''} ${props.locked ? 'is-locked' : ''} ${props.asset?.kind ?? 'missing'} ${props.preview.startMs !== null ? 'is-dragging' : ''}`}
    data-off-air={offAirState(offAir)}
    style={{
      left: startMs / 1_000 * props.pixelsPerSecond,
      width: timelineSpanWidth(props.preview.durationMs ?? props.span.durationMs, props.pixelsPerSecond),
      translate: props.preview.offsetY === null ? undefined : `0 ${props.preview.offsetY}px`
    }}
    title={[props.clip.label, '左右拖动时间，上下拖动图层层级', formatTimelineTimecode(startMs, props.frameRate), offAirTitle(offAir)].filter(Boolean).join(' · ')}
    onPointerDown={(event) => {
      if (!props.locked) props.drag.onPointerDown(event, props.span.startMs);
      else { event.stopPropagation(); props.onSelect(); }
    }}
    onPointerMove={props.drag.onPointerMove}
    onPointerUp={props.drag.onPointerUp}
    onPointerCancel={props.drag.onPointerCancel}
    onContextMenu={props.onContextMenu}
  >
    <OffAirParts parts={offAir} />
    <TrimHandle edge="start" title={props.locked ? '图层已锁定' : '拖动修剪片段入点'} locked={props.locked} handlers={props.trim} />
    <span>{props.clip.label}</span><small>{props.asset?.kind ?? '缺失'} · {formatTimelineTimecode(startMs, props.frameRate)}</small>
    <TrimHandle edge="end" title={props.locked ? '图层已锁定' : '拖动修剪片段出点'} locked={props.locked} handlers={props.trim} />
  </button>;
}

/** The span a cue takes on its track: a camera, or a shown source in older
 * projects. Every other cue is an instant and has none. */
export function timelineCueSpan(cue: LinkCue, frameRate: MtcFrameRate): TimelineSpan | undefined {
  return cueTakesTime(cue) && cue.durationMs !== undefined ? resolveTimelineCueSpan(cue, frameRate) : undefined;
}

export function TimelineCue(props: ItemProps & { cue: LinkCue; span: TimelineSpan | undefined; dragging: boolean }): JSX.Element {
  const { cue, span } = props;
  const sceneName = cue.actions.find((action) => action.kind === 'obs.setProgramScene')?.sceneName;
  const originMs = span?.startMs ?? timecodeToMilliseconds(cue.timecode, props.frameRate);
  const startMs = props.preview.startMs ?? originMs;
  const durationMs = props.preview.durationMs ?? span?.durationMs ?? 0;
  const offAir = props.preview.startMs === null && props.preview.durationMs === null ? props.offAir : [];
  const summary = cue.actions.length === 0 ? `${cue.name} · 待配置动作` : `${cue.name} · ${cue.actions.length} 个动作`;
  const trimmable = span !== undefined && !props.locked;
  return <button aria-pressed={props.selected} onClick={props.onSelect} onContextMenu={props.onContextMenu}
    className={`timeline-cue cue-kind-${cueActionKind(cue)} ${span ? 'visual-obs-clip' : ''} ${props.selected ? 'is-selected' : ''} ${props.active ? 'is-active' : ''} ${props.locked ? 'is-locked' : ''} ${props.dragging ? 'is-dragging' : ''}`}
    data-off-air={offAirState(offAir)}
    style={{ left: startMs / 1000 * props.pixelsPerSecond, top: 2, translate: props.preview.offsetY === null ? undefined : `0 ${props.preview.offsetY}px`,
      ...(span ? { width: timelineSpanWidth(durationMs, props.pixelsPerSecond) } : {}) }}
    title={props.locked ? '图层已锁定' : [summary, formatTimelineTimecode(startMs, props.frameRate), '左右拖动时间，上下拖动图层层级', offAirTitle(offAir)].filter(Boolean).join(' · ')}
    onPointerDown={(event) => { if (!props.locked) props.drag.onPointerDown(event, originMs); else { event.stopPropagation(); props.onSelect(); } }}
    onPointerMove={props.drag.onPointerMove} onPointerUp={props.drag.onPointerUp} onPointerCancel={props.drag.onPointerCancel}>
    <OffAirParts parts={offAir} />
    {trimmable ? <TrimHandle edge="start" title="拖动修改开始时间" locked={false} handlers={props.trim} /> : null}
    <span>{sceneName ?? cue.name}</span>{sceneName === undefined ? <small>{span ? `时长 ${(durationMs / 1_000).toFixed(2)}s` : `${cue.actions.length} · ${formatTimelineTimecode(startMs, props.frameRate)}`}</small> : null}
    {trimmable ? <TrimHandle edge="end" title="拖动修改结束时间" locked={false} handlers={props.trim} /> : null}
  </button>;
}

function TrimHandle({ edge, title, locked, handlers }: { edge: 'start' | 'end'; title: string; locked: boolean; handlers: ItemProps['trim'] }): JSX.Element {
  return <i className={`timeline-trim-handle ${edge}`} title={title}
    onPointerDown={(event) => { if (locked) event.stopPropagation(); else handlers.onPointerDown(event, edge); }}
    onPointerMove={handlers.onPointerMove} onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel} />;
}

function OffAirParts({ parts }: { parts: readonly OffAirPart[] }): JSX.Element | null {
  return parts.length ? <>{parts.map((part) => <i key={part.from} className="timeline-off-air" aria-hidden
    style={{ left: `${part.from * 100}%`, width: `${(part.to - part.from) * 100}%` }} />)}</> : null;
}

function offAirState(parts: readonly OffAirPart[]): 'all' | 'part' | undefined {
  if (!parts.length) return undefined;
  return parts.length === 1 && parts[0]!.from === 0 && parts[0]!.to === 1 ? 'all' : 'part';
}

function cueActionKind(cue: LinkCue): 'empty' | 'obs' | 'midi' | 'lighting' | 'mixed' {
  if (cue.actions.length === 0) return 'empty';
  const kinds = new Set(cue.actions.map((action) => {
    if (action.kind.startsWith('obs.')) return 'obs' as const;
    return 'portProfileId' in action && action.portProfileId === 'lighting-output' ? 'lighting' as const : 'midi' as const;
  }));
  return kinds.size === 1 ? [...kinds][0]! : 'mixed';
}
