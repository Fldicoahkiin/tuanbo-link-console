import { useState } from 'react';
import type { LightingTimelineProps } from './LightingTimeline';
import { MAX_TIMELINE_TIME_MS } from './timeline-geometry';
import { ownKeys } from '../keys/key-owner';

/** Programme annotations can extend the editable timeline; its current end is not a trim limit. */
export function TimelineMarkers(props: LightingTimelineProps & { hideAnalysis?: boolean; pixelsPerSecond: number; timeAtClientX: (x: number) => number; onSeek: (ms: number) => void }): JSX.Element {
  const [drag, setDrag] = useState<{ id: string; startMs: number; x: number } | null>(null);
  const [resize, setResize] = useState<{ id: string; startMs: number; endMs: number; x: number; edge: 'start' | 'end' } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const remove = (id: string): void => props.onChange({ ...props.document, markers: props.document.markers.filter((marker) => marker.id !== id) }, '删除时间线标记');
  return <div className="timeline-markers" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    {props.document.markers.filter(marker => !props.hideAnalysis || !/^(analysis:|music-beat:)/.test(marker.id)).map((marker) => {
      const startMs = resize?.id === marker.id ? resize.startMs : drag?.id === marker.id ? drag.startMs : marker.startMs;
      const endMs = resize?.id === marker.id ? resize.endMs : marker.endMs === null ? null : marker.endMs + startMs - marker.startMs;
      const left = startMs / 1000 * props.pixelsPerSecond;
      const compact = marker.id.startsWith('analysis:') ? /^(?:节拍|小节第一拍) (\d+)$/.exec(marker.name)?.[1] : undefined;
      return <div className="timeline-marker-anchor" key={marker.id} style={{ left, color: marker.color }}>
        {endMs !== null ? <>
          <span className="timeline-marker-region" style={{ width: (endMs - startMs) / 1000 * props.pixelsPerSecond }} />
          {(['start', 'end'] as const).map((edge) => <button key={edge} type="button" className="timeline-region-edge" aria-label={`${marker.name} 区域${edge === 'start' ? '起点' : '终点'}`} title={`拖动调整区域${edge === 'start' ? '起点' : '终点'}`} style={{ left: edge === 'start' ? 0 : (endMs - startMs) / 1000 * props.pixelsPerSecond }} onPointerDown={(event) => {
            if (event.button !== 0 || marker.endMs === null) return;
            event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
            setResize({ id: marker.id, startMs: marker.startMs, endMs: marker.endMs, x: event.clientX, edge });
          }} onPointerMove={(event) => {
            if (resize?.id !== marker.id || resize.edge !== edge || marker.endMs === null || Math.abs(event.clientX - resize.x) < 3) return;
            const delta = props.timeAtClientX(event.clientX) - props.timeAtClientX(resize.x);
            setResize({ ...resize, ...(edge === 'start' ? { startMs: Math.max(0, Math.min(marker.endMs - 1, marker.startMs + delta)) } : { endMs: Math.min(MAX_TIMELINE_TIME_MS, Math.max(marker.startMs + 1, marker.endMs + delta)) }) });
          }} onPointerUp={(event) => {
            event.stopPropagation();
            if (resize?.id !== marker.id || resize.edge !== edge) return;
            if (resize.startMs !== marker.startMs || resize.endMs !== marker.endMs) props.onChange({ ...props.document, markers: props.document.markers.map((entry) => entry.id === marker.id ? { ...entry, startMs: resize.startMs, endMs: resize.endMs } : entry) }, '调整时间线区域');
            setResize(null);
          }} onPointerCancel={() => setResize(null)} {...ownKeys('Escape')} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setResize(null); }
          }} />)}
        </> : null}
        {editing === marker.id ? <input className="timeline-marker-name" autoFocus aria-label="时间线标记名称" defaultValue={marker.name} {...ownKeys('*')} onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
        }} onBlur={(event) => {
          const name = event.currentTarget.value.trim();
          if (name && name !== marker.name) props.onChange({ ...props.document, markers: props.document.markers.map((entry) => entry.id === marker.id ? { ...entry, name } : entry) }, '重命名时间线标记');
          setEditing(null);
        }} /> : <button type="button" className={`timeline-marker${compact ? ' analysis-point-marker' : ''}`} style={{ borderColor: marker.color }} aria-label={`时间线标记 ${marker.name}`} title={`${marker.name}${marker.notes ? ` · ${marker.notes}` : ''} · ${(marker.startMs / 1000).toFixed(3)} 秒；拖动移动，双击改名，Delete 删除`} onDoubleClick={() => setEditing(marker.id)} {...ownKeys('Delete', 'Backspace', 'F2', 'Escape')} onKeyDown={(event) => {
          if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(marker.id); }
          if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); setEditing(marker.id); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDrag(null); }
        }} onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ id: marker.id, startMs: marker.startMs, x: event.clientX });
        }} onPointerMove={(event) => {
          if (drag?.id !== marker.id || Math.abs(event.clientX - drag.x) < 3) return;
          setDrag({ ...drag, startMs: Math.max(0, Math.min(MAX_TIMELINE_TIME_MS - (marker.endMs === null ? 0 : marker.endMs - marker.startMs), marker.startMs + props.timeAtClientX(event.clientX) - props.timeAtClientX(drag.x))) });
        }} onPointerUp={(event) => {
          if (drag?.id !== marker.id) return;
          event.stopPropagation();
          if (drag.startMs !== marker.startMs) {
            const delta = drag.startMs - marker.startMs;
            props.onChange({ ...props.document, markers: props.document.markers.map((entry) => entry.id === marker.id ? { ...entry, startMs: drag.startMs, endMs: entry.endMs === null ? null : entry.endMs + delta } : entry) }, '移动时间线标记');
          } else props.onSeek(marker.startMs);
          setDrag(null);
        }} onPointerCancel={() => setDrag(null)} onClick={(event) => { event.stopPropagation(); if (event.detail === 0) props.onSeek(marker.startMs); }}><span>{compact ?? marker.name}</span></button>}
      </div>;
    })}
  </div>;
}
