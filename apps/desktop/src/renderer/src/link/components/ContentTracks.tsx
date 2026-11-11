import { useMemo, type DragEvent, type HTMLAttributes, type MouseEvent, type PointerEvent } from 'react';
import { contentPlaceTaken, contentTrimBounds, millisecondsToFrameNumber, resolveTimelineClipSpan, timecodeToMilliseconds, type ContentRef, type ResolvedTimelineState } from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, LinkProject, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE, type ObsResource } from './ResourceLibrary';
import { parseObsResource } from './resource-library-model';
import { TimelineClip, TimelineCue, timelineCueSpan, type TimelineDrag, type TimelineItemPreview } from './TimelineItems';
import { TimelineNewLayerDrop } from './TimelineNewLayerDrop';
import type { TimelineTarget } from './TimelineContextMenu';
import { markedOnAir, offAirParts, type Airtime } from './timeline-air';
import { timelineInteractionTime, timelineMoveSnapPoints } from './timeline-geometry';
import { timelineItemDuration, timelineSnapGuide, timelineSnapPoints } from './timeline-snap-points';
import { useContentTrim, type ContentTrimDrag, type TrimBounds } from './useContentTrim';
import { useTimelineItemDrag } from './useTimelineItemDrag';
import type { TimelineViewport } from './useTimelineViewport';
import { usePlayheadValue, type EditorPlayhead } from './editor-playhead';

const TRACK_HEIGHT = 50;
/** Items this far outside the visible area stay drawn, so a fast scroll never shows a gap. */
const CULL_MARGIN = 112;

/** The timeline rules the tracks ask while a part is dragged or trimmed, so
 * what the drag shows is what the edit does. */
export type ContentEditRules = {
  trimBounds: (ref: ContentRef) => TrimBounds;
  /** Whether a part moved to `startMs` on `layerId` lands on another part there
   * and so goes on a new track above it. */
  placeTaken: (ref: ContentRef, startMs: number, layerId: string) => boolean;
};

export function contentEditRules(project: LinkProject, itemId: string): ContentEditRules {
  return {
    trimBounds: (ref) => contentTrimBounds(project, itemId, ref),
    placeTaken: (ref, startMs, layerId) => contentPlaceTaken(project, itemId, ref, startMs, layerId)
  };
}

export type ContentTracksProps = {
  layers: VisualLayer[];
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  assets: ReadonlyMap<string, LinkMediaAsset>;
  frameRate: MtcFrameRate;
  durationMs: number;
  /** Read when snapping; the on-air marks follow it, drawn again only when they change (0.5.9 E2). */
  playhead: EditorPlayhead;
  timelineState: ResolvedTimelineState;
  /** The parts covered by upper cameras in this timeline, dimmed. */
  airtime: Airtime;
  /** What OBS plays by, for the on-air marks (view-models/picture-on-air): while the song plays, the airtime of
   * the version it started with; null when that version cannot be confirmed, so nothing is marked on air. */
  onAirtime: Airtime | null;
  /** Parts (`media:` / `cue:` keys) changed while the song plays: marked, never shown on air. */
  pending: ReadonlySet<string>;
  selectedClipId: string | null;
  selectedCueId: string | null;
  /** Points the song audio adds to snapping (its cut points). */
  audioSnapPoints: readonly number[];
  rules: ContentEditRules;
  viewport: Pick<TimelineViewport, 'pixelsPerSecond' | 'scrollLeft' | 'scrollTop' | 'viewportWidth' | 'viewportHeight' | 'timeAtClientX' | 'editTimeAtClientX'>;
  /** Where the first track starts and where the lighting row sits between tracks. */
  tracks: { start: number; lightingIndex: number; lightingHeight: number };
  snap: { enabled: boolean; thresholdMs: number };
  lanePointer: Pick<HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
  focusTimeline: () => void;
  onOpenMenu: (target: TimelineTarget, x: number, y: number) => void;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onMoveClip: (clipId: string, startMs: number, layerId?: string | null) => void;
  onMoveCue: (cueId: string, startMs: number, layerId?: string | null) => void;
  onTrim: (ref: ContentRef, startMs: number, durationMs: number) => void;
  onDropAsset: (assetId: string, startMs: number, layerId?: string | null) => void;
  onDropObsResource: (resource: ObsResource, startMs: number, layerId?: string | null) => void;
};

/** The editor's clip and camera tracks: placing, moving and trimming, and which
 * parts the output shows. The lighting workbench has none of this. */
