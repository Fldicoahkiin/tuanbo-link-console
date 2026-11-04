import { ListTree, TriangleAlert } from 'lucide-react';
import type { LinkProject, RundownItem } from '@tb/schema';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Button } from '../ui';
import { SongMtcStart, songMtcView } from './SongMtcStart';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import '../lighting-output-control.css';

/** Beside transport: the song's MTC start, green when a console show runs with it. Formal playback only sends
 * timecode and the console runs the show that starts there, so there is no output mode to choose here.
 * The badge opens the console timeline page, which lists every console Timecode show and the song it runs
 * with (2026-11-04: the page was only reachable from a warning or deep in the settings). */
export function LightingOutputControl({ project, item }: { project: LinkProject; item: RundownItem }): JSX.Element {
  const view = songMtcView(project, item);
  const browserOpen = useMa2ReadStore(state => state.browserOpen);
  return <span className="lighting-output-route">
    <button type="button" className="lighting-output-timelines" aria-pressed={browserOpen} aria-label={`${view.text}，查看控台时间线`}
      title={`${view.detail}。点一下${browserOpen ? '回到灯光素材' : '查看控台时间线'}`} onClick={() => useMa2ReadStore.setState({ browserOpen: !browserOpen })}>
      <SongMtcStart project={project} item={item} tooltip={false} /><ListTree aria-hidden="true" />
    </button>
    {view.state === 'warning' ? <span className="lighting-output-notice">
      <TimelinePanelButton icon={TriangleAlert} tone="warning" label="灯光提示">
        <p className="timeline-panel-note">{view.detail}</p>
        <Button variant="secondary" onClick={() => useMa2ReadStore.setState({ browserOpen: true })}>查看控台时间线</Button>
      </TimelinePanelButton>
    </span> : null}
  </span>;
}
