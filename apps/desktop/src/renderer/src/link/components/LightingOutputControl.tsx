import { TriangleAlert } from 'lucide-react';
import type { LinkProject, RundownItem } from '@tb/schema';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Button } from '../ui';
import { SongMtcStart, songMtcView } from './SongMtcStart';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import '../lighting-output-control.css';

/** Beside transport: the song's MTC start, green when a console show runs with it. Formal playback only sends
 * timecode and the console runs the show that starts there, so there is no output mode to choose here. */
export function LightingOutputControl({ project, item }: { project: LinkProject; item: RundownItem }): JSX.Element {
  const view = songMtcView(project, item);
  return <span className="lighting-output-route"><SongMtcStart project={project} item={item} />{view.state === 'warning' ? <span className="lighting-output-notice">
    <TimelinePanelButton icon={TriangleAlert} tone="warning" label="灯光提示">
      <p className="timeline-panel-note">{view.detail}</p>
      <Button variant="secondary" onClick={() => useMa2ReadStore.setState({ browserOpen: true })}>查看控台时间线</Button>
    </TimelinePanelButton>
  </span> : null}</span>;
}
