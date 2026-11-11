import type { MusicBeatSegments } from './useMusicBeatSegments';
import { musicSegmentTempoLabel } from '../view-models/music-segment-display';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Menu, MenuItem } from '../ui';
import { ownKeys } from '../keys/key-owner';

export function MusicBeatMarkers({ beats, left, width, pixelsPerSecond, top, rulerHeight, showBeats, showSegments, disabled, onSeek }: { beats: MusicBeatSegments; left: number; width: number; pixelsPerSecond: number; top: number; rulerHeight: number; showBeats: boolean; showSegments: boolean; disabled: boolean; onSeek: (ms: number) => void }): JSX.Element {
  const [menu, setMenu] = useState<{ id: string; kind: 'beat' | 'segment'; x: number; y: number } | null>(null);
  const open = (event: React.MouseEvent, id: string, kind: 'beat' | 'segment'): void => { event.preventDefault(); event.stopPropagation(); setMenu({ id, kind, x: event.clientX, y: event.clientY }); };
  let previous = -Infinity;
  const visible = showBeats && beats.data?.state === 'ready' ? beats.data.beats.filter(beat => {
    const x = beat.atMs / 1000 * pixelsPerSecond;
    if (x < left - 8 || x > left + width || x - previous < 8) return false;
    previous = x; return true;
  }) : [];
  return <><div className="music-beat-markers" aria-label="音乐识别标记">{showSegments ? beats.points.map(point => {
    const x = point.startMs / 1000 * pixelsPerSecond, end = point.endMs / 1000 * pixelsPerSecond;
    if (end < left || x > left + width) return null;
    return <button key={point.id} type="button" className="music-tempo-segment" disabled={disabled || beats.blocked} style={{ left: Math.max(x, left), top, width: Math.max(4, Math.min(end, left + width) - Math.max(x, left)) }} aria-pressed={beats.selected?.id === point.id} aria-label={`音乐段落 ${point.name}`} title={`${point.name} · ${musicSegmentTempoLabel(point)} · ${(point.startMs / 1000).toFixed(2)}–${(point.endMs / 1000).toFixed(2)} 秒；右键删除`} onPointerDown={event => event.stopPropagation()} onContextMenu={event => open(event, point.id, 'segment')} {...ownKeys('Delete', 'Backspace')} onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); beats.remove(point.id); } }} onClick={event => { event.stopPropagation(); beats.select(point.id); onSeek(point.startMs); }}>{point.name} · {musicSegmentTempoLabel(point)}</button>;
  }) : null}{visible.map(beat => <button type="button" key={beat.id} className="music-detected-beat" data-strong={beat.strong} style={{ left: beat.atMs / 1000 * pixelsPerSecond, top: rulerHeight - 9 }} aria-label={`音乐拍点 ${(beat.atMs / 1000).toFixed(2)} 秒`} title={`${beat.strong ? '强拍' : '节拍'} · ${(beat.atMs / 1000).toFixed(2)} 秒；右键删除`} disabled={disabled || beats.blocked} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSeek(beat.atMs); }} onContextMenu={event => open(event, beat.id, 'beat')} {...ownKeys('Delete')} onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); beats.removeBeat(beat.id); } }} />)}</div>{menu ? <Menu x={menu.x} y={menu.y} label={menu.kind === 'beat' ? '拍点菜单' : '音乐段落菜单'} onClose={() => setMenu(null)}><MenuItem icon={Trash2} danger disabled={disabled || beats.blocked} onSelect={() => { if (menu.kind === 'beat') beats.removeBeat(menu.id); else beats.remove(menu.id); setMenu(null); }}>{menu.kind === 'beat' ? '删除拍点' : '删除此段'}</MenuItem></Menu> : null}</>;
}
