import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeftToLine, ArrowRightToLine } from 'lucide-react';
import { audioTracks, audioTracksEndMs, paddingDragFrame, paddingStopText, songDurationMs, songLeadBlankMs, type PaddingDrag, type PaddingDragFrame } from '@tb/core/link';
import { IconButton } from '../ui';
import { DragPreview, EdgeScroll, snapshotTimeAt, type DragViewport } from './drag-preview';
import { trimDurationText } from './useContentTrim';
import { useDragSession } from './useDragSession';
import { useScrollPaint, type ScrollPosition } from './timeline-scroll';
import type { TimelineViewport } from './useTimelineViewport';
import type { SongPadding } from './useSongPadding';
import { blankPieces } from './song-padding-flow';
import './song-padding.css';

/** The handles are small square buttons (link/ui `IconButton` size sm). */
const HANDLE_PX = 28;

/** The blank before or after the music on the timeline while a handle is held, and what the press kept. */
type Held = { preview: DragPreview<number, PaddingDragFrame>; drag: PaddingDrag; viewport: DragViewport; startMs: number };

/**
 * The song's two blank handles on its audio track (0.5.9 E15, 05 设计 7.7): one before the music starts, one after the
 * song ends, outside the segments' own trim handles. Held, nothing is rendered: the blank is drawn hatched and the
 * music, the cameras, the clips and the lighting move together (one variable on the timeline's content), a frame at a
 * time, with no React (DragPreview, EdgeScroll, the trim's length note); let go, the audio is made and the one command
 * written (useSongPadding). The steps are core's paddingDragFrame: whole frames on a grid whose milliseconds are
 * whole, held to the limits, and the note says what stopped it.
 */
