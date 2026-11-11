import { Layers3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { MusicBeatPanel, type MusicBeatPanelProps } from './MusicBeatPanel';
import { MusicAnalysisButton } from './MusicAnalysisButton';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Switch } from '../ui';

export type LightingTimelineDisplay = { sections: boolean; markers: boolean; rawAnalysis: boolean };
/** Where the song's music panel opens: a place on the page beside the timeline, owned by the workspace. */
export type MusicAnalysisHost = { host: HTMLDivElement | null; open: boolean; onOpen: () => void; onClose: () => void };

/** The music panel of the song, opened by the 音乐识别 button into the workspace's place for it (both pages). */
export function MusicAnalysisPanelPortal(props: Omit<MusicBeatPanelProps, 'onClose'> & { analysisPanel: MusicAnalysisHost | undefined }): JSX.Element | null {
  const { analysisPanel, ...panel } = props;
  return analysisPanel?.host && analysisPanel.open ? createPortal(<MusicBeatPanel {...panel} onClose={analysisPanel.onClose} />, analysisPanel.host) : null;
}

export function LightingTimelineControls(props: Omit<MusicBeatPanelProps, 'onClose'> & {
  analysisPanel: MusicAnalysisHost | undefined;
  display: LightingTimelineDisplay;
  onDisplayChange: (value: LightingTimelineDisplay) => void;
}): JSX.Element {
  const { display, onDisplayChange, ...panel } = props;
  return <div className="lighting-timeline-controls" aria-label="音乐与时间线显示">
    <MusicAnalysisButton beats={props.beats} analysis={props.analysis} playhead={props.playhead} open={props.analysisPanel?.open ?? false} onOpen={() => props.analysisPanel?.onOpen()} />
    <MusicAnalysisPanelPortal {...panel} />
    <TimelinePanelButton label="时间线显示" icon={Layers3}><div className="timeline-display-panel">{([['sections', '歌曲段落'], ['markers', '音乐标记'], ['rawAnalysis', '节拍刻度']] as const).map(([key, label]) => <Switch key={key} label={label} checked={display[key]} onChange={event => onDisplayChange({ ...display, [key]: event.currentTarget.checked })} />)}</div></TimelinePanelButton>
  </div>;
}
