import { AudioLines, FileAudio } from 'lucide-react';
import { mediaTimecodeAt, programTimeOrigin, setPlaybackSourceCommand, timecodeToMilliseconds } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { usePlayerClock } from '../usePlayerClock';
import { AudioSpectrum } from './AudioSpectrum';
import { P1TimeMonitor } from './P1TimeMonitor';
import { PlayerWaveformTimeline } from './PlayerWaveformTimeline';
import { useSongWaveformSource } from './ReferenceWaveform';
import { ProjectPlayerTransport, type ProjectPlayer } from './ProjectPlayerControls';
import { formatTimecode } from './media-utils';
import { Button, IconButton } from '../ui';
import { P1FollowResync, P1FollowStateChip } from './P1FollowControls';

/** Only this monitor subscribes to continuous playback position. The program
 * library and application navigation have no dependency on clock ticks.
 * 2026-10-30 rework: the player and the timecode come first and take only the height they need; the
 * spectrum is shown on request and the choice is remembered on this computer. */
export function ProjectPlaybackMonitor({ project, player, selectedItem, currentItemId, projectPath, previewUrl, visible, notify }: {
  project: LinkProject; player: ProjectPlayer; selectedItem: RundownItem | null | undefined; currentItemId: string | null;
  projectPath: string | null; previewUrl: string | null; busy: boolean; visible: boolean; notify: (message: string, tone?: 'info' | 'error') => void;
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
  const spectrum = useDisplayPreferences(state => state.homeSpectrum);
  const setSpectrum = useDisplayPreferences(state => state.setHomeSpectrum);
  const waveformSource = useSongWaveformSource(selectedItem?.referenceAudio, projectPath, previewUrl);
  const waveform = <PlayerWaveformTimeline enabled={internal && !!player.controller && ['playing', 'paused'].includes(player.state.status)} onSeek={positionMs => void player.controller?.seek(positionMs)} source={waveformSource} positionMs={selectedItem?.id === currentItemId ? currentMilliseconds : 0} />;
  const showSpectrum = internal && spectrum;
  return <section className="home-monitor" data-spectrum={showSpectrum} aria-label="播放与监看">
    {internal ? <ProjectPlayerTransport {...player} selectedItem={selectedItem} controller={player.controller} onScreen={visible} notify={notify}
      actions={<IconButton label={spectrum ? '收起频谱' : '显示频谱'} icon={AudioLines} aria-pressed={spectrum} onClick={() => setSpectrum(!spectrum)} />}>{waveform}</ProjectPlayerTransport>
      : <section className="home-player" data-mode="following" aria-label="P1 跟随播放">
        <header className="home-player-heading">
          <P1FollowStateChip />
          <h2 className="home-player-title" title={selectedItem?.title}>{selectedItem?.title ?? '未选择'}</h2>
          <span className="home-player-actions"><Button variant="secondary" size="sm" onClick={() => execute(setPlaybackSourceCommand('internal'))}>改由联动台播放</Button></span>
        </header>
        {waveform}
        <P1FollowResync notify={notify} />
        <div className="home-player-controls">
          {previewUrl ? <audio className="home-player-preview" controls src={previewUrl} aria-label="试听这首歌" /> : <p className="home-player-empty"><FileAudio aria-hidden="true" />{selectedItem ? '这首歌还没有音频，可以在右侧节目属性里点「更换音频」添加' : '先在节目单里选一首歌'}</p>}
        </div>
      </section>}
    {showSpectrum ? <section className="home-spectrum" aria-label="实时音频频谱"><AudioSpectrum {...player} /></section> : null}
    <P1TimeMonitor player={player} title={monitorItem?.title ?? '未选择节目'} positionMs={currentMilliseconds} durationMs={Math.max(currentMilliseconds, monitorDuration)} frameRate={project.timebase.frameRate} internal={internal} outputTimecode={outputTimecode} />
  </section>;
}
