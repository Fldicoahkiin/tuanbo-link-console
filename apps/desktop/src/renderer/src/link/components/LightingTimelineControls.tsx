import { AudioLines, Layers3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { MusicBeatPanel, type MusicBeatPanelProps } from './MusicBeatPanel';
import { musicSegmentAt } from '../view-models/music-segment-display';
import { musicAnalysisHeading } from '../view-models/music-analysis-display';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Switch } from '../ui';

export type LightingTimelineDisplay = { sections: boolean; markers: boolean; rawAnalysis: boolean };
export type MusicAnalysisHost = { host: HTMLDivElement | null; open: boolean; onOpen: () => void; onClose: () => void };

export function LightingTimelineControls(props: Omit<MusicBeatPanelProps, 'onClose'> & {
  analysisPanel: MusicAnalysisHost | undefined;
  display: LightingTimelineDisplay;
  onDisplayChange: (value: LightingTimelineDisplay) => void;
}): JSX.Element {
  const job = props.analysis.job;
  const current = musicSegmentAt(props.beats.points, props.playheadMs);
  const status = props.beats.busy ? '分析中' : job?.state === 'failed' ? '失败' : props.beats.data?.beatsPerBar ? `每小节 ${props.beats.data.beatsPerBar} 拍` : '';
  return <div className="lighting-timeline-controls" aria-label="音乐与时间线显示">
    <button type="button" className="music-analysis-button" aria-label="音乐分析" aria-pressed={props.analysisPanel?.open ?? false} onClick={() => props.analysisPanel?.onOpen()}><AudioLines /><strong className="music-bpm" title={job?.message || (current ? `${current.name} · 当前段落估算速度` : '打开查看识别状态')}>{musicAnalysisHeading(props.beats.data, current, job, props.analysis.submitting, props.analysis.error)}</strong><span>音乐识别</span>{status ? <small>{status}</small> : null}</button>
    {props.analysisPanel?.host && props.analysisPanel.open ? createPortal(<MusicBeatPanel {...props} onClose={props.analysisPanel.onClose} />, props.analysisPanel.host) : null}
    <TimelinePanelButton label="时间线显示" icon={Layers3}><div className="timeline-display-panel">{([['sections', '歌曲段落'], ['markers', '音乐标记'], ['rawAnalysis', '节拍刻度']] as const).map(([key, label]) => <Switch key={key} label={label} checked={props.display[key]} onChange={event => props.onDisplayChange({ ...props.display, [key]: event.currentTarget.checked })} />)}</div></TimelinePanelButton>
  </div>;
}
