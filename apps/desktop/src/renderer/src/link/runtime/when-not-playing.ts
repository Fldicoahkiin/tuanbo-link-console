import { ma2SyncPlaying, useMa2SyncStore } from '../stores/ma2-sync-store';

/**
 * Runs `task` once nothing is playing (the programme or an editor preview): at once when idle, otherwise
 * when playback stops. For work that only tidies up, like rebuilding an old waveform cache: it must not
 * start a decode while a song is on air (2026-11-11). Returns a function that drops a task still waiting.
 */
export function runWhenNotPlaying(task: () => void): () => void {
  if (!ma2SyncPlaying()) { task(); return () => undefined; }
  let stop = (): void => undefined;
  stop = useMa2SyncStore.subscribe(() => {
    if (ma2SyncPlaying()) return;
    stop();
    task();
  });
  return () => { stop(); };
}
