import { useEffect, useState } from 'react';
import type { PlaybackClock } from '../../registry/playback-clock';
import { MapPinPlus, Layers3, TriangleAlert } from 'lucide-react';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Field, IconButton, Select } from '../ui';
import { playbackFramesPerSecond } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { shortcutKey, shortcutLabel, useShortcutStore } from '../stores/shortcut-store';
import type { LightingTimelineProps } from './LightingTimeline';
import { stampTimeline } from './timeline-stamp';
import { keyTarget } from '../playback-keys';
import { handleLightingShortcut, lightingShortcutTakes, type LightingShortcut } from './timeline-keys';
import { useKeyClaim } from '../keys/useKeyCommands';

/** `onPlayPause` is the timeline's play button, which the play key presses. */
type Props = { lighting: LightingTimelineProps | undefined; playheadMs: number; durationMs: number; playing: boolean; frameRate: MtcFrameRate; clock: PlaybackClock; onPlayPause: () => void; onPlayingChange: (playing: boolean) => void; onSeek: (ms: number) => void };
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
      const ms = positionMs ?? (props.playing && output.ready ? output.positionMs : props.playheadMs);
      if (lighting.onCreateCue) {
        if (!Number.isFinite(ms) || ms < 0 || ms >= props.durationMs) throw new Error('请在歌曲范围内添加 Cue');
        lighting.onCreateCue(ms);
        setMessage(null);
        return;
      }
      const result = stampTimeline(lighting.document, track?.id, ms, props.durationMs, lighting.selectedClipId ?? undefined);
      lighting.onChange(result.document, '灯光时间线打点');
      if (result.eventId) lighting.onSelectEvent?.(result.trackId, result.clipId, result.eventId);
      setMessage(null);
    } catch (reason) { const text = reason instanceof Error ? reason.message : String(reason); setMessage(text); lighting.onError?.(text); }
  };
  const shortcutOf = (event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): LightingShortcut => ({
    action: bindings.find(binding => binding.key === shortcutKey(event))?.action,
    covered: () => [...document.querySelectorAll('[role="dialog"],dialog[open],.settings-content-page,.effect-binding-backdrop')].some(element => element.getClientRects().length > 0)
  });
  // The window's key router comes first now; it leaves the keys this listener takes to it, as they were before (K6 moves them onto the router).
  useKeyClaim(lighting ? (event, target) => lightingShortcutTakes(event, target, shortcutOf(event)) : null);
  useEffect(() => {
    if (!lighting) return;
    const key = (event: KeyboardEvent): void => handleLightingShortcut(event, keyTarget(event), shortcutOf(event), action => {
      if (action === 'stamp') { stamp(); return; }
      if (action === 'play') { props.onPlayPause(); return; }
      props.onPlayingChange(false);
      const step = 1000 / playbackFramesPerSecond(props.frameRate);
      props.onSeek(action === 'start' ? 0 : action === 'end' ? props.durationMs : Math.max(0, Math.min(props.durationMs, props.playheadMs + (action === 'previous' ? -step : step))));
    });
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  const shortcut = bindings.find(binding => binding.action === 'stamp');
  const controls = lighting ? <div className="timeline-stamp-controls"><IconButton label="打点" title={`在播放头打点${shortcut ? `（${shortcutLabel(shortcut.key)}）` : ''}；波形右键可在鼠标位置打点`} icon={MapPinPlus} onClick={() => stamp()} />
    {!lighting.onCreateCue && lighting.document.tracks.length ? <TimelinePanelButton icon={Layers3} label={`打点轨道：${track?.name ?? '未选择'}`}><Field stacked label="打点轨道">{(field) => <Select {...field} value={track?.id ?? ''} onChange={event => setChosen(event.currentTarget.value)}>{lighting.document.tracks.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.locked ? '（已锁定）' : ''}</option>)}</Select>}</Field></TimelinePanelButton> : null}
    {message || error ? <span role="alert" className="timeline-tool-error" tabIndex={0} aria-label={message ?? error ?? ''} title={message ?? error ?? ''}><TriangleAlert /></span> : null}
  </div> : null;
  return { stamp, controls };
}
