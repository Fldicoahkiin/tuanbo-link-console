import type { NativePlayerStatus } from '@tb/schema';

/*
 * The one shape in which the outputs (picture, action MIDI, and later lights-off and the show state) learn where the
 * song is (design 03 §4.1.1). The two timing sources meet here: the internal player's audio device position, and P1's
 * timecode (`p1-clock.ts`). Downstream code reads only this, never a player status or an MTC sample.
 */

export type ProgramClockSource = 'internal' | 'p1';

/**
 * - `ready`: loaded and waiting at its position, not started (internal `ready`).
 * - `running`: playing; `observedAtMs` says when `positionMs` was true.
 * - `held`: paused where it is (internal `paused`).
 * - `lost`: the timecode is gone or jumped (P1 only); outputs keep what they have and wait.
 * - `ended`: played to the end and stays there.
 * - `stopped`: the source let go of this song (stopped, preparing again, or an audio error); outputs close it.
 */
export type ProgramClockState = 'ready' | 'running' | 'held' | 'lost' | 'ended' | 'stopped';

export type ProgramClock = {
  source: ProgramClockSource;
  /** One play of the internal player, or one follow of one song in P1. */
  sessionId: string;
  /** Goes up on every seek, resync and new song; outputs drop work from an older one. */
  generation: number;
  itemId: string;
  state: ProgramClockState;
  /** Position inside the song (P1: after subtracting the song's start). */
  positionMs: number;
  /**
   * Interface time in ms (the QPC counter): when the audio device reported `positionMs`, or when the quarter frame that
   * completed it reached the MIDI interface. Null when this is no new observation of the position (a status-only
   * change such as volume, or the final position already delivered).
   */
  observedAtMs: number | null;
  /** Why it stopped, held or got lost, for the screen as is; null when there is nothing to say. */
  reason: string | null;
};

/** The internal player's status as a clock. `qpc100ns` is the device observation time in 100 ns QPC ticks, if any. */
export function clockFromNativeStatus(status: NativePlayerStatus, qpc100ns: string | null): ProgramClock {
  return {
    source: 'internal', sessionId: status.sessionId, generation: status.generation, itemId: status.itemId,
    state: internalState(status), positionMs: status.positionMs,
    observedAtMs: qpc100ns === null || qpc100ns === '0' ? null : Number(qpc100ns) / 10000,
    reason: status.audioError
  };
}

function internalState(status: NativePlayerStatus): ProgramClockState {
  // An audio error ends the song for the outputs whatever the status still says.
  if (status.audioError) return 'stopped';
  switch (status.status) {
    case 'ready': return 'ready';
    case 'playing': return 'running';
    case 'paused': return 'held';
    case 'ended': return 'ended';
    case 'preparing': case 'stopped': case 'error': return 'stopped';
  }
}