export function ContentTracks(props: ContentTracksProps): JSX.Element {
  const { viewport, snap } = props;
  const select = (ref: ContentRef): void => { if (ref.kind === 'clip') props.onSelectClip(ref.id); else props.onSelectCue(ref.id); };
  const snapPoints = (target?: ContentRef): number[] => timelineSnapPoints(props.timelineState, props.cues, props.frameRate, props.playhead.read(), target);
  const itemDrag = useTimelineItemDrag({
    clips: props.clips, cues: props.cues, layers: props.layers,
    focusTimeline: props.focusTimeline, timeAtClientX: viewport.editTimeAtClientX,
    snapTime: (milliseconds, target) => timelineInteractionTime(milliseconds, Math.max(props.durationMs, milliseconds), props.frameRate, snap.enabled,
      timelineMoveSnapPoints([0, props.durationMs, ...snapPoints(target), ...props.audioSnapPoints], timelineItemDuration(props, target)), snap.thresholdMs),
    onSelectClip: props.onSelectClip, onSelectCue: props.onSelectCue, onMoveClip: props.onMoveClip, onMoveCue: props.onMoveCue
  });
  const trim = useContentTrim({ frameRate: props.frameRate, timeAtClientX: viewport.editTimeAtClientX, focusTimeline: props.focusTimeline,
    snapEnabled: snap.enabled, snapThresholdMs: snap.thresholdMs, snapPoints, bounds: props.rules.trimBounds, onSelect: select, onTrim: props.onTrim });
  const snapGuide = timelineSnapGuide({ ...props, playheadMs: props.playhead.read() }, snap.enabled, itemDrag.drag);
  // Worked out every frame, but the tracks draw again only when what is on air changes, such as at a camera switch.
  const onAirKey = usePlayheadValue(props.playhead, positionMs => [...markedOnAir(props.onAirtime, props.pending,
    millisecondsToFrameNumber(positionMs, props.frameRate), props.timelineState.activeObsCueIds)].sort().join('\n'));
  const onAir = useMemo(() => new Set(onAirKey ? onAirKey.split('\n') : []), [onAirKey]);
  const drop = (event: DragEvent<HTMLElement>, layer?: VisualLayer): void => {
    event.preventDefault();
    event.stopPropagation();
    const startMs = timelineInteractionTime(viewport.timeAtClientX(event.clientX), props.durationMs, props.frameRate, snap.enabled, snapPoints(), snap.thresholdMs);
    const assetId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (assetId) { props.onDropAsset(assetId, startMs, layer?.id ?? null); return; }
    const value = event.dataTransfer.getData(OBS_DRAG_TYPE);
    if (value) props.onDropObsResource(parseObsResource(value), startMs, layer?.id ?? null);
  };
  const openMenu = (event: MouseEvent<HTMLButtonElement>, target: TimelineTarget): void => {
    event.preventDefault();
    select(target);
    props.onOpenMenu(target, event.clientX, event.clientY);
  };
  const handlers = (ref: ContentRef, span: { startMs: number; durationMs: number } | undefined) => ({
    drag: { onPointerDown: (event: PointerEvent<HTMLButtonElement>, originMs: number) => itemDrag.begin(event, ref.kind, ref.id, originMs),
      onPointerMove: itemDrag.move, onPointerUp: itemDrag.end, onPointerCancel: itemDrag.cancel },
    trim: { onPointerDown: (event: PointerEvent<HTMLElement>, edge: 'start' | 'end') => { if (span) trim.begin(event, ref, span, edge); },
      onPointerMove: trim.move, onPointerUp: trim.end, onPointerCancel: trim.cancel }
  });
  const inView = (left: number, width: number): boolean => left + width >= viewport.scrollLeft - CULL_MARGIN && left <= viewport.scrollLeft + viewport.viewportWidth + CULL_MARGIN;

  return <>
    {snapGuide !== undefined ? <div className="timeline-snap-guide" style={{ left: snapGuide / 1000 * viewport.pixelsPerSecond }}><span>已吸附</span></div> : null}
    {props.layers.map((layer, index) => {
      const rowTop = props.tracks.start + index * TRACK_HEIGHT + (index >= props.tracks.lightingIndex ? props.tracks.lightingHeight : 0);
      const rowInView = rowTop + TRACK_HEIGHT >= viewport.scrollTop - TRACK_HEIGHT && rowTop <= viewport.scrollTop + viewport.viewportHeight + TRACK_HEIGHT;
      const moving = itemDrag.drag?.moved === true ? itemDrag.drag : null;
      const dropTarget = moving?.targetLayerId === layer.id;
      // Dropped here the part would overlap another, so it goes on a new track above this one.
      const dropAbove = moving !== null && dropTarget && !layer.locked && props.rules.placeTaken({ kind: moving.kind, id: moving.id }, moving.previewMs, layer.id);
      // The row and drop target stay in the grid. Only offscreen contents are
      // left out; a held drag or trim and the selection stay drawn.
      const held = (ref: ContentRef): boolean => (ref.kind === 'clip' ? props.selectedClipId : props.selectedCueId) === ref.id
        || itemDrag.drag?.kind === ref.kind && itemDrag.drag.id === ref.id || trim.drag?.ref.kind === ref.kind && trim.drag.ref.id === ref.id;
      return <div key={layer.id} style={{ order: 100 + index * 100 }}
        className={`timeline-lane cue-lane all-lane ${layer.locked ? 'is-locked' : ''} ${layer.visible ? '' : 'is-hidden'} ${dropTarget ? 'is-drop-target' : ''} ${dropAbove ? 'is-drop-above' : ''} ${moving?.originLayerId === layer.id ? 'has-item-drag' : ''}`}
        data-visual-layer-id={layer.id} data-layer-locked={String(layer.locked)} {...props.lanePointer}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, layer)}>
        <span className={`visual-layer-drop-state ${layer.locked ? 'is-locked' : ''}`}>
          {dropAbove ? <em style={{ left: (moving.previewMs + timelineItemDuration(props, moving)) / 1000 * viewport.pixelsPerSecond + 8 }}>这里有内容，松开放到上方新轨道</em> : null}
        </span>
        {props.clips.filter((clip) => clip.layerId === layer.id).map((clip) => {
          const ref = { kind: 'clip', id: clip.id } as const;
          const span = resolveTimelineClipSpan(clip, props.frameRate);
          const preview = itemPreview(ref, itemDrag.drag, trim.drag);
          const pending = props.pending.has(`media:${clip.id}`);
          if (!held(ref) && !(rowInView && inView((preview.startMs ?? span.startMs) / 1000 * viewport.pixelsPerSecond, span.durationMs / 1000 * viewport.pixelsPerSecond))) return null;
          return <TimelineClip key={clip.id} clip={clip} asset={props.assets.get(clip.assetId)} span={span} frameRate={props.frameRate}
            pixelsPerSecond={viewport.pixelsPerSecond} selected={props.selectedClipId === clip.id} active={onAir.has(`media:${clip.id}`)} pending={pending} locked={layer.locked}
            offAir={offAirParts(span, props.airtime.get(`media:${clip.id}`))} preview={preview} {...handlers(ref, span)}
            onSelect={() => props.onSelectClip(clip.id)} onContextMenu={(event) => openMenu(event, ref)} />;
        })}
        {props.cues.filter((cue) => cue.layerId === layer.id).map((cue) => {
          const ref = { kind: 'cue', id: cue.id } as const;
          const span = timelineCueSpan(cue, props.frameRate);
          const preview = itemPreview(ref, itemDrag.drag, trim.drag);
          const startMs = preview.startMs ?? span?.startMs ?? timecodeToMilliseconds(cue.timecode, props.frameRate);
          const pending = props.pending.has(`cue:${cue.id}`);
          if (!held(ref) && !(rowInView && inView(startMs / 1000 * viewport.pixelsPerSecond, (span?.durationMs ?? 0) / 1000 * viewport.pixelsPerSecond))) return null;
          return <TimelineCue key={cue.id} cue={cue} span={span} frameRate={props.frameRate} pixelsPerSecond={viewport.pixelsPerSecond}
            selected={props.selectedCueId === cue.id} active={onAir.has(`cue:${cue.id}`)} pending={pending} locked={layer.locked}
            offAir={span ? offAirParts(span, props.airtime.get(`cue:${cue.id}`)) : []} preview={preview}
            dragging={itemDrag.drag?.kind === 'cue' && itemDrag.drag.id === cue.id && itemDrag.drag.moved} {...handlers(ref, span)}
            onSelect={() => props.onSelectCue(cue.id)} onContextMenu={(event) => openMenu(event, ref)} />;
        })}
      </div>;
    })}
    <TimelineNewLayerDrop active={itemDrag.drag?.targetLayerId === null} onDrop={(event) => drop(event)} />
  </>;
}

/** The place and length an item shows while it is moved or trimmed. */
function itemPreview(ref: ContentRef, drag: TimelineDrag | null, trim: ContentTrimDrag | null): TimelineItemPreview {
  if (trim?.ref.kind === ref.kind && trim.ref.id === ref.id) return { startMs: trim.previewStartMs, durationMs: trim.previewDurationMs, offsetY: null };
  if (drag?.kind === ref.kind && drag.id === ref.id) return { startMs: drag.previewMs, durationMs: null, offsetY: drag.moved ? drag.previewOffsetY : null };
  return { startMs: null, durationMs: null, offsetY: null };
}
