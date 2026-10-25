import { TriangleAlert } from 'lucide-react';
import type { LinkProject, RundownItem } from '@tb/schema';
import { TimelineIconMenu } from './TimelineIconMenu';
import { SongLightingState, songLightingView } from './SongLightingState';
import { SongMtcStart } from './SongMtcStart';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import '../lighting-output-control.css';

/** Beside transport: the song's MTC start and lighting state. Formal playback only sends timecode and the
 * console runs each song's own Timecode show, so there is no output mode to choose here. */
export function LightingOutputControl({ project, item }: { project: LinkProject; item: RundownItem }): JSX.Element {
  const view = songLightingView(project, item);
  return <span className="lighting-output-route"><SongMtcStart project={project} item={item} /><SongLightingState project={project} item={item} />{view.state === 'attention' || view.state === 'unconfirmed' ? <span className="lighting-output-notice">
    <TimelineIconMenu key={view.state} icon={TriangleAlert} label="灯光输出提示">
      <strong>{view.label}</strong>
      <p>{view.detail}</p>
      <button type="button" onClick={() => useMa2ReadStore.setState({ browserOpen: true })}>核对控台时间线</button>
    </TimelineIconMenu>
  </span> : null}</span>;
}
