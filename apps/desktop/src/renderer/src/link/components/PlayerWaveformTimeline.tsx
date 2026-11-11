import { useEffect, useRef, useState } from 'react';
import { useDragSession } from './useDragSession';
import { TimelineWaveformCanvas, useSongWaveform, type ReferenceWaveformSource } from './ReferenceWaveform';
import { ownKeys } from '../keys/key-owner';

export function PlayerWaveformTimeline(props: { source: ReferenceWaveformSource | null; positionMs: number; enabled: boolean; onSeek: (positionMs: number) => void }): JSX.Element {
  const waveform = useSongWaveform(props.source);
  const element = useRef<HTMLDivElement>(null);
  // Dragging along the waveform (DragSession): Escape gives the drag up and the song stays where it was (K5).
  const session = useDragSession<{ pointerId: number; positionMs: number }>();
  const preview = session.drag?.positionMs ?? null;
  const endDrag = session.end;
  const [width, setWidth] = useState(240);
  const duration = props.source?.durationMs ?? 0;
  const maximum = Math.max(0, duration - 100);
  useEffect(() => { endDrag(); }, [endDrag, props.source?.url, props.enabled]);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(() => setWidth(target.clientWidth));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const position = preview ?? props.positionMs;
  const locate = (clientX: number): number => {
    const bounds = element.current?.getBoundingClientRect();
    return bounds ? Math.round(Math.max(0, Math.min(maximum, (clientX - bounds.left) / Math.max(1, bounds.width) * duration))) : 0;
  };
  return <section className="home-waveform" aria-label="歌曲波形">
    <div ref={element} className="home-waveform-track" role="slider" tabIndex={props.enabled ? 0 : -1} aria-label="波形播放位置" aria-disabled={!props.enabled} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={Math.round(position)} aria-valuetext={formatPosition(position)} {...ownKeys('ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Home', 'End')}
      onPointerDown={(event) => { if (!props.enabled || event.button !== 0) return; event.preventDefault(); session.begin(event, { pointerId: event.pointerId, positionMs: locate(event.clientX) }); }}
      onPointerMove={(event) => { if (session.current()?.pointerId !== event.pointerId) return; session.update({ pointerId: event.pointerId, positionMs: locate(event.clientX) }); }}
      onPointerUp={(event) => { if (session.current()?.pointerId !== event.pointerId) return; const target = locate(event.clientX); session.end(); event.currentTarget.releasePointerCapture(event.pointerId); if (props.enabled) props.onSeek(target); }}
      onPointerCancel={() => session.end()}
      onLostPointerCapture={() => session.end()}
      onKeyDown={(event) => { if (!props.enabled) return; const delta = event.shiftKey ? 10000 : 1000; const target = event.key === 'Home' ? 0 : event.key === 'End' ? maximum : event.key === 'ArrowLeft' ? position - delta : event.key === 'ArrowRight' ? position + delta : null; if (target !== null) { event.preventDefault(); props.onSeek(Math.max(0, Math.min(maximum, target))); } }}>
      {props.source && waveform.waveform ? <><TimelineWaveformCanvas waveform={waveform.waveform} scrollLeft={0} viewportWidth={width} contentWidth={width} /><i className="home-waveform-playhead" style={{ left: `${duration ? Math.min(100, position / duration * 100) : 0}%` }} /></> : <span className="home-waveform-empty">{waveform.error ?? (props.source ? '正在读取波形…' : '还没有音频')}</span>}
    </div>
    {/* Old peaks stay on screen when rebuilding them failed, so the reason is shown beside them. */}
    {props.source && waveform.waveform && waveform.error ? <p className="home-waveform-warning" role="status" title={waveform.error}>{waveform.error}</p> : null}
    {duration > 0 ? <div className="home-waveform-ruler" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span key={index}>{formatPosition(duration * index / 4)}</span>)}</div> : null}
    {preview === null ? null : <small className="home-waveform-hint">定位到 {formatPosition(preview)}</small>}
  </section>;
}

function formatPosition(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
