import { ModalSurface } from './ModalSurface';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { moveLightingEffect, removeLightingEffects } from '@tb/core/link';
import type { LightingClip, LightingTrack, MtcFrameRate } from '@tb/schema';
import { cueEventEntries } from './cue-event-view';
import { formatTimelineTimecode } from './timeline-geometry';
import type { LightingTimelineProps } from './LightingTimeline';

type Entry = { track: LightingTrack; clip: LightingClip; id: string; cue: string; ms: number };
const cueMarkerWidth = (cue: string): number => Math.max(36, Math.ceil(cue.length * 8) + 20);
export function WaveformCuePoints({ mode, height, lighting, frameRate, pixelsPerSecond, top, scrollLeft, viewportWidth, durationMs, disabled }: { mode: 'seek' | 'select'; height: number; lighting: LightingTimelineProps; frameRate: MtcFrameRate; pixelsPerSecond: number; top: number; scrollLeft: number; viewportWidth: number; durationMs: number; disabled: boolean }): JSX.Element {
  const [drag, setDrag] = useState<{ id: string; x: number; ms: number; target: number } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [timeVisible, setTimeVisible] = useState(false);
  useEffect(() => {
    const hideOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.waveform-cue-point')) setTimeVisible(false);
    };
    window.addEventListener('pointerdown', hideOutside, true);
    return () => window.removeEventListener('pointerdown', hideOutside, true);
  }, []);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!context) return;
    const close = (): void => setContext(null);
    window.addEventListener('pointerdown', close); window.addEventListener('blur', close); window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [context]);
  const [range, setRange] = useState<{ start: number; end: number; additive: boolean } | null>(null);
  useEffect(() => { setSelection([]); setRange(null); }, [mode]);
  const [editing, setEditing] = useState<Entry | null>(null);
  const entries = useMemo(() => cueEventEntries(lighting.document), [lighting.document]);
  const rows = new Map<string, number>();
  const rowEnds: number[] = [];
  for (const entry of [...entries].sort((a, b) => a.ms - b.ms)) {
    const left = entry.ms / 1000 * pixelsPerSecond;
    let row = rowEnds.findIndex(end => end + 6 <= left);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = left + cueMarkerWidth(entry.cue);
    rows.set(entry.id, row);
  }
  const change = (entry: Entry, ms: number, cue = entry.cue): void => {
    if (disabled || entry.track.locked) return;
    if (!/^\d+(?:\.\d+)?$/.test(cue) || Number(cue) <= 0 || !Number.isFinite(ms) || ms < 0 || ms >= durationMs) { lighting.onError?.('请输入有效的 Cue 编号和音频范围内的时间'); return; }
    try { lighting.onChange(moveLightingEffect(lighting.document, entry.id, ms, durationMs, cue), '修改音频 Cue 卡点'); }
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
  return <div className={`waveform-cue-points${mode === 'select' ? ' is-selecting' : ''}`} tabIndex={0} aria-label="Cue 框选画布" style={{ top, height }}
    onPointerDown={event => { if (mode !== 'select' || event.button !== 0 || event.target !== event.currentTarget) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); const ms = (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000; setRange({ start: ms, end: ms, additive: event.ctrlKey || event.metaKey || event.shiftKey }); }}
    onPointerMove={event => { if (!range) return; const ms = (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000; setRange({ ...range, end: ms }); }}
    onPointerUp={event => { if (!range) return; event.stopPropagation(); const end = (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000; const ids = entries.filter(entry => entry.ms >= Math.min(range.start, end) && entry.ms <= Math.max(range.start, end)).map(entry => entry.id); setSelection([...new Set([...(range.additive ? selection : []), ...ids])]); setRange(null); event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => setRange(null)} onKeyDownCapture={event => { if (event.target instanceof Element && event.target.closest('input,textarea,select')) return; if ((event.key === 'Delete' || event.key === 'Backspace') && selection.length) { event.preventDefault(); event.stopPropagation(); removeSelected(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRange(null); setSelection([]); setContext(null); } }}>
    {range ? <span className="cue-selection-box" style={{ left: Math.min(range.start, range.end) / 1000 * pixelsPerSecond, width: Math.abs(range.end - range.start) / 1000 * pixelsPerSecond }} /> : null}
    {context ? createPortal(<div className="cue-point-context" role="menu" aria-label="Cue 菜单" style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}><button role="menuitem" disabled={disabled} onClick={removeSelected}><Trash2 />删除{selection.length > 1 ? ` ${selection.length} 个 Cue` : ' Cue'}<kbd>Backspace</kbd></button></div>, document.body) : null}
    {entries.map((entry) => {
      const ms = drag?.id === entry.id ? drag.target : entry.ms;
      if (ms * pixelsPerSecond / 1000 < scrollLeft - 50 || ms * pixelsPerSecond / 1000 > scrollLeft + viewportWidth + 50) return null;
      const width = cueMarkerWidth(entry.cue);
      const markerTop = 8 + (rows.get(entry.id) ?? 0) * 34;
      return <button key={entry.id} className="waveform-cue-point" aria-label={`音频 Cue ${entry.cue}`} aria-pressed={selection.includes(entry.id) || lighting.selectedEventId === entry.id} title={`Cue ${entry.cue} · ${formatTimelineTimecode(ms, frameRate)} · 拖动定位，双击修改`} style={{ left: ms * pixelsPerSecond / 1000, top: markerTop, width, '--cue-guide-height': `${Math.max(0, height - markerTop - 32)}px` } as CSSProperties}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); if (!selection.includes(entry.id)) setSelection([entry.id]); setContext({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 50)) }); }}
        onPointerDown={event => { if (event.button !== 0) return; setTimeVisible(true); event.stopPropagation(); event.preventDefault(); event.currentTarget.focus(); setSelection(event.ctrlKey || event.metaKey || event.shiftKey ? selection.includes(entry.id) ? selection.filter(id => id !== entry.id) : [...selection, entry.id] : [entry.id]); lighting.onSelectEvent?.(entry.track.id, entry.clip.id, entry.id); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) lighting.onAuditionEvent?.(entry.id); if (disabled || entry.track.locked || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setDrag({ id: entry.id, x: event.clientX, ms: entry.ms, target: entry.ms }); }}
        onPointerMove={event => { if (drag?.id !== entry.id) return; const raw = drag.ms + (event.clientX - drag.x) / pixelsPerSecond * 1000; setDrag({ ...drag, target: Math.max(0, Math.min(durationMs - 1, lighting.snapTime?.(raw, entry.id) ?? raw)) }); }}
        onPointerUp={event => { if (drag?.id !== entry.id) return; event.currentTarget.releasePointerCapture(event.pointerId); if (drag.target !== drag.ms) change(entry, drag.target); setDrag(null); }} onPointerCancel={() => setDrag(null)}
        onDoubleClick={event => { event.stopPropagation(); if (!disabled && !entry.track.locked) setEditing(entry); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setEditing(entry); } if ((event.key === 'Delete' || event.key === 'Backspace') && !disabled && !entry.track.locked) { event.preventDefault(); event.stopPropagation(); try { lighting.onChange(removeLightingEffects(lighting.document, [entry.id]), '删除 Cue 卡点'); } catch (error) { lighting.onError?.(String(error)); } } }}><span className="cue-marker-number">{entry.cue}</span></button>;
    })}
    {entries.filter(entry => entry.id === (drag?.id ?? (timeVisible ? lighting.selectedEventId : null))).map(entry => <output className="timeline-current-time cue-ruler-time" aria-label="当前 Cue 时间" key={entry.id} style={{ top: -top + 7, bottom: 'auto', left: Math.max(scrollLeft + 60, Math.min((drag?.target ?? entry.ms) / 1000 * pixelsPerSecond, scrollLeft + viewportWidth - 60)) }}>{formatTimelineTimecode(drag?.target ?? entry.ms, frameRate)}</output>)}
    {editing ? <ModalSurface className="cue-point-dialog" label="修改 Cue 卡点" onClose={() => setEditing(null)}><form className="effect-binding-form" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const cue = data.get('cue'); const time = data.get('time'); if (typeof cue === 'string' && typeof time === 'string') change(editing, Number(time) * 1000, cue); }}><h3>修改 Cue 卡点</h3><label>Cue 编号<input name="cue" defaultValue={editing.cue} required /></label><label>时间（秒）<input name="time" type="number" min="0" step="0.001" defaultValue={(editing.ms / 1000).toFixed(3)} required /></label><footer><button type="button" onClick={() => setEditing(null)}>取消</button><button disabled={disabled}>保存卡点</button></footer></form></ModalSurface> : null}
  </div>;
}
