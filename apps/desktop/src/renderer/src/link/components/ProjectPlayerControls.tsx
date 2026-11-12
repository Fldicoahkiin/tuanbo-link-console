import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ListRestart, Pause, Play, RotateCcw, SkipBack, SkipForward, Square, Volume2 } from 'lucide-react';
import { savedSongVolume, setItemVolumeCommand, SongVolumeGesture, type InternalPlayerState, type SongVolumeStep } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import type { RemoteNativeProgramPlayer } from '../runtime/remote-native-program-player';
import type { ProjectPlayer } from '../runtime/project-player';
import type { PlayerControlState } from '../stores/player-view-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { Button, IconButton, Select } from '../ui';
import { PlayerStatusDetails } from './PlayerStatusDetails';
import { songVolumeView } from '../view-models/song-volume';
import { homePlayButton, pressHomePlayButton } from './play-buttons';
import { useKeyCommands } from '../keys/useKeyCommands';

export type { ProjectPlayer };

type EndAction = InternalPlayerState['endAction'];
const endActions: ReadonlyArray<readonly [EndAction, string]> = [['next', '顺序连播'], ['stop', '播完停止'], ['pause', '播完暂停'], ['loop', '单曲循环']];
const isEndAction = (value: string): value is EndAction => endActions.some(([action]) => action === value);

/**
 * The home page player (2026-10-30 rework): what is playing and what comes next, the song's waveform
 * (`children`), then the transport on the left and the playing options on the right. `actions` sit at
 * the right of the heading, before the status details.
 */
