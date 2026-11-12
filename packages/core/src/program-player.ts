import type { NativeObsStatus, LightingDocument, LinkProject } from '@tb/schema';

export type InternalPlayerState = import('@tb/schema').ProgramPlayerState;
export const emptyInternalPlayerState: InternalPlayerState = {
  status: 'stopped', itemId: null, positionMs: 0, durationMs: 0, volume: 100, endAction: 'pause', defaultEndAction: 'pause', error: null, errorTitle: null, notice: null, playedItemIds: [], mtcEnabled: true, mtcPositionMs: null, mtcConnectionFailed: false
};
export type InternalPlayerDependencies = {
  /** `pass`: which placing of the song this preparation belongs to (0.5.9 S8b). It goes up whenever the song is placed
   * anew (a start, a seek, a loop, a scrub) and stays when it plays on after a pause: within one pass the actions whose
   * turn came are not sent again, also where a newer version moved them after the playhead. */
  prepare: (itemId: string, positionMs: number, options: { reuseSession: boolean; mtcOutputEnabled: boolean; signal?: AbortSignal; pass?: number }) => Promise<void>;
  ingest: (positionMs: number) => Promise<void>;
  started?: (positionMs: number) => void;
  scrub?: ((positionMs: number) => Promise<void>) | undefined;
  /** reason: set for programmatic pauses/stops; absent means the operator asked. */
  pause: (reason?: string) => Promise<void>;
  stop: (reason?: string) => Promise<void>;
  /** The song on stage takes a newer version of its action MIDI (0.5.9 S8b, liveRevisionEffect `actions`): the actions
   * after the playhead follow it. While its actions are not running (paused, or being prepared again) nothing is sent:
   * they are prepared from that version as it plays on (NativeProgramPlayer.actionsProject). */
  retargetActions?: (project: LinkProject, itemId: string) => void;
  resolveAudio: (relativePath: string) => Promise<string>;
  configuration: () => Omit<import('@tb/schema').NativeProgramConfiguration, 'preciseSeeking'>;
  changed: (state: InternalPlayerState) => void;
  notice?: (message: string, itemId: string | null) => void;
  /** A failure no window sees in the player's state (2026-11-09: the Off a stop owed): after the player closed, or while
   * its program plays on without a window (setWatched). The host logs it as an error and shows it in red, in the window or
   * in the next window that opens a program. `leftOpen`: not an Off but something the close left open (2026-11-11: the
   * action MIDI): it is shown and logged the same way, and the quit does not ask about it as it asks about an Off. */
  closedFault: (message: string, itemId: string | null, kind?: 'leftOpen') => void;
  failed?: (message: string, itemId: string | null) => void;
  obsChanged?: (state: NativeObsStatus) => void;
  preciseSeeking?: () => boolean;
  /** Why playback must not start now; checked before any output is prepared. */
  refusal?: () => string | null;
};

/** Read-only transport data. Editors may observe the output clock, but can
 * change playback only through the owning controller. */
export type PlaybackClockState = {
  positionMs: number; durationMs: number;
  ready: boolean; playing: boolean; seeking: boolean;
};
export type PlaybackBoundary = 'pause' | 'seek' | 'end';
export type PlaybackClock = {
  read(): PlaybackClockState;
  subscribeBoundary(listener: (boundary: PlaybackBoundary) => void): () => void;
};

export type AudioAnalysis = {
  sampleRate: number; fftSize: number; frequencyBinCount: number;
  readSpectrum: (values: Uint8Array<ArrayBuffer>) => void;
  readPeaks: () => readonly [number, number];
};

const previousNotStoppedOpening = '上一首还没停下：';
/** A program was not opened because the one before it closed with its audio engine still sounding (0.5.9 S6): what
 * happened, then what to do. Pressing stop reads the engine again; it is not retried by itself. */
export function previousNotStopped(reason: string): string { return `${previousNotStoppedOpening}${reason}。再按一次停止`; }
/** The window tells that refusal from others by its opening, as it arrives over IPC. */
export function isPreviousNotStopped(error: unknown): boolean {
  const raw = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
  return raw.replace(/Error invoking remote method '[^']+':\s*/g, '').replace(/\bError:\s*/g, '').trim().startsWith(previousNotStoppedOpening);
}

/** The rundown song whose lighting a lights-off belongs to. */
export type LightingReleaseSong = { itemId: string; title: string };

/** A song's lighting as the program runs it: its document, and the rundown song it belongs to. `earlier`: the
 * versions of its lighting that arrived before `document` while the song played (0.5.9 S8a). The console may have run
 * any of them in this pass (it is written to while paused), so a stop or a song change switches off the executors of
 * them all (lighting-off-ledger.ts `litExecutors`). */
export type LitSong = { document: LightingDocument; song: LightingReleaseSong; earlier?: readonly LightingDocument[] };
/** The Offs of one request that did not go out, each with the song it was for and why. They stay owed. */
export type LightingOffOutcome = { failed: { song: LightingReleaseSong | null; reason: string }[] };

/** A playing song's lighting is the console's Timecode show following the song's timecode (2026-11-01: the
 * MIDI and network playback modes were removed). The player only tells the lights-off ledger of the main process
 * (lighting-off-service.ts, design 01 R13) which song's executors it uses and when it lets them go; the ledger decides
 * what to switch off and keeps what did not go out. Both resolve once the Offs they asked for were answered. */
export type ProgramLightingOutput = {
  /** `next` starts in place of `previous` (第 4 题): only what `previous` used and `next` does not is switched off, and
   * the executors of `next` are in use now. Called after the previous timecode stopped; the start does not wait for it. */
  change(previous: LitSong | null, next: LitSong | null): Promise<LightingOffOutcome>;
  /** The song stopped (or the program closed after a stop it owed): every executor of `song` is switched off, and every
   * Off still owed is sent once more (pressing stop again). */
  stop(song: LitSong | null, cause: 'stop' | 'close'): Promise<LightingOffOutcome>;
  /** The song on air got a newer version of its lighting (0.5.9 S8a; `song` is the one it had, also with this version,
   * litAlso): its executors in use only grow, nothing is switched off, and an Off already owed stays owed. */
  widen(song: LitSong): void;
};
