import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { MtcFrameRate } from '@tb/schema';
import { formatTimelineTimecode } from './timeline-geometry';
import { displayCueNumber } from './cue-marker-layout';

export function CueClusterPopover({ entries, x, y, frameRate, onSelect, onClose }: {
  entries: { id: string; cue: string; ms: number }[]; x: number; y: number; frameRate: MtcFrameRate;
  onSelect: (id: string) => void; onClose: () => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>('button[data-cue-choice]')?.focus();
    const dismiss = (event: PointerEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }
      else if (event.target instanceof Node && !root.current?.contains(event.target)) onClose();
    };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', dismiss);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', dismiss); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, [onClose]);
  return createPortal(<div ref={root} className="cue-cluster-popover" role="dialog" aria-label="密集 Cue" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 286)), top: Math.max(8, Math.min(y, window.innerHeight - Math.min(300, entries.length * 34 + 48) - 8)) }} onPointerDown={event => event.stopPropagation()}>
    <header><span>{entries.length} 个 Cue · 选择后单独编辑</span><button aria-label="关闭密集 Cue" onClick={onClose}><X /></button></header>
    {entries.map(entry => <button key={entry.id} data-cue-choice aria-label={`选择 Cue ${displayCueNumber(entry.cue)}`} onClick={() => onSelect(entry.id)}><strong>{displayCueNumber(entry.cue)}</strong><time>{formatTimelineTimecode(entry.ms, frameRate)}</time></button>)}
  </div>, document.body);
}
