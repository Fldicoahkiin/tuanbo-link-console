import { useEffect, type ReactNode } from 'react';
import { ListRestart, Pause, Play, RotateCcw, SkipBack, SkipForward, Square, Volume2 } from 'lucide-react';
import type { InternalPlayerState } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import type { RemoteNativeProgramPlayer } from '../runtime/remote-native-program-player';
import type { PlayerControlState, PlayerViewStore } from '../stores/player-view-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { Button, IconButton, Select } from '../ui';
import { registerPlayButton } from '../playback-keys';
import { PlayerStatusDetails } from './PlayerStatusDetails';
import { homePlayButton, homePlayPress } from './play-buttons';

/** `engine` names the audio engine this player uses, for the operator. `outdated`: the background program plays
 * another version of the project than this window opened it with, taken over after a window reload. */
export type ProjectPlayer = { controller: RemoteNativeProgramPlayer | null; state: PlayerControlState; view: PlayerViewStore; engine: string; outdated: boolean };

type EndAction = InternalPlayerState['endAction'];
const endActions: ReadonlyArray<readonly [EndAction, string]> = [['next', '顺序连播'], ['stop', '播完停止'], ['pause', '播完暂停'], ['loop', '单曲循环']];
const isEndAction = (value: string): value is EndAction => endActions.some(([action]) => action === value);

/**
 * The home page player (2026-10-30 rework): what is playing and what comes next, the song's waveform
 * (`children`), then the transport on the left and the playing options on the right. `actions` sit at
 * the right of the heading, before the status details.
 */
export function ProjectPlayerTransport({ controller, state, engine, selectedItem, onScreen = false, actions, children }: ProjectPlayer & {
  selectedItem?: RundownItem | null | undefined;
  /** The home page is showing, so Space presses this play button (0.5.9). */
  onScreen?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  const reason = useRuntimeStore((value) => value.reason);
  const button = homePlayButton(project, state, selectedItem, controller !== null);
  const { items, selected, target, unavailable } = button;
  const press = (): void => {
    const request = homePlayPress(button, state.status);
    if (request?.kind === 'pause') void controller?.pause();
    else if (request?.kind === 'resume') void controller?.resume();
    else if (request?.kind === 'play') void controller?.play(request.itemId);
  };
  useEffect(() => onScreen ? registerPlayButton(press) : undefined);
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
        <label className="home-volume" title="临时音量，只影响这次播放。要固定每首歌的音量，请在右侧节目属性里设置">
          <Volume2 aria-hidden="true" />
          <input aria-label="播放音量" type="range" min={0} max={100} disabled={!controller || !state.itemId} value={state.volume} onChange={(event) => controller?.setVolume(Number(event.currentTarget.value))} />
          <output>{Math.round(state.volume)}%</output>
        </label>
        <span className="home-fades">
          <Button variant="secondary" size="sm" disabled={!controller} onClick={() => controller?.fade(false)}>淡入</Button>
          <Button variant="secondary" size="sm" disabled={!controller} onClick={() => controller?.fade(true)}>淡出</Button>
          <IconButton size="sm" label="重置播放状态" title="停止并重置播放记录" icon={ListRestart} disabled={!controller} onClick={() => void controller?.reset()} />
        </span>
      </div>
    </div>
  </section>;
}

function statusLabel(status: InternalPlayerState['status']): string { return ({ stopped: '已停止', preparing: '准备中', playing: '播放中', paused: '已暂停', error: '需要处理' })[status]; }
function stateTone(status: InternalPlayerState['status']): 'idle' | 'busy' | 'live' | 'held' | 'error' {
  return ({ stopped: 'idle', preparing: 'busy', playing: 'live', paused: 'held', error: 'error' } as const)[status];
}
