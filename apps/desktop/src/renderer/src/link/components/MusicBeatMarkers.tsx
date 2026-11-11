import type { MusicBeatSegments } from './useMusicBeatSegments';
import { musicSegmentTempoLabel } from '../view-models/music-segment-display';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Menu, MenuItem } from '../ui';
import { ownKeys } from '../keys/key-owner';
import { beatMarksInView, timeToX } from './timeline-geometry';
import { pinnedSpan, useScrollPaint, type ScrollPosition, type TimelineScroll } from './timeline-scroll';

/**
 * The recognised sections and beats on the lighting workbench's ruler. They are pressed (seek, right-click to
 * delete, Delete), so they stay in the DOM (05 设计 4.7); what React draws is culled to the scroll block's window
 * (`view`), and the sections follow the exact scroll straight into the DOM (0.5.9 E5).
 */
export function MusicBeatMarkers({ beats, view, scroll, viewportWidth, pixelsPerSecond, top, rulerHeight, showBeats, showSegments, disabled, onSeek }: { beats: MusicBeatSegments; view: { left: number; width: number }; scroll: TimelineScroll; viewportWidth: number; pixelsPerSecond: number; top: number; rulerHeight: number; showBeats: boolean; showSegments: boolean; disabled: boolean; onSeek: (ms: number) => void }): JSX.Element {
  const [menu, setMenu] = useState<{ id: string; kind: 'beat' | 'segment'; x: number; y: number } | null>(null);
  const open = (event: React.MouseEvent, id: string, kind: 'beat' | 'segment'): void => { event.preventDefault(); event.stopPropagation(); setMenu({ id, kind, x: event.clientX, y: event.clientY }); };
  const { left, width } = view;
  const visible = showBeats && beats.data?.state === 'ready' ? beatMarksInView(beats.data.beats, beat => beat.atMs, pixelsPerSecond, view) : [];
  const points = beats.points;
  const segments = useMemo(() => showSegments ? points.filter(point => timeToX(point.endMs, pixelsPerSecond) >= left && timeToX(point.startMs, pixelsPerSecond) <= left + width) : [], [showSegments, points, pixelsPerSecond, left, width]);
  const segmentButtons = useRef(new Map<string, HTMLButtonElement>());
  const pin = useCallback((at: ScrollPosition): void => {
    for (const point of segments) {
      const button = segmentButtons.current.get(point.id);
      if (!button) continue;
      const place = pinnedSpan(timeToX(point.startMs, pixelsPerSecond), timeToX(point.endMs, pixelsPerSecond), at.left, viewportWidth);
      button.style.left = `${place.left}px`;
      button.style.width = `${place.width}px`;
      button.style.visibility = place.visible ? '' : 'hidden';
    }
  }, [segments, pixelsPerSecond, viewportWidth]);
  useScrollPaint(scroll, pin);
  const scrolled = scroll.read().left;
  return <><div className="music-beat-markers" aria-label="音乐识别标记">{segments.map(point => {
    const place = pinnedSpan(timeToX(point.startMs, pixelsPerSecond), timeToX(point.endMs, pixelsPerSecond), scrolled, viewportWidth);
    return <button key={point.id} ref={element => { if (element) segmentButtons.current.set(point.id, element); else segmentButtons.current.delete(point.id); }} type="button" className="music-tempo-segment" disabled={disabled || beats.blocked} style={{ left: place.left, top, width: place.width, visibility: place.visible ? undefined : 'hidden' }} aria-pressed={beats.selected?.id === point.id} aria-label={`音乐段落 ${point.name}`} title={`${point.name} · ${musicSegmentTempoLabel(point)} · ${(point.startMs / 1000).toFixed(2)}–${(point.endMs / 1000).toFixed(2)} 秒；右键删除`} onPointerDown={event => event.stopPropagation()} onContextMenu={event => open(event, point.id, 'segment')} {...ownKeys('Delete', 'Backspace')} onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); beats.remove(point.id); } }} onClick={event => { event.stopPropagation(); beats.select(point.id); onSeek(point.startMs); }}>{point.name} · {musicSegmentTempoLabel(point)}</button>;
  })}{visible.map(beat => <button type="button" key={beat.id} className="music-detected-beat" data-strong={beat.strong} style={{ left: timeToX(beat.atMs, pixelsPerSecond), top: rulerHeight - 9 }} aria-label={`音乐拍点 ${(beat.atMs / 1000).toFixed(2)} 秒`} title={`${beat.strong ? '强拍' : '节拍'} · ${(beat.atMs / 1000).toFixed(2)} 秒；右键删除`} disabled={disabled || beats.blocked} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSeek(beat.atMs); }} onContextMenu={event => open(event, beat.id, 'beat')} {...ownKeys('Delete')} onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); beats.removeBeat(beat.id); } }} />)}</div>{menu ? <Menu x={menu.x} y={menu.y} label={menu.kind === 'beat' ? '拍点菜单' : '音乐段落菜单'} onClose={() => setMenu(null)}><MenuItem icon={Trash2} danger disabled={disabled || beats.blocked} onSelect={() => { if (menu.kind === 'beat') beats.removeBeat(menu.id); else beats.remove(menu.id); setMenu(null); }}>{menu.kind === 'beat' ? '删除拍点' : '删除此段'}</MenuItem></Menu> : null}</>;
}
