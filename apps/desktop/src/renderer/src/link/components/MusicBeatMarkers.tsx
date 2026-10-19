import type { MusicBeatSegments } from './useMusicBeatSegments';
import { musicSegmentTempoLabel } from '../view-models/music-segment-display';
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';

export function MusicBeatMarkers({ beats, left, width, pixelsPerSecond, top, rulerHeight, showBeats, showSegments, disabled, onSeek }: { beats: MusicBeatSegments; left: number; width: number; pixelsPerSecond: number; top: number; rulerHeight: number; showBeats: boolean; showSegments: boolean; disabled: boolean; onSeek: (ms: number) => void }): JSX.Element {
  const [menu, setMenu] = useState<{ id: string; kind: 'beat' | 'segment'; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent | KeyboardEvent): void => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target instanceof Element && event.target.closest('.music-beat-context'))) setMenu(null); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [menu]);
  const open = (event: React.MouseEvent, id: string, kind: 'beat' | 'segment'): void => { event.preventDefault(); event.stopPropagation(); setMenu({ id, kind, x: Math.min(event.clientX, window.innerWidth - 140), y: Math.min(event.clientY, window.innerHeight - 50) }); };
  let previous = -Infinity;
  const visible = showBeats && beats.data?.state === 'ready' ? beats.data.beats.filter(beat => {
    const x = beat.atMs / 1000 * pixelsPerSecond;
    if (x < left - 8 || x > left + width || x - previous < 8) return false;
    previous = x; return true;
  }) : [];
  return <><div className="music-beat-markers" aria-label="音乐识别标记">{showSegments ? beats.points.map(point => {
    const x = point.startMs / 1000 * pixelsPerSecond, end = point.endMs / 1000 * pixelsPerSecond;
    if (end < left || x > left + width) return null;
    return <button key={point.id} type="button" className="music-tempo-segment" disabled={disabled || beats.blocked} style={{ left: Math.max(x, left), top, width: Math.max(4, Math.min(end, left + width) - Math.max(x, left)) }} aria-pressed={beats.selected?.id === point.id} aria-label={`音乐段落 ${point.name}`} title={`${point.name} · ${musicSegmentTempoLabel(point)} · ${(point.startMs / 1000).toFixed(2)}–${(point.endMs / 1000).toFixed(2)} 秒；右键删除`} onPointerDown={event => event.stopPropagation()} onContextMenu={event => open(event, point.id, 'segment')} onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); beats.remove(point.id); } }} onClick={event => { event.stopPropagation(); beats.select(point.id); onSeek(point.startMs); }}>{point.name} · {musicSegmentTempoLabel(point)}</button>;
  }) : null}{visible.map(beat => <button type="button" key={beat.id} className="music-detected-beat" data-strong={beat.strong} style={{ left: beat.atMs / 1000 * pixelsPerSecond, top: rulerHeight - 9 }} aria-label={`音乐拍点 ${(beat.atMs / 1000).toFixed(2)} 秒`} title={`${beat.strong ? '强拍' : '节拍'} · ${(beat.atMs / 1000).toFixed(2)} 秒；右键删除`} disabled={disabled || beats.blocked} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSeek(beat.atMs); }} onContextMenu={event => open(event, beat.id, 'beat')} onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); beats.removeBeat(beat.id); } }} />)}</div>{menu ? createPortal(<div onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} className="resource-context-menu music-beat-context" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 10000 }}><button type="button" disabled={disabled || beats.blocked} onClick={() => { if (menu.kind === 'beat') beats.removeBeat(menu.id); else beats.remove(menu.id); setMenu(null); }}>{menu.kind === 'beat' ? '删除拍点' : '删除此段'}</button></div>, document.body) : null}</>;
}
