import { useEffect, useState } from 'react';
import type { PlaybackClock } from '../../registry/playback-clock';
import { MapPinPlus, Layers3, TriangleAlert } from 'lucide-react';
import { TimelinePanelButton } from './TimelinePanelButton';
import { Field, IconButton, Select } from '../ui';
import { playbackFramesPerSecond } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { commandKeyLabel, useShortcutStore } from '../stores/shortcut-store';
import type { TimelineSeek } from './timeline-commands';
import type { LightingTimelineProps } from './LightingTimeline';
import { stampTimeline } from './timeline-stamp';
import { useKeyCommands } from '../keys/useKeyCommands';
import { keyRouter } from '../keys/key-router';

/** `onPlayPause` is the timeline's play button, which the play key presses. */
type Props = { lighting: LightingTimelineProps | undefined; playheadMs: number; durationMs: number; playing: boolean; frameRate: MtcFrameRate; clock: PlaybackClock; onPlayPause: () => void; onPlayingChange: (playing: boolean) => void; seek: TimelineSeek };
export function useTimelineStamp(props: Props) {
  const { lighting } = props;
  const { load, error } = useShortcutStore();
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
  // The lighting workbench's shortcut keys (keymap.ts, scope `lighting`, with the keys set on this computer,
  // shortcut-store.ts): on the whole page, but not while a dialog or any panel is open (`covered`), as before the key
  // router took them (K6). Moving the playhead pauses first.
  // A held ← or → moves a frame per repeat, its seeks merged into one per frame drawn (`seek`, 04 设计 4.9).
  const seek = (ms: number): void => { props.onPlayingChange(false); props.seek.to(ms); };
  const step = (direction: -1 | 1): void => seek(Math.max(0, Math.min(props.durationMs, props.seek.from() + direction * 1000 / playbackFramesPerSecond(props.frameRate))));
  useKeyCommands('lighting', lighting ? {
    'lighting.stamp': () => stamp(),
    'transport.playPause': () => props.onPlayPause(),
    'transport.prevFrame': () => step(-1), 'transport.nextFrame': () => step(1),
    'transport.start': () => seek(0), 'transport.end': () => seek(props.durationMs)
  } : null, () => !keyRouter.covered());
  const shortcut = commandKeyLabel('lighting.stamp', 'lighting');
  const controls = lighting ? <div className="timeline-stamp-controls"><IconButton label="打点" title={`在播放头打点${shortcut ? `（${shortcut}）` : ''}；波形右键可在鼠标位置打点`} icon={MapPinPlus} onClick={() => stamp()} />
    {!lighting.onCreateCue && lighting.document.tracks.length ? <TimelinePanelButton icon={Layers3} label={`打点轨道：${track?.name ?? '未选择'}`}><Field stacked label="打点轨道">{(field) => <Select {...field} value={track?.id ?? ''} onChange={event => setChosen(event.currentTarget.value)}>{lighting.document.tracks.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.locked ? '（已锁定）' : ''}</option>)}</Select>}</Field></TimelinePanelButton> : null}
    {message || error ? <span role="alert" className="timeline-tool-error" tabIndex={0} aria-label={message ?? error ?? ''} title={message ?? error ?? ''}><TriangleAlert /></span> : null}
  </div> : null;
  return { stamp, controls };
}