export function ProjectPlayerTransport({ controller, state, engine, selectedItem, onScreen = false, notify, actions, children }: ProjectPlayer & {
  selectedItem?: RundownItem | null | undefined;
  /** The home page is showing, so Space presses this play button (0.5.9). */
  onScreen?: boolean;
  /** Tells the operator why Space did nothing, such as a song without audio. */
  notify: (message: string) => void;
  actions?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  const reason = useRuntimeStore((value) => value.reason);
  const button = homePlayButton(project, state, selectedItem, controller !== null);
  const { items, selected, target, unavailable } = button;
  const press = (): void => pressHomePlayButton(button, state.status,
    { pause: () => void controller?.pause(), resume: () => void controller?.resume(), play: itemId => void controller?.play(itemId) }, notify);
  // While the home page shows, Space presses this button (0.5.9).
  useKeyCommands('home', { 'transport.playPause': press }, () => onScreen);
  const next = state.endAction === 'loop' ? selected : state.endAction === 'next' ? items[items.findIndex((item) => item.id === state.itemId) + 1] : undefined;
  const stateText = state.status === 'preparing' && state.preparation ? `准备中 · ${state.preparation}` : statusLabel(state.status);
  return <section className="home-player" data-mode="internal" data-status={state.status} aria-label="节目播放控制">
    <header className="home-player-heading">
      {state.fault
        ? <span className="home-player-state" data-tone="error" role="alert" title={state.fault}>{statusLabel(state.status)} · 输出出错</span>
        : <span className="home-player-state" data-tone={stateTone(state.status)} title={state.error ?? reason ?? undefined}>{stateText}</span>}
      <h2 className="home-player-title" title={selected?.title}>{selected?.title ?? '未播放'}</h2>
      <span className="home-player-next" title={next?.title}>
        <small>{state.itemId ? '接下来' : '就绪'}</small>
        <strong>{state.itemId ? next?.title ?? '播完停止' : `${items.length} 首歌曲`}</strong>
      </span>
      <span className="home-player-actions">
        {actions}
        <PlayerStatusDetails error={state.error} errorTitle={state.errorTitle} notice={state.notice} fault={state.fault ?? null} engine={engine} />
      </span>
    </header>
    {children}
    <div className="home-player-controls">
      <div className="home-transport" role="group" aria-label="播放控制">
        <IconButton variant="secondary" label="上一首" icon={SkipBack} disabled={!controller || !items.length} onClick={() => void controller?.skip(-1)} />
        <Button variant="primary" className="home-player-play" icon={state.status === 'playing' ? Pause : Play}
          title={unavailable ?? (state.status === 'playing' ? '暂停播放' : state.status === 'paused' ? '继续播放' : `播放 ${target?.title ?? ''}`)}
          loading={state.status === 'preparing'} disabled={unavailable !== null} onClick={press}>{state.status === 'playing' ? '暂停' : state.status === 'paused' ? '继续' : '播放'}</Button>
        <Button variant="secondary" className="home-player-stop" icon={Square} aria-label="停止播放" title="停止播放" disabled={!controller} onClick={() => void controller?.stop()}>停止</Button>
        <IconButton variant="secondary" label="重播当前歌曲" icon={RotateCcw} disabled={!controller || !state.itemId} onClick={() => { if (state.itemId) void controller?.play(state.itemId); }} />
        <IconButton variant="secondary" label="下一首" icon={SkipForward} disabled={!controller || !items.length} onClick={() => void controller?.skip(1)} />
      </div>
      <div className="home-player-options">
        <Select width="auto" aria-label="歌曲结束动作" title="一首歌播完以后怎么做" value={state.endAction} onChange={(event) => {
          const value = event.currentTarget.value;
          if (isEndAction(value)) controller?.setEndAction(value);
        }}>{endActions.map(([action, label]) => <option key={action} value={action}>{label}</option>)}</Select>
        <SongVolumeSlider controller={controller} state={state} selectedItem={selectedItem} notify={notify} />
        <span className="home-fades">
          <Button variant="secondary" size="sm" disabled={!controller} onClick={() => controller?.fade(false)}>淡入</Button>
          <Button variant="secondary" size="sm" disabled={!controller} onClick={() => controller?.fade(true)}>淡出</Button>
          <IconButton size="sm" label="重置播放状态" title="停止并重置播放记录" icon={ListRestart} disabled={!controller} onClick={() => void controller?.reset()} />
        </span>
      </div>
    </div>
  </section>;
}

/**
 * The player-bar slider is the song's own volume, saved in the project (2026-11-09, docs/SONG_VOLUME.md): the song in
 * the player when one is, otherwise the selected song. A drag is heard at once and saved when let go, as one undo step;
 * the program takes the saved volume with the project's next version. A MIDI CC7 volume holds this run only and is shown
 * next to it.
 */
function SongVolumeSlider({ controller, state, selectedItem, notify }: {
  controller: RemoteNativeProgramPlayer | null; state: PlayerControlState; selectedItem: RundownItem | null | undefined; notify: (message: string) => void;
}): JSX.Element {
  const project = useDocumentStore(value => value.project);
  const { item, playing, saved, override } = songVolumeView(project, state, selectedItem?.id ?? null);
  const [gesture] = useState(() => new SongVolumeGesture());
  const [preview, setPreview] = useState<{ itemId: string; volume: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = preview && preview.itemId === item?.id ? preview.volume : saved;
  const apply = (step: SongVolumeStep): void => {
    switch (step.kind) {
      case 'none': setPreview(null); return;
      case 'preview':
        setPreview({ itemId: step.itemId, volume: step.volume });
        // Heard only from the song in the player; the selected song that is not playing is only saved on release.
        if (step.itemId === playing) controller?.previewVolume(step.itemId, step.volume);
        return;
      case 'commit': {
        setPreview(null);
        const song = useDocumentStore.getState().project?.rundown.find(entry => entry.id === step.itemId);
        if (!song || savedSongVolume(song) === step.volume) return;
        try { useDocumentStore.getState().execute(setItemVolumeCommand(step.itemId, step.volume, step.gestureId)); }
        catch (error) {
          // Not saved: the song in the player goes back to the volume it has.
          if (step.itemId === playing) controller?.previewVolume(step.itemId, savedSongVolume(song));
          notify(`音量没有保存：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };
  const release = useRef<() => void>(() => undefined); release.current = () => apply(gesture.release());
  useEffect(() => {
    // The change event is the release of a drag in Chromium; pointerup alone misses a release outside the window.
    const element = input.current, listener = (): void => release.current();
    element?.addEventListener('change', listener);
    return () => element?.removeEventListener('change', listener);
  }, []);
  return <label className="home-volume" title="这首歌的音量，松手后保存进工程">
    <Volume2 aria-hidden="true" />
    <input ref={input} aria-label={item ? `「${item.title}」的音量` : '歌曲音量'} type="range" min={0} max={100} disabled={!item?.referenceAudio} value={shown}
      onFocus={() => gesture.focus()}
      onPointerDown={() => { if (item) gesture.press(item.id); }}
      onPointerUp={() => release.current()} onPointerCancel={() => release.current()}
      onChange={(event) => { if (item) apply(gesture.input(item.id, Number(event.currentTarget.value))); }} />
    <output>{Math.round(shown)}%</output>
    {override !== null ? <span className="home-volume-midi" title="调音台推子（MIDI CC7）定的音量，只用于这一遍，换歌或停止后回到这首歌保存的音量">MIDI 临时 {Math.round(override)}%</span> : null}
  </label>;
}

function statusLabel(status: InternalPlayerState['status']): string { return ({ stopped: '已停止', preparing: '准备中', playing: '播放中', paused: '已暂停', error: '需要处理' })[status]; }
function stateTone(status: InternalPlayerState['status']): 'idle' | 'busy' | 'live' | 'held' | 'error' {
  return ({ stopped: 'idle', preparing: 'busy', playing: 'live', paused: 'held', error: 'error' } as const)[status];
}
