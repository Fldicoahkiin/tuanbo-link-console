import { useMemo, useRef } from 'react';
import { mediaPlaybackClock, type PlaybackClock } from '../../registry/playback-clock';
export type { PlaybackClock } from '../../registry/playback-clock';

/** A local preview owns its DOM audio element. Formal playback only supplies a
 * read-only clock; it must never be assigned to an <audio> ref. */
export function useTimelineAudio(external: boolean | undefined, transportClock: PlaybackClock | undefined) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const localClock = useMemo(() => mediaPlaybackClock(() => audioRef.current), []);
  return { audioRef, clock: external && transportClock ? transportClock : localClock };
}
