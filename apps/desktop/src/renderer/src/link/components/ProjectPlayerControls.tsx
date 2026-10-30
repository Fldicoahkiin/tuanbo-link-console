import { Button } from '../ui/Button';
import { Play, Pause, Square, SkipBack, SkipForward, RotateCcw, Music2 } from 'lucide-react';
import { playlistItems, type InternalPlayerState } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import type { RemoteNativeProgramPlayer } from '../runtime/remote-native-program-player';
import type { PlayerControlState, PlayerViewStore } from '../stores/player-view-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';

import { ImportPlayerMusic } from './ImportPlayerMusic';
import { PlayerStatusDetails } from './PlayerStatusDetails';

/** `engine` names the audio engine this player uses, for the operator. */
export type ProjectPlayer = { controller: RemoteNativeProgramPlayer | null; state: PlayerControlState; view: PlayerViewStore; engine: string };
type SetupProps = { locked: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; playlistId: string };
export function ProjectPlayerSetup({ locked, notify, onBusy, playlistId }: SetupProps): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  if (!project) return <></>;
  return <div className="project-player-setup"><ImportPlayerMusic disabled={locked} notify={notify} onBusy={onBusy} playlistId={playlistId} /></div>;
}
export function ProjectPlayerTransport({ controller, state, engine, selectedItem }: ProjectPlayer & { selectedItem?: RundownItem | null | undefined }): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  const reason = useRuntimeStore((value) => value.reason);
  const items = project ? playlistItems(project, state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio) : [];
  const active = state.status === 'playing' || state.status === 'paused';
  const selected = active ? project?.rundown.find(item => item.id === state.itemId) : selectedItem ?? items.find(item => item.id === state.itemId);
  const target = selected?.enabled && selected.referenceAudio ? selected : items[0];
  const unavailable = !controller ? '播放器还没准备好' : state.status === 'preparing' ? '正在准备音频，点“停止”可以取消'
    : !active && !target ? '当前节目和播放列表里没有可以播放的音频' : null;
  const next = state.endAction === 'loop' ? selected : state.endAction === 'next' ? items[items.findIndex((item) => item.id === state.itemId) + 1] : undefined;
  return (
      <section className={`player-transport panel status-${state.status}`} aria-label="节目播放控制">
        <div className="home-section-heading"><h2>播放主控</h2><span>音乐 · 画面 · 灯光</span></div>
        <div className="player-now"><div className="player-track-icon"><Music2 /></div><div>{state.fault ? <small className="player-fault" role="alert" title={state.fault}>{statusLabel(state.status)} · 输出出错</small> : <small title={state.error ?? reason ?? undefined}>{state.status === 'preparing' && state.preparation ? `准备中 · ${state.preparation}` : statusLabel(state.status)}</small>}<h2>{selected?.title ?? '未播放'}</h2></div><span className="player-next"><small>{state.itemId ? '接下来' : '就绪'}</small><strong title={next?.title}>{state.itemId ? next?.title ?? '播完停止' : `${items.length} 首歌曲`}</strong></span><PlayerStatusDetails error={state.error} errorTitle={state.errorTitle} notice={state.notice} fault={state.fault ?? null} engine={engine} /></div>
        <div className="player-buttons">
          <button aria-label="上一首" title="上一首" disabled={!controller || !items.length} onClick={() => void controller?.skip(-1)}><SkipBack /></button>
          <Button className="primary-button" title={unavailable ?? (state.status === 'playing' ? '暂停播放' : state.status === 'paused' ? '继续播放' : `播放 ${target?.title ?? ''}`)} loading={state.status === 'preparing'} disabled={unavailable !== null} onClick={() => {
            if (state.status === 'playing') void controller?.pause();
            else if (state.status === 'paused') void controller?.resume();
            else if (target) void controller?.play(target.id);
          }}>{state.status === 'playing' ? <Pause /> : <Play />}{state.status === 'playing' ? '暂停' : state.status === 'paused' ? '继续' : '播放'}</Button>
          <button aria-label="停止播放" title="停止播放" className="player-stop" disabled={!controller} onClick={() => void controller?.stop()}><Square /><span>停止</span></button>
          <button aria-label="重播当前歌曲" title="重播当前歌曲" disabled={!controller || !state.itemId} onClick={() => { if (state.itemId) void controller?.play(state.itemId); }}><RotateCcw /></button>
          <button aria-label="下一首" title="下一首" disabled={!controller || !items.length} onClick={() => void controller?.skip(1)}><SkipForward /></button>
        </div>
        <div className="player-options"><label className="player-end-action"><span>播放方式</span><select aria-label="歌曲结束动作" value={state.endAction} onChange={(event) => controller?.setEndAction(event.currentTarget.value === 'pause' ? 'pause' : event.currentTarget.value === 'loop' ? 'loop' : event.currentTarget.value === 'stop' ? 'stop' : 'next')}><option value="next">顺序连播</option><option value="stop">播完停止</option><option value="pause">播完暂停</option><option value="loop">单曲循环</option></select></label>
          <label className="player-volume" title="只影响这次播放。要固定每首歌的音量，请在音频卡片上设置">临时音量 {Math.round(state.volume)}% <input aria-label="播放音量" type="range" min={0} max={100} disabled={!controller || !state.itemId} value={state.volume} onChange={(event) => controller?.setVolume(Number(event.currentTarget.value))} /></label>
          <div className="player-fades"><button disabled={!controller} onClick={() => controller?.fade(false)}>淡入</button><button disabled={!controller} onClick={() => controller?.fade(true)}>淡出</button><button disabled={!controller} aria-label="重置播放状态" title="停止并重置播放记录" onClick={() => void controller?.reset()}><RotateCcw /></button></div>
        </div>

      </section>
  );
}

function statusLabel(status: InternalPlayerState['status']): string { return ({ stopped: '已停止', preparing: '准备中', playing: '播放中', paused: '已暂停', error: '需要处理' })[status]; }

