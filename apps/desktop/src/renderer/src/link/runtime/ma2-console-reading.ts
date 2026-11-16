import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';

/** A foreground read or playback preparation owns the console until it releases its read job. */
export function ma2ConsoleReading(): boolean {
  return useMa2ReadStore.getState().busy || useMa2MaterialReadStore.getState().busy;
}
