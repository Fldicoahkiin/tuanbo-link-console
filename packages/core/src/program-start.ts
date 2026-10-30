import type { LinkProject, PlaybackSnapshot } from '@tb/schema';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { lightingStartCheck } from './lighting-start-check';
import { itemNeedsObs } from './obs-program-snapshot';

/**
 * What starting a song does. This is the only place that decides it (lighting workflow rule 9,
 * 2026-10-26: a song plays whenever the operator starts it, finished or not, and nothing holds it
 * back). A song without audio cannot start because there is nothing to play; `nativeProgramSnapshot`
 * throws for it. Everything else is an output that joins or does not:
 * - `allowMtc`: the song's own timecode is sent from its MTC start; false only when the song has no
 *   valid start, and then `warnings` says why;
 * - `picture`: `wait` for a song with picture work, which waits for its picture to be prepared
 *   (a first play may build seek caches) and, when that fails, plays without it, shown in red;
 *   `optional` for any other song, whose picture gets one second;
 * - `warnings`: the start check, shown with the playing song.
 */
export type ProgramStart = {
  snapshot: PlaybackSnapshot;
  allowMtc: boolean;
  picture: 'wait' | 'optional';
  warnings: string[];
};

export function programStart(project: LinkProject, itemId: string, options: {
  revision: number; positionMs: number | undefined; sampleRate: 44100 | 48000;
  /** The configured timecode output, for the start check. */
  mtcPortName: string | null;
  /** False when the song keeps playing from another position: its start check was shown already. */
  check: boolean;
}): ProgramStart {
  const prepared = nativeProgramSnapshot(project, itemId, options.revision, options.positionMs, options.sampleRate);
  const check = options.check ? lightingStartCheck(project, itemId, { portName: options.mtcPortName, ports: null }) : null;
  const warnings: string[] = [];
  for (const warning of [check, prepared.notice]) if (warning && !warnings.some(shown => shown.includes(warning))) warnings.push(warning);
  return { snapshot: prepared.snapshot, allowMtc: prepared.allowMtc, picture: itemNeedsObs(project, itemId) ? 'wait' : 'optional', warnings };
}
