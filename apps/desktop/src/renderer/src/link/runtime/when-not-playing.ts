import { currentShowGate, useShowStateStore } from '../stores/show-state-store';

/** Rebuilding a cache decodes the song, like analysing music: it waits until the show has stopped (showGate). */
const waits = (): boolean => currentShowGate('media.analyze').kind === 'wait';

/**
 * Runs `task` once nothing is on air (the programme, paused or not, or an editor preview): at once when
 * stopped, otherwise when the show stops. For work that only tidies up, like rebuilding an old waveform
 * cache: it must not start a decode while a song is on air (2026-11-11). Returns a function that drops a
 * task still waiting.
 */
export function runWhenNotPlaying(task: () => void): () => void {
  if (!waits()) { task(); return () => undefined; }
  let stop = (): void => undefined;
  stop = useShowStateStore.subscribe(() => {
    if (waits()) return;
    stop();
    task();
  });
  return () => { stop(); };
}
