import { ModalSurface } from '../ui/ModalSurface';
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Trash2 } from 'lucide-react';
import { Menu, MenuItem } from '../ui';
import { moveLightingEffect, removeLightingEffects } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { cueEventEntries } from './cue-event-view';
import { formatTimelineTimecode } from './timeline-geometry';
import type { LightingTimelineProps } from './LightingTimeline';
import { cancelDragOnEscape } from '../playback-keys';

import { cueMarkerWidth, displayCueNumber, layoutCueMarkers } from './cue-marker-layout';
type Entry = ReturnType<typeof cueEventEntries>[number];
type CuePointDrag = { id: string; x: number; ms: number; target: number; snapped: boolean };
export function WaveformCuePoints({ mode, height, lighting, frameRate, pixelsPerSecond, top, scrollLeft, viewportWidth, durationMs, disabled }: { mode: 'seek' | 'select'; height: number; lighting: LightingTimelineProps; frameRate: MtcFrameRate; pixelsPerSecond: number; top: number; scrollLeft: number; viewportWidth: number; durationMs: number; disabled: boolean }): JSX.Element {
  const [drag, setDragState] = useState<CuePointDrag | null>(null);
  const dragRef = useRef<CuePointDrag | null>(null);
  const setDrag = (value: CuePointDrag | null): void => { dragRef.current = value; setDragState(value); };
  useEffect(() => {
    const cancel = (): void => { dragRef.current = null; setDragState(null); };
    const escape = (event: KeyboardEvent): void => cancelDragOnEscape(event, dragRef.current !== null, cancel);
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', cancel); };
  }, []);
  const [selection, setSelection] = useState<string[]>([]);
  const [timeVisible, setTimeVisible] = useState(false);
  const clearSelection = lighting.onClearSelection;
  useEffect(() => {
    const hideOutside = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.lighting-effect-dock[data-editor=true],.lighting-material-navigation,.waveform-cue-point,.ui-menu,.cue-point-dialog,.cue-composer,.cue-inspector,[role="dialog"],.lighting-music-toolbar,.timeline-toolbar')) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      setTimeVisible(false); setSelection([]); clearSelection?.();
    };
    window.addEventListener('pointerdown', hideOutside, true);
    return () => window.removeEventListener('pointerdown', hideOutside, true);
  }, [clearSelection]);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [range, setRange] = useState<{ start: number; end: number; additive: boolean } | null>(null);
  useEffect(() => { setSelection([]); setRange(null); }, [mode]);
  const [editing, setEditing] = useState<Entry | null>(null);
  const entries = useMemo(() => cueEventEntries(lighting.document), [lighting.document]);
  const placements = useMemo(() => layoutCueMarkers(entries, pixelsPerSecond), [entries, pixelsPerSecond]);
  const rows = useMemo(() => new Map(placements.map(marker => [marker.id, marker.row])), [placements]);
  const contentHeight = placements.reduce((size, marker) => Math.max(size, 12 + (marker.row + 1) * 28), height);
  const change = (entry: Entry, ms: number): void => {
    if (disabled || entry.track.locked) return;
    if (!Number.isFinite(ms) || ms < 0 || ms >= durationMs) { lighting.onError?.('请输入音频范围内的时间'); return; }
    try { lighting.onChange(moveLightingEffect(lighting.document, entry.id, ms, durationMs), '修改音频 Cue 卡点'); }
    catch (error) { lighting.onError?.(String(error)); return; }
    setEditing(null);
  };
  const removeSelected = (): void => {
    if (disabled || !selection.length) return;
    try { lighting.onChange(removeLightingEffects(lighting.document, selection), '批量删除 Cue 卡点'); }
    catch (error) { lighting.onError?.(String(error)); return; }
    setSelection([]);
    setContext(null);
  };
  return <><div className={`waveform-cue-points${mode === 'select' ? ' is-selecting' : ''}`} tabIndex={0} aria-label="Cue 框选画布" style={{ top, height: contentHeight }}
    onPointerDown={event => { if (mode !== 'select' || event.button !== 0 || event.target !== event.currentTarget) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); const ms = (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000; setRange({ start: ms, end: ms, additive: event.ctrlKey || event.metaKey || event.shiftKey }); }}
    onPointerMove={event => { if (!range) return; const ms = (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000; setRange({ ...range, end: ms }); }}
    onPointerUp={event => { if (!range) return; event.stopPropagation(); const end = (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000; const ids = entries.filter(entry => entry.ms >= Math.min(range.start, end) && entry.ms <= Math.max(range.start, end)).map(entry => entry.id); setSelection([...new Set([...(range.additive ? selection : []), ...ids])]); setRange(null); event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => setRange(null)} onKeyDownCapture={event => { if (event.target instanceof Element && event.target.closest('input,textarea,select')) return; if ((event.key === 'Delete' || event.key === 'Backspace') && selection.length) { event.preventDefault(); event.stopPropagation(); removeSelected(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRange(null); setSelection([]); setContext(null); } }}>
    {range ? <span className="cue-selection-box" style={{ left: Math.min(range.start, range.end) / 1000 * pixelsPerSecond, width: Math.abs(range.end - range.start) / 1000 * pixelsPerSecond }} /> : null}
    {context ? <Menu x={context.x} y={context.y} label="Cue 菜单" onClose={() => setContext(null)}><MenuItem icon={Trash2} danger shortcut="Backspace" disabled={disabled} onSelect={removeSelected}>{selection.length > 1 ? `删除 ${selection.length} 个 Cue` : '删除 Cue'}</MenuItem></Menu> : null}
    {entries.filter(entry => rows.has(entry.id)).map((entry) => {
      const ms = drag?.id === entry.id ? drag.target : entry.ms;
      if (ms * pixelsPerSecond / 1000 < scrollLeft - 50 || (ms - entry.preparationLeadMs) * pixelsPerSecond / 1000 > scrollLeft + viewportWidth + 50) return null;
      const width = cueMarkerWidth(entry.cue);
      const markerTop = 6 + (rows.get(entry.id) ?? 0) * 28;
      return <Fragment key={entry.id}>{entry.preparationLeadMs > 0 ? <span className="waveform-cue-preparation" aria-label={`Cue ${entry.cue} 埋步提前 ${entry.preparationLeadMs / 1000} 秒`} style={{ left: Math.max(0, ms - entry.preparationLeadMs) * pixelsPerSecond / 1000, top: markerTop + 23, width: Math.min(ms, entry.preparationLeadMs) * pixelsPerSecond / 1000 }}><span>埋步</span></span> : null}<button className="waveform-cue-point" data-cue-id={entry.id} aria-label={`音频 Cue ${displayCueNumber(entry.cue)}`} aria-pressed={selection.includes(entry.id) || lighting.selectedEventId === entry.id} title={`Cue ${displayCueNumber(entry.cue)} · ${formatTimelineTimecode(ms, frameRate)} · 拖动定位，双击修改`} style={{ left: ms * pixelsPerSecond / 1000, top: markerTop, width, '--cue-guide-height': `${Math.max(0, contentHeight - markerTop - 32)}px` } as CSSProperties}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); if (!selection.includes(entry.id)) setSelection([entry.id]); setContext({ x: event.clientX, y: event.clientY }); }}
        onPointerDown={event => { if (event.button !== 0) return; setTimeVisible(true); event.stopPropagation(); event.preventDefault(); event.currentTarget.focus(); setSelection(event.ctrlKey || event.metaKey || event.shiftKey ? selection.includes(entry.id) ? selection.filter(id => id !== entry.id) : [...selection, entry.id] : [entry.id]); lighting.onSelectEvent?.(entry.track.id, entry.clip.id, entry.id); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) lighting.onAuditionEvent?.(entry.id); if (disabled || entry.track.locked || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setDrag({ id: entry.id, x: event.clientX, ms: entry.ms, target: entry.ms, snapped: false }); }}
        onPointerMove={event => { const current = dragRef.current; if (current?.id !== entry.id) return; const raw = current.ms + (event.clientX - current.x) / pixelsPerSecond * 1000; const target = Math.max(0, Math.min(durationMs - 1, lighting.snapTime?.(raw, entry.id) ?? raw)); setDrag({ ...current, target, snapped: Math.abs(target - raw) > .1 }); }}
        onPointerUp={event => { const current = dragRef.current; if (current?.id !== entry.id) return; event.currentTarget.releasePointerCapture(event.pointerId); if (current.target !== current.ms) change(entry, current.target); setDrag(null); }} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}
        onDoubleClick={event => { event.stopPropagation(); if (!disabled && !entry.track.locked) setEditing(entry); }}
        onKeyDown={event => { if (event.key === 'Enter' && !disabled && !entry.track.locked) { event.preventDefault(); setEditing(entry); } if ((event.key === 'Delete' || event.key === 'Backspace') && !disabled && !entry.track.locked) { event.preventDefault(); event.stopPropagation(); try { lighting.onChange(removeLightingEffects(lighting.document, [entry.id]), '删除 Cue 卡点'); } catch (error) { lighting.onError?.(String(error)); } } }}><span className="cue-marker-number">{displayCueNumber(entry.cue)}</span></button></Fragment>;
    })}</div>
    {entries.filter(entry => entry.id === (drag?.id ?? (timeVisible ? lighting.selectedEventId : null))).map(entry => <output className="cue-position-readout" aria-label="当前 Cue 时间" key={entry.id} style={{ top: top + 64, left: Math.max(scrollLeft + 8, Math.min((drag?.target ?? entry.ms) / 1000 * pixelsPerSecond, scrollLeft + viewportWidth - 330)) }}>{formatTimelineTimecode(drag?.target ?? entry.ms, frameRate)}{drag && drag.target !== drag.ms ? <><span>{drag.target >= drag.ms ? '+' : ''}{((drag.target - drag.ms) / 1000).toFixed(3)} s</span>{drag.snapped ? <em>已吸附</em> : null}</> : <span>Cue {entry.cue}</span>}</output>)}
    {editing ? <ModalSurface className="cue-point-dialog" label="修改 Cue 卡点" onClose={() => setEditing(null)}><form className="effect-binding-form" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const time = data.get('time'); if (typeof time === 'string') change(editing, Number(time) * 1000); }}><h3>修改 Cue {editing.cue} 卡点</h3><label>时间（秒）<input name="time" type="number" min="0" step="0.001" defaultValue={(editing.ms / 1000).toFixed(3)} required /></label><footer><button type="button" onClick={() => setEditing(null)}>取消</button><button disabled={disabled}>保存卡点</button></footer></form></ModalSurface> : null}
  </>;
}
