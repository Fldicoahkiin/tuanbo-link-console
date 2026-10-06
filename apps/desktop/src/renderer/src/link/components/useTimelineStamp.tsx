import { useEffect, useState } from 'react';
import type { PlaybackClock } from '../../registry/playback-clock';
import { MapPinPlus, Layers3, TriangleAlert } from 'lucide-react';
import { TimelineIconMenu } from './TimelineIconMenu';
import { playbackFramesPerSecond } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { shortcutKey, shortcutLabel, useShortcutStore } from '../stores/shortcut-store';
import type { LightingTimelineProps } from './LightingTimeline';
import { stampTimeline } from './timeline-stamp';

type Props = { lighting: LightingTimelineProps | undefined; playheadMs: number; durationMs: number; playing: boolean; frameRate: MtcFrameRate; clock: PlaybackClock; onPlayingChange: (playing: boolean) => void; onSeek: (ms: number) => void };
export function useTimelineStamp(props: Props) {
  const { lighting } = props;
  const { bindings, load, error } = useShortcutStore();
  const [chosen, setChosen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { load(); }, [load]);
  const selected = lighting?.document.tracks.find(track => track.clips.some(clip => clip.id === lighting.selectedClipId));
  const track = lighting?.document.tracks.find(entry => entry.id === chosen) ?? selected ?? lighting?.document.tracks[0];
  const stamp = (positionMs?: number): void => {
    if (!lighting) return;
    try {
      const output = props.clock.read();
      const result = stampTimeline(lighting.document, track?.id, positionMs ?? (props.playing && output.ready ? output.positionMs : props.playheadMs), props.durationMs, lighting.selectedClipId ?? undefined);
      lighting.onChange(result.document, '灯光时间线打点');
      if (result.eventId) lighting.onSelectEvent?.(result.trackId, result.clipId, result.eventId);
      setMessage(null);
    } catch (reason) { const text = reason instanceof Error ? reason.message : String(reason); setMessage(text); lighting.onError?.(text); }
  };
  useEffect(() => {
    if (!lighting) return;
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="separator"]') || [...document.querySelectorAll('[role="dialog"],dialog[open],.settings-content-page,.effect-binding-backdrop')].some(element => element.getClientRects().length > 0)) return;
      const action = bindings.find(binding => binding.key === shortcutKey(event))?.action;
      if (!action) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (action === 'stamp') { stamp(); return; }
      if (action === 'play') { if (!props.playing && props.playheadMs >= props.durationMs) props.onSeek(0); props.onPlayingChange(!props.playing); return; }
      props.onPlayingChange(false);
      const step = 1000 / playbackFramesPerSecond(props.frameRate);
      props.onSeek(action === 'start' ? 0 : action === 'end' ? props.durationMs : Math.max(0, Math.min(props.durationMs, props.playheadMs + (action === 'previous' ? -step : step))));
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  const shortcut = bindings.find(binding => binding.action === 'stamp');
  const controls = lighting ? <div className="timeline-stamp-controls"><button aria-label="打点" title={`在播放头打点${shortcut ? `（${shortcutLabel(shortcut.key)}）` : ''}；波形右键可在鼠标位置打点`} onClick={() => stamp()}><MapPinPlus /></button>
    {lighting.document.tracks.length ? <TimelineIconMenu icon={Layers3} label={`打点轨道：${track?.name ?? '未选择'}`}><label>打点轨道<select aria-label="打点轨道" value={track?.id ?? ''} onChange={event => setChosen(event.currentTarget.value)}>{lighting.document.tracks.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.locked ? '（已锁定）' : ''}</option>)}</select></label></TimelineIconMenu> : null}
    {message || error ? <span role="alert" className="timeline-tool-error" tabIndex={0} aria-label={message ?? error ?? ''} title={message ?? error ?? ''}><TriangleAlert /></span> : null}
  </div> : null;
  return { stamp, controls };
}
