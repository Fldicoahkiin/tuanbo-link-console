import { FileAudio } from 'lucide-react';
import { mediaTimecodeAt, programTimeOrigin, setPlaybackSourceCommand, timecodeToMilliseconds } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { usePlayerClock } from '../usePlayerClock';
import { AudioSpectrum } from './AudioSpectrum';
import { P1TimeMonitor } from './P1TimeMonitor';
import { PlayerWaveformTimeline } from './PlayerWaveformTimeline';
import { ProjectPlayerTransport, type ProjectPlayer } from './ProjectPlayerControls';
import { formatTimecode } from './media-utils';

/** Only this monitor subscribes to continuous playback position. The program
 * library and application navigation have no dependency on clock ticks. */
export function ProjectPlaybackMonitor({ project, player, selectedItem, currentItemId, projectPath, previewUrl, visible }: {
  project: LinkProject; player: ProjectPlayer; selectedItem: RundownItem | null | undefined; currentItemId: string | null;
  projectPath: string | null; previewUrl: string | null; busy: boolean; visible: boolean;
}): JSX.Element {
  const clock = usePlayerClock(player.view, visible);
  const timecode = useRuntimeStore(state => visible ? state.timecode : null);
  const execute = useDocumentStore(state => state.execute);
  const internal = project.playbackSource === 'internal';
  let selectedOrigin: number | null = null;
  try { if (selectedItem) selectedOrigin = programTimeOrigin(selectedItem) + (selectedItem.playback?.startMs ?? 0); }
  catch { selectedOrigin = null; }
  const mtcPositionMs = player.state.status === 'stopped'
    ? selectedOrigin
    : player.state.status === 'preparing' ? null : clock.mtcPositionMs;
  const outputTimecode = !internal ? timecode ? formatTimecode(timecode) : '—' : mtcPositionMs !== null && mtcPositionMs < 86_400_000
    ? formatTimecode(mediaTimecodeAt(mtcPositionMs, project.timebase.frameRate)) : '—';
  const monitorItem = internal && player.state.status !== 'stopped' ? project.rundown.find(item => item.id === player.state.itemId) : selectedItem;
  const currentMilliseconds = internal ? clock.positionMs : timecode ? timecodeToMilliseconds(timecode, project.timebase.frameRate) : 0;
  const monitorDuration = internal && player.state.status !== 'stopped' ? player.state.durationMs : monitorItem?.referenceAudio?.durationMs ?? 0;
  return <section className={`p1-monitor-deck ${internal ? 'has-player' : ''}`} aria-label="播放与监看">
    <section className={`unified-player ${internal ? 'internal-mode' : 'following-mode'}`} aria-label="播放与音频时间线">
      {internal ? <ProjectPlayerTransport {...player} selectedItem={selectedItem} controller={player.controller} /> : <div className="p1-audio-monitor">
        <div className="p1-monitor-caption"><strong>{selectedItem?.title ?? '未选择'}</strong></div>
        {previewUrl ? <audio controls src={previewUrl} /> : <div className="p1-monitor-empty"><FileAudio /><span>未添加音频</span></div>}
        <div className="player-mode-note"><span>P1 跟随</span><button onClick={() => execute(setPlaybackSourceCommand('internal'))}>切换为本软件播放</button></div>
      </div>}
      <PlayerWaveformTimeline enabled={internal && !!player.controller && ['playing', 'paused'].includes(player.state.status)} onSeek={positionMs => void player.controller?.seek(positionMs)} source={projectPath && previewUrl && selectedItem?.referenceAudio ? { projectPath, url: previewUrl, sha256: selectedItem.referenceAudio.sha256, durationMs: selectedItem.referenceAudio.durationMs } : null} positionMs={selectedItem?.id === currentItemId ? currentMilliseconds : 0} />
    </section>
    <section className="home-spectrum-monitor" aria-label="实时音频频谱"><AudioSpectrum {...player} /><small>实时频谱</small></section>
    <P1TimeMonitor player={player} title={monitorItem?.title ?? '未选择节目'} positionMs={currentMilliseconds} durationMs={Math.max(currentMilliseconds, monitorDuration)} frameRate={project.timebase.frameRate} internal={internal} outputTimecode={outputTimecode} />
  </section>;
}
