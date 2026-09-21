import { useEffect, useMemo, useRef } from 'react';
import type { MtcFrameRate } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { cueEventEntries } from './cue-event-view';
import { formatTimelineTimecode } from './timeline-geometry';

export function CueEventList({ lighting, frameRate, onSeek }: { lighting: LightingTimelineProps; frameRate: MtcFrameRate; onSeek: (ms: number) => void }): JSX.Element {
  const entries = useMemo(() => cueEventEntries(lighting.document), [lighting.document]);
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }); }, [lighting.selectedEventId]);
  return <aside className="cue-event-list" aria-label="Cue 时间表">
    <header><strong>Cue</strong><strong>时间码</strong><strong>执行器</strong></header>
    <div className="cue-event-list-body">
      {entries.map(entry => <button key={entry.id} ref={lighting.selectedEventId === entry.id ? selected : undefined} className="cue-event-row" aria-pressed={lighting.selectedEventId === entry.id} title={`${entry.track.name} · ${entry.label}`} onClick={() => { lighting.onSelectEvent?.(entry.track.id, entry.clip.id, entry.id); onSeek(entry.ms); }}>
        <strong>{entry.cue}</strong><time>{formatTimelineTimecode(entry.ms, frameRate)}</time><span>{entry.executor}</span>
      </button>)}
      {!entries.length ? <p>在波形上右键添加 Cue</p> : null}
    </div>
    <footer>{entries.length} 个 Cue · {frameRate} fps</footer>
  </aside>;
}
