import { useState, type PointerEvent } from 'react';
import type { AudioSegment } from '@tb/schema';
import type { AudioEditor } from './useAudioEditor';
import { AudioSegmentWaveform } from './AudioSegmentWaveform';

type Drag = { id: string; edge: 'move' | 'start' | 'end'; clientX: number; segment: AudioSegment; deltaMs: number };
export function AudioTimelineSegments({ editor, pixelsPerSecond, onSelect, onSeek, peaks, scrollLeft, viewportWidth }: { editor: AudioEditor; pixelsPerSecond: number; onSelect: (id: string) => void; onSeek: (ms: number) => void; peaks: readonly number[]; scrollLeft: number; viewportWidth: number }): JSX.Element {
  const [drag, setDrag] = useState<Drag | null>(null);
  const begin = (event: PointerEvent<HTMLElement>, segment: AudioSegment, edge: Drag['edge']): void => {
    if (event.button !== 0) return;
    event.stopPropagation(); editor.select(segment.id); onSelect(segment.id);
    if (editor.disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: segment.id, edge, segment, clientX: event.clientX, deltaMs: 0 });
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    if (!drag) return;
    event.stopPropagation();
    const deltaMs = Math.abs(event.clientX - drag.clientX) < 4 ? 0 : Math.round((event.clientX - drag.clientX) / pixelsPerSecond * 1000);
    setDrag({ ...drag, deltaMs });
  };
  const end = (event: PointerEvent<HTMLElement>): void => {
    if (!drag) return;
    event.stopPropagation();
    const delta = drag.deltaMs; const segment = drag.segment;
    if (delta) {
      const patch = drag.edge === 'move' ? { startMs: Math.max(0, segment.startMs + delta) }
        : drag.edge === 'start' ? { startMs: segment.startMs + delta, sourceOffsetMs: segment.sourceOffsetMs + delta, durationMs: segment.durationMs - delta }
          : { durationMs: segment.durationMs + delta };
      void editor.update(segment.id, patch);
    }
    if (!delta) onSeek(segment.startMs + (event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerSecond * 1000);
    setDrag(null);
  };
  return <>
    {editor.segments.map((segment, index) => {
      const active = drag?.id === segment.id ? drag : null;
      const start = segment.startMs + (active?.edge === 'move' || active?.edge === 'start' ? active.deltaMs : 0);
      const duration = segment.durationMs + (active?.edge === 'end' ? active.deltaMs : active?.edge === 'start' ? -active.deltaMs : 0);
      return <div key={segment.id} className={`audio-timeline-segment${editor.selectedId === segment.id ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`音频片段 ${index + 1}`} title={`音频片段 ${index + 1} · 拖动位置，拖动两端裁剪`} style={{ left: Math.max(0, start) / 1000 * pixelsPerSecond, width: Math.max(2, duration / 1000 * pixelsPerSecond) }}
        onPointerDown={(event) => begin(event, segment, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); editor.select(segment.id); onSelect(segment.id); }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); editor.select(segment.id); onSelect(segment.id); } if (event.key === 'Delete' && editor.selectedId === segment.id) { event.preventDefault(); event.stopPropagation(); void editor.remove(); } }}>
        <AudioSegmentWaveform peaks={peaks} sourceStartMs={segment.startMs + (active?.edge === 'start' ? active.deltaMs : 0)} sourceDurationMs={editor.audio?.durationMs ?? 1} durationMs={duration} startMs={start} pixelsPerSecond={pixelsPerSecond} scrollLeft={scrollLeft} viewportWidth={viewportWidth} />
        {duration / 1000 * pixelsPerSecond > 65 ? <span className="audio-segment-name" style={{ left: Math.max(8, scrollLeft - start / 1000 * pixelsPerSecond + 8) }}>{editor.title}<small>{(duration / 1000).toFixed(2)}s</small></span> : null}
        <span className="audio-trim-handle start" title="调整音频起点" onPointerDown={(event) => begin(event, segment, 'start')} />
        <span className="audio-trim-handle end" title="调整音频终点" onPointerDown={(event) => begin(event, segment, 'end')} />
      </div>;
    })}
    {editor.points.filter((time) => time / 1000 * pixelsPerSecond >= scrollLeft - 8 && time / 1000 * pixelsPerSecond <= scrollLeft + viewportWidth + 8).map((time) => <button className="audio-beat-marker" key={time} aria-label={`节拍 ${(time / 1000).toFixed(3)} 秒`} title={`节拍 ${(time / 1000).toFixed(3)} 秒 · 点击定位`} style={{ left: time / 1000 * pixelsPerSecond }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSeek(time); }} />)}
  </>;
}
