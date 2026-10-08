import { AudioLines, Layers3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';
import { MusicBeatPanel, type MusicBeatPanelProps } from './MusicBeatPanel';

export type LightingTimelineDisplay = { sections: boolean; markers: boolean; rawAnalysis: boolean };
export type MusicAnalysisHost = { host: HTMLDivElement | null; open: boolean; onOpen: () => void; onClose: () => void };

export function LightingTimelineControls(props: Omit<MusicBeatPanelProps, 'onClose'> & {
  analysisPanel: MusicAnalysisHost | undefined;
  display: LightingTimelineDisplay;
  onDisplayChange: (value: LightingTimelineDisplay) => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const closeDisplayMenus = (): void => {
    for (const menu of root.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? []) menu.open = false;
  };
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof PointerEvent && event.target instanceof Node && root.current?.contains(event.target)) return;
      for (const menu of root.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? []) menu.open = false;
    };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', dismiss);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', dismiss); };
  }, []);
  const job = props.analysis.job;
  const bpm = props.beats.data?.bpm;
  const status = props.beats.busy ? '分析中' : job?.state === 'failed' ? '失败' : props.beats.data?.beatsPerBar ? `每小节 ${props.beats.data.beatsPerBar} 拍` : '';
  return <div ref={root} className="lighting-timeline-controls" aria-label="音乐与时间线显示">
    <button type="button" className="music-analysis-button" aria-label="音乐分析" aria-pressed={props.analysisPanel?.open ?? false} onClick={() => { closeDisplayMenus(); props.analysisPanel?.onOpen(); }}><AudioLines /><strong className="music-bpm" title="音乐分析识别的速度">{bpm ?? '—'} BPM</strong><span>音乐识别</span>{status ? <small>{status}</small> : null}</button>
    {props.analysisPanel?.host && props.analysisPanel.open ? createPortal(<MusicBeatPanel {...props} onClose={props.analysisPanel.onClose} />, props.analysisPanel.host) : null}
    <details className="timeline-display-options" name="lighting-timeline-options"><summary aria-label="时间线显示" title="时间线显示"><Layers3 /><span>显示</span></summary><div className="lighting-timeline-popover">{([['sections', '歌曲段落'], ['markers', '音乐标记'], ['rawAnalysis', '节拍刻度']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={props.display[key]} onChange={event => props.onDisplayChange({ ...props.display, [key]: event.currentTarget.checked })} />{label}</label>)}</div></details>
  </div>;
}
