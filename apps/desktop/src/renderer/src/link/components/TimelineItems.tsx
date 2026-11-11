import { memo } from 'react';
import { cueTakesTime, resolveTimelineClipSpan, resolveTimelineCueSpan, timecodeToMilliseconds, type FrameRange, type TimelineSpan } from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip } from '@tb/schema';
import { formatTimelineTimecode, timelineSpanWidth } from './timeline-geometry';
import { offAirParts, offAirTitle, type OffAirPart } from './timeline-air';
import './timeline-pending.css';

/** On a part changed while its song plays: OBS does not have it yet (view-models/pending-picture-edits). */
const PENDING_TEXT = '停下重播才生效';
const PENDING_TITLE = '播放中改过，OBS 还在按开始播放时的时间线播，停下重播才生效';

export type { TimelineDrag } from './useTimelineItemDrag';

/** What a part is doing: pressed to move (`press`, not moved yet), moved (`drag`) or trimmed. A held part follows
 * the pointer in the DOM (drag-preview.ts) and is not drawn covered then; the covered parts belong to the old place. */
export type TimelineItemHeld = 'press' | 'drag' | 'trim' | null;

/**
 * A part's props are values that only change when the part does, so a drag or the playhead moving does not draw
 * every part again (0.5.9 E3). Its pointer, click and menu events are the track's (ContentTracks), found by
 * `data-kind` and `data-id`; a trim handle says its edge in `data-edge`.
 */
type ItemProps = {
  frameRate: MtcFrameRate;
  pixelsPerSecond: number;
  selected: boolean;
  active: boolean;
  /** Changed while the song plays: drawn where it will be, marked until the song is stopped and played again. */
  pending: boolean;
  locked: boolean;
  /** The frames it is on air (timeline-air), for the covered parts. */
  onAir: readonly FrameRange[] | undefined;
  held: TimelineItemHeld;
};

/** A clip's small line: its kind and start. */
export function clipLabel(asset: LinkMediaAsset | undefined, startMs: number, frameRate: MtcFrameRate): string {
  return `${asset?.kind ?? '缺失'} · ${formatTimelineTimecode(startMs, frameRate)}`;
}

export const TimelineClip = memo(function TimelineClip(props: ItemProps & { clip: ReferenceMediaClip; asset: LinkMediaAsset | undefined }): JSX.Element {
  const span = resolveTimelineClipSpan(props.clip, props.frameRate);
  const startMs = span.startMs;
  const settled = props.held === null;
  const offAir = settled ? offAirParts(span, props.onAir) : [];
  return <button
    aria-pressed={props.selected}
    data-kind="clip" data-id={props.clip.id}
    className={`timeline-clip ${props.selected ? 'is-selected' : ''} ${props.active ? 'is-active' : ''} ${props.pending ? 'is-pending' : ''} ${props.locked ? 'is-locked' : ''} ${props.asset?.kind ?? 'missing'} ${props.held !== null ? 'is-dragging' : ''}`}
    data-off-air={offAirState(offAir)}
    style={{
      left: startMs / 1_000 * props.pixelsPerSecond,
      width: timelineSpanWidth(span.durationMs, props.pixelsPerSecond)
    }}
    title={[props.clip.label, props.pending ? PENDING_TITLE : null, '左右拖动时间，上下拖动图层层级', formatTimelineTimecode(startMs, props.frameRate), offAirTitle(offAir)].filter(Boolean).join(' · ')}
  >
    <OffAirParts parts={offAir} />
    <TrimHandle edge="start" title={props.locked ? '图层已锁定' : '拖动修剪片段入点'} />
    <span>{props.clip.label}</span>{props.pending && settled ? <small className="timeline-pending-label">{PENDING_TEXT}</small> : <small>{clipLabel(props.asset, startMs, props.frameRate)}</small>}
    <TrimHandle edge="end" title={props.locked ? '图层已锁定' : '拖动修剪片段出点'} />
  </button>;
});

/** The span a cue takes on its track: a camera, or a shown source in older
 * projects. Every other cue is an instant and has none. */
export function timelineCueSpan(cue: LinkCue, frameRate: MtcFrameRate): TimelineSpan | undefined {
  return cueTakesTime(cue) && cue.durationMs !== undefined ? resolveTimelineCueSpan(cue, frameRate) : undefined;
}

/** A cue's small line at this place and length: a camera's length, an instant's actions and time; none for a scene. */
export function cueLabel(cue: LinkCue, timed: boolean, startMs: number, durationMs: number, frameRate: MtcFrameRate): string | null {
  if (cue.actions.some((action) => action.kind === 'obs.setProgramScene')) return null;
  return timed ? `时长 ${(durationMs / 1_000).toFixed(2)}s` : `${cue.actions.length} · ${formatTimelineTimecode(startMs, frameRate)}`;
}

export const TimelineCue = memo(function TimelineCue(props: ItemProps & { cue: LinkCue }): JSX.Element {
  const { cue } = props;
  const span = timelineCueSpan(cue, props.frameRate);
  const sceneName = cue.actions.find((action) => action.kind === 'obs.setProgramScene')?.sceneName;
  const startMs = span?.startMs ?? timecodeToMilliseconds(cue.timecode, props.frameRate);
  const durationMs = span?.durationMs ?? 0;
  const settled = props.held === null;
  const offAir = settled && span ? offAirParts(span, props.onAir) : [];
  const summary = cue.actions.length === 0 ? `${cue.name} · 待配置动作` : `${cue.name} · ${cue.actions.length} 个动作`;
  const trimmable = span !== undefined && !props.locked;
  const label = cueLabel(cue, span !== undefined, startMs, durationMs, props.frameRate);
  return <button aria-pressed={props.selected} data-kind="cue" data-id={cue.id}
    className={`timeline-cue cue-kind-${cueActionKind(cue)} ${span ? 'visual-obs-clip' : ''} ${props.selected ? 'is-selected' : ''} ${props.active ? 'is-active' : ''} ${props.pending ? 'is-pending' : ''} ${props.locked ? 'is-locked' : ''} ${props.held === 'drag' ? 'is-dragging' : ''}`}
    data-off-air={offAirState(offAir)}
    style={{ left: startMs / 1000 * props.pixelsPerSecond, top: 2, ...(span ? { width: timelineSpanWidth(durationMs, props.pixelsPerSecond) } : {}) }}
    title={[props.locked ? '图层已锁定' : summary, props.pending ? PENDING_TITLE : null, ...(props.locked ? [] : [formatTimelineTimecode(startMs, props.frameRate), '左右拖动时间，上下拖动图层层级', offAirTitle(offAir)])].filter(Boolean).join(' · ')}>
    <OffAirParts parts={offAir} />
    {trimmable ? <TrimHandle edge="start" title="拖动修改开始时间" /> : null}
    <span>{sceneName ?? cue.name}</span>{props.pending && settled ? <small className="timeline-pending-label">{PENDING_TEXT}</small> : label !== null ? <small>{label}</small> : null}
    {trimmable ? <TrimHandle edge="end" title="拖动修改结束时间" /> : null}
  </button>;
});

function TrimHandle({ edge, title }: { edge: 'start' | 'end'; title: string }): JSX.Element {
  return <i className={`timeline-trim-handle ${edge}`} title={title} data-edge={edge} />;
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
