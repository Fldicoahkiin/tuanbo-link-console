import { Cable, Network, Timer, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import type { LightingDocument, LinkProject, RundownItem } from '@tb/schema';
import { TimelineIconMenu } from './TimelineIconMenu';
import { SongLightingState, songLightingView } from './SongLightingState';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import '../lighting-output-control.css';

/** Beside transport: the song's lighting state. Formal playback only sends timecode
 * (2026-10-23); the stored mode still selects how editing syncs and auditions, and
 * how a P1-follow workbench previews. Editing it never switches a running output. */
export function LightingOutputControl({ project, item, document, locked, onChange }: {
  project: LinkProject; item: RundownItem; document: LightingDocument; locked: boolean;
  onChange: (document: LightingDocument, label: string) => void;
}): JSX.Element {
  const Icon = document.outputMode === 'timecode' ? Timer : document.outputMode === 'network' ? Network : Cable;
  const view = songLightingView(project, item);
  // Only a P1-follow workbench previews with its own audio along the stored mode.
  const preview = project.playbackSource !== 'internal';
  const nativeTimeline = Boolean(document.ma2Bindings?.some(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode'));
  const needsNetwork = useMemo(() => {
    if (!preview || nativeTimeline || document.outputMode === 'network') return false;
    const solo = document.tracks.some(track => track.solo && !track.muted);
    return document.tracks.some(track => !track.muted && (!solo || track.solo)
      && track.clips.some(clip => !clip.muted && clip.events.some(event => event.kind === 'ma2'
        && (document.outputMode === 'timecode' || !event.executor))));
  }, [preview, document.tracks, document.outputMode, nativeTimeline]);
  return <span className="lighting-output-route"><SongLightingState project={project} item={item} /><label className="lighting-output-control" data-mode={document.outputMode}
    title={locked ? '播放期间保持不变；停止后可切换' : '只影响编灯时的同步与试听；演出播放始终发送时间码，由控台跑灯'}>
    <Icon size={15} aria-hidden="true" /><span>编灯</span>
    <select aria-label="灯光输出方式" disabled={locked} value={document.outputMode} onChange={event => {
      const mode = event.currentTarget.value;
      if (mode === 'timecode' || mode === 'network' || mode === 'direct') onChange({ ...document, outputMode: mode }, '修改灯光输出方式');
    }}>
      <option value="timecode">时间码跟随</option><option value="network">网络直控</option><option value="direct">MIDI 触发</option>
    </select>
  </label>{view.state === 'attention' || view.state === 'unconfirmed' ? <span className="lighting-output-notice">
    <TimelineIconMenu key={view.state} icon={TriangleAlert} label="灯光输出提示">
      <strong>{view.label}</strong>
      <p>{view.detail}</p>
      <button type="button" onClick={() => useMa2ReadStore.setState({ browserOpen: true })}>核对控台时间线</button>
    </TimelineIconMenu>
  </span> : preview && nativeTimeline && document.outputMode !== 'timecode' ? <span className="lighting-output-notice">
    <TimelineIconMenu key={document.outputMode} icon={TriangleAlert} label="灯光输出提示">
      <strong>此工程需要时间码跟随</strong>
      <p>工程保留了控台原生事件，网络和 MIDI 直控无法完整预听。可以继续编辑；预听前请切回时间码跟随。</p>
      <button type="button" disabled={locked} onClick={() => onChange({ ...document, outputMode: 'timecode' }, '使用时间码播放原生灯光')}>使用时间码跟随</button>
    </TimelineIconMenu>
  </span> : needsNetwork ? <span className="lighting-output-notice">
    <TimelineIconMenu key={document.outputMode} icon={TriangleAlert} label="灯光输出提示">
    <strong>本地 Cue 不发送</strong>
    <p>{document.outputMode === 'timecode' ? '时间码跟随用于控台原生时间线。预听软件中编排的 Cue，请选择网络直控。' : '当前 Cue 含序列池引用，MIDI 无法直接触发。请选择网络直控。'}</p>
    <button type="button" disabled={locked} title={locked ? '停止播放后可切换' : '由当前歌曲时间线调用 MA2 Cue'}
      onClick={() => onChange({ ...document, outputMode: 'network' }, '使用网络直控播放灯光')}>使用网络直控</button>
    </TimelineIconMenu>
  </span> : null}</span>;
}
