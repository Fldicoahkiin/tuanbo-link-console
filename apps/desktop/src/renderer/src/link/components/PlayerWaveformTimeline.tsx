import { useEffect, useRef, useState } from 'react';
import { TimelineWaveformCanvas, useReferenceWaveformPeaks, type ReferenceWaveformSource } from './ReferenceWaveform';

export function PlayerWaveformTimeline(props: { source: ReferenceWaveformSource | null; positionMs: number; enabled: boolean; onSeek: (positionMs: number) => void }): JSX.Element {
  const waveform = useReferenceWaveformPeaks(props.source);
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; positionMs: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [width, setWidth] = useState(240);
  const duration = props.source?.durationMs ?? 0;
  const maximum = Math.max(0, duration - 100);
  useEffect(() => { drag.current = null; setPreview(null); }, [props.source?.url, props.enabled]);
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
  return <section className="home-waveform-monitor" aria-label="歌曲波形">
    <div ref={element} className="home-waveform-content interactive-waveform" role="slider" tabIndex={props.enabled ? 0 : -1} aria-label="波形播放位置" aria-disabled={!props.enabled} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={Math.round(position)} aria-valuetext={formatPosition(position)}
      onPointerDown={(event) => { if (!props.enabled || event.button !== 0) return; event.preventDefault(); const positionMs = locate(event.clientX); drag.current = { pointerId: event.pointerId, positionMs }; setPreview(positionMs); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current?.pointerId !== event.pointerId) return; const positionMs = locate(event.clientX); drag.current.positionMs = positionMs; setPreview(positionMs); }}
      onPointerUp={(event) => { if (drag.current?.pointerId !== event.pointerId) return; const target = locate(event.clientX); drag.current = null; setPreview(null); event.currentTarget.releasePointerCapture(event.pointerId); if (props.enabled) props.onSeek(target); }}
      onPointerCancel={() => { drag.current = null; setPreview(null); }}
      onLostPointerCapture={() => { drag.current = null; setPreview(null); }}
      onKeyDown={(event) => { if (!props.enabled) return; const delta = event.shiftKey ? 10000 : 1000; const target = event.key === 'Home' ? 0 : event.key === 'End' ? maximum : event.key === 'ArrowLeft' ? position - delta : event.key === 'ArrowRight' ? position + delta : null; if (target !== null) { event.preventDefault(); props.onSeek(Math.max(0, Math.min(maximum, target))); } }}>
      {props.source && waveform.peaks.length ? <><TimelineWaveformCanvas peaks={waveform.peaks} scrollLeft={0} viewportWidth={width} contentWidth={width} /><i style={{ left: `${duration ? Math.min(100, position / duration * 100) : 0}%` }} /></> : <span>{waveform.error ?? (props.source ? '正在读取波形…' : '')}</span>}
    </div>
    <div className="waveform-ruler">{Array.from({ length: 5 }, (_, index) => <span key={index}>{formatPosition(duration * index / 4)}</span>)}</div>
    <small>{preview === null ? '音频时间线 · 点击或拖动定位' : `定位 ${formatPosition(preview)}`}</small>
  </section>;
}

function formatPosition(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