export function SongPaddingHandles({ padding, pixelsPerSecond, contentWidth, viewport, top, height }: { padding: SongPadding; pixelsPerSecond: number; contentWidth: number;
  viewport: Pick<TimelineViewport, 'viewportRef' | 'scroll' | 'scrollLeftTo' | 'maxScrollLeft'>; top: number; height: number }): JSX.Element | null {
  const held = useRef<Held | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const blank = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLElement>(null);
  const session = useDragSession<'lead' | 'tail'>((value) => { if (value === null) held.current?.preview.stop(); });
  useEffect(() => () => held.current?.preview.stop(), []);
  const latestViewport = useRef(viewport);
  latestViewport.current = viewport;
  const [edgeScroll] = useState(() => new EdgeScroll({ read: () => latestViewport.current.scroll.read().left, max: () => latestViewport.current.maxScrollLeft(), to: left => latestViewport.current.scrollLeftTo(left) }));
  // Scrolled while a handle is held (the edge scroll, the wheel): it follows from there.
  useScrollPaint(viewport.scroll, useCallback((at: ScrollPosition) => {
    const current = held.current;
    if (!current || current.preview.stopped || current.viewport.scrollLeft === at.left) return;
    current.viewport = { ...current.viewport, scrollLeft: at.left };
    current.preview.redraw();
  }, []));
  const item = padding.item, audio = item?.referenceAudio, limits = padding.limits;
  if (!padding.handles || !item || !audio || !limits) return null;
  const px = (ms: number): number => ms / 1_000 * pixelsPerSecond;
  const leadMs = songLeadBlankMs(audio), songMs = songDurationMs(audio), musicEndMs = audioTracksEndMs(audioTracks(audio));
  const title = padding.blocked ?? '拖动加空白';

  const begin = (event: PointerEvent<HTMLButtonElement>, side: 'lead' | 'tail'): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (padding.blocked) { padding.explain(); return; }
    const element = latestViewport.current.viewportRef.current;
    const content = event.currentTarget.closest<HTMLElement>('.timeline-content');
    const handle = event.currentTarget;
    const area = layer.current;
    if (!element || !content || !area) return;
    held.current?.preview.stop();
    const rect = element.getBoundingClientRect();
    const measured: DragViewport = { left: rect.left, top: rect.top, width: element.clientWidth, height: element.clientHeight, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, pixelsPerSecond };
    const drag: PaddingDrag = { side, limits, frameRate: padding.frameRate };
    const paint = (frame: PaddingDragFrame | null): void => {
      const moved = frame === null ? 0 : side === 'lead' ? frame.leadDeltaMs : frame.tailMs - limits.tail.blankMs;
      // The tracks move with blank time before the music; blank time after it moves nothing but the song's end.
      if (frame && side === 'lead') { content.style.setProperty('--song-padding-shift', `${px(frame.leadDeltaMs)}px`); content.dataset.paddingDrag = 'lead'; }
      else { content.style.removeProperty('--song-padding-shift'); delete content.dataset.paddingDrag; }
      if (frame) { area.dataset.dragging = side; handle.style.setProperty('--song-padding-move', `${px(moved)}px`); }
      else { delete area.dataset.dragging; handle.style.removeProperty('--song-padding-move'); }
      const preview = blank.current, label = note.current;
      if (preview) {
        preview.hidden = frame === null;
        if (frame) { preview.style.left = `${px(side === 'lead' ? 0 : musicEndMs)}px`; preview.style.width = `${px(frame.blankMs)}px`; }
      }
      if (!label) return;
      label.hidden = frame === null;
      if (!frame) return;
      label.textContent = frame.stop ? paddingStopText(side, frame.stop) : `${side === 'lead' ? '前空白' : '后空白'} ${trimDurationText(frame.blankMs)}`;
      label.dataset.edge = side === 'lead' ? 'end' : 'start';
      label.dataset.stopped = String(frame.stop !== null);
      label.style.left = `${px(side === 'lead' ? frame.blankMs : musicEndMs + frame.blankMs)}px`;
    };
    const current: Held = {
      drag, viewport: measured, startMs: snapshotTimeAt(measured, event.clientX),
      preview: new DragPreview<number, PaddingDragFrame>({
        target: (clientX) => paddingDragFrame(current.drag, snapshotTimeAt(current.viewport, clientX) - current.startMs),
        alive: () => handle.isConnected,
        paint,
        restore: () => { paint(null); edgeScroll.stop(); },
        // React draws nothing of it while it is held.
        drawn: () => '',
        changed: () => undefined
      }, paddingDragFrame(drag, 0))
    };
    held.current = current;
    session.begin(event, side, handle);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = held.current;
    if (!current || session.current() === null) return;
    current.preview.move(event.clientX);
    edgeScroll.follow(event.clientX, current.viewport);
  };
  const end = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = held.current;
    if (!current || session.current() === null) return;
    const frame = current.preview.release(event.clientX);
    session.end();
    if (frame && (frame.leadDeltaMs !== 0 || frame.tailMs !== limits.tail.blankMs)) void padding.pad(frame.leadDeltaMs, frame.tailMs);
  };
  const handleProps = (side: 'lead' | 'tail') => ({
    size: 'sm' as const, label: side === 'lead' ? '音乐前的空白' : '音乐后的空白', title, 'aria-disabled': padding.blocked !== null,
    className: 'song-padding-handle', 'data-side': side, 'data-waiting': padding.waiting || undefined,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => begin(event, side), onPointerMove: move, onPointerUp: end, onPointerCancel: session.end
  });
  // Outside the music: the lead handle ends where the music starts, the tail one starts where the song ends; both stay
  // on the timeline when there is no room outside (no blank before, the song filling the view).
  const leadLeft = Math.max(0, px(leadMs) - HANDLE_PX), tailLeft = Math.max(0, Math.min(px(songMs), contentWidth - HANDLE_PX));
  return <div ref={layer} className="song-padding-layer" style={{ top, height }}>
    {/* The layer lets the pointer through to the track (seeking), only the handles take it. */}
    {blankPieces(item).map(piece => <div key={`${piece.side}:${piece.startMs}`} className="song-blank" data-side={piece.side} data-unplayed={piece.unplayed || undefined}
      style={{ left: px(piece.startMs), width: px(piece.endMs - piece.startMs) }} />)}
    <div ref={blank} className="song-blank song-blank-preview" hidden />
    <small ref={note} className="timeline-trim-length song-padding-length" hidden />
    {padding.status ? <small role="status" className="song-padding-status" style={{ left: leadLeft + HANDLE_PX }}>{padding.status}</small> : null}
    <IconButton {...handleProps('lead')} icon={ArrowLeftToLine} style={{ left: leadLeft }} />
    <IconButton {...handleProps('tail')} icon={ArrowRightToLine} style={{ left: tailLeft }} />
  </div>;
}
