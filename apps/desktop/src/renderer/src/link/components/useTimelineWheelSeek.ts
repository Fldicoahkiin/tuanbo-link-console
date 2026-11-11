import { useCallback, useRef, useState, type RefObject } from 'react';
import { LightingTempoMap, lightingEventTime, moveLightingEffect } from '@tb/core/link';
import type { LightingTimelineProps } from './LightingTimeline';
import { usePlayheadEffect, type EditorPlayhead } from './editor-playhead';

type Options = {
  playhead: EditorPlayhead;
  durationMs: number;
  externalTransport?: boolean;
  lightingWorkspace?: boolean;
  lighting?: LightingTimelineProps;
  playing?: boolean;
  referenceAudio?: { durationMs: number } | null;
  onPlayingChange: (playing: boolean) => void;
  onPlayheadChange: (milliseconds: number) => void;
};

export function useTimelineWheelSeek(options: Options, audioRef: RefObject<HTMLAudioElement>): { seek: (deltaMs: number) => number; speed: number; setSpeed: (speed: number) => void } {
  const { playhead, durationMs, externalTransport, onPlayingChange, onPlayheadChange } = options;
  const [speed, setSpeed] = useState(0.1);
  const position = useRef(playhead.read());
  // Wheel steps add up from where the playhead last moved to.
  usePlayheadEffect(playhead, useCallback((playheadMs: number) => { position.current = playheadMs; }, []));
  const seek = useCallback((deltaMs: number) => {
    const lighting = options.lightingWorkspace ? options.lighting : undefined;
    if (lighting?.selectedEventId) {
      const map = new LightingTempoMap(lighting.document.tempos);
      const selected = lighting.document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ clip, event })))).find(entry => entry.event.id === lighting.selectedEventId);
      const currentMs = selected ? lightingEventTime(selected.clip, selected.event, map) : playhead.read();
      try {
        if (options.playing) throw new Error('请暂停播放后用滚轮移动 Cue');
        const limit = options.referenceAudio?.durationMs ?? durationMs;
        const next = Math.max(0, Math.min(limit - 1, currentMs + deltaMs * speed));
        const document = moveLightingEffect(lighting.document, lighting.selectedEventId, next, limit);
        lighting.onChange(document, '滚轮移动 Cue');
        return next;
      } catch (error) { lighting.onError?.(error instanceof Error ? error.message : String(error)); return currentMs; }
    }
    const next = Math.max(0, Math.min(durationMs, position.current + deltaMs * speed));
    position.current = next;
    onPlayingChange(false);
    onPlayheadChange(next);
    if (!externalTransport && audioRef.current) audioRef.current.currentTime = next / 1_000;
    return next;
  }, [durationMs, externalTransport, onPlayingChange, onPlayheadChange, audioRef, speed, options.lightingWorkspace, options.lighting, options.playing, options.referenceAudio?.durationMs, playhead]);
  return { seek, speed, setSpeed };
}
