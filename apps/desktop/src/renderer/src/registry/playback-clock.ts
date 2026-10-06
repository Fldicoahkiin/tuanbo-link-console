import type { PlaybackClock } from '@tb/core/link';
export type { PlaybackClockState, PlaybackClock, PlaybackBoundary } from '@tb/core/link';

type MediaClockSource = Pick<HTMLAudioElement, 'currentTime' | 'duration' | 'readyState' | 'paused' | 'ended' | 'seeking' | 'addEventListener' | 'removeEventListener'>;
export function mediaPlaybackClock(readAudio: () => MediaClockSource | null): PlaybackClock {
  return {
    read() {
      const audio = readAudio();
      return {
        positionMs: audio ? audio.currentTime * 1000 : 0,
        durationMs: audio && Number.isFinite(audio.duration) ? audio.duration * 1000 : 0,
        ready: Boolean(audio?.readyState), playing: Boolean(audio && !audio.paused && !audio.ended),
        seeking: audio?.seeking ?? false
      };
    },
    subscribeBoundary(listener) {
      const audio = readAudio();
      const pause = (): void => listener('pause');
      const seek = (): void => listener('seek');
      const end = (): void => listener('end');
      audio?.addEventListener('pause', pause);
      audio?.addEventListener('seeking', seek);
      audio?.addEventListener('ended', end);
      return () => {
        audio?.removeEventListener('pause', pause);
        audio?.removeEventListener('seeking', seek);
        audio?.removeEventListener('ended', end);
      };
    }
  };
}
