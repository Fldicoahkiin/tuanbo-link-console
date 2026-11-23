import type { LinkProject, PlaybackSnapshot, Ma2TimecodeRanges } from '@tb/schema';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { lightingStartCheck } from './lighting-start-check';
import { playbackMtcGapProblem } from './ma2-mtc-selection';
import { itemNeedsObs } from './obs-program-snapshot';

/**
 * What starting a song does. This is the only place that decides it (lighting workflow rule 9,
 * 2026-10-26: a song plays whenever the operator starts it, finished or not, and nothing holds it
 * back). A song without audio cannot start because there is nothing to play; `nativeProgramSnapshot`
 * throws for it. Everything else is an output that joins or does not:
 * - `allowMtc`: send the song's MTC when its origin is valid and the known ranges allow it.
 *   The audio still plays when lighting is blocked; `warnings` explains how to correct it;
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
  deskRanges?: Ma2TimecodeRanges | undefined;
  /** False when the song keeps playing from another position: its start check was shown already. */
  check: boolean;
}): ProgramStart {
  const prepared = nativeProgramSnapshot(project, itemId, options.revision, options.positionMs, options.sampleRate);
  const check = options.check ? lightingStartCheck(project, itemId, { portName: options.mtcPortName, ports: null }) : null;
  const warnings: string[] = [];
  for (const warning of [check, prepared.notice]) if (warning && !warnings.some(shown => shown.includes(warning))) warnings.push(warning);
  const item = project.rundown.find(song => song.id === itemId)!;
  const gap = prepared.allowMtc && playbackMtcGapProblem(project, item, prepared.snapshot.offsetMs, prepared.snapshot.endMs, options.deskRanges);
  if (gap) warnings.push(`${gap}。修正前只播放音乐和画面，灯光时间码已停用。`);
  return { snapshot: prepared.snapshot, allowMtc: prepared.allowMtc && !gap, picture: itemNeedsObs(project, itemId) ? 'wait' : 'optional', warnings };
}
