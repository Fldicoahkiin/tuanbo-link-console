import type { NativeObsStatus, LightingDocument } from '@tb/schema';

export type InternalPlayerState = import('@tb/schema').ProgramPlayerState;
export const emptyInternalPlayerState: InternalPlayerState = {
  status: 'stopped', itemId: null, positionMs: 0, durationMs: 0, volume: 100, endAction: 'pause', error: null, errorTitle: null, notice: null, playedItemIds: [], mtcEnabled: true, mtcPositionMs: null, mtcConnectionFailed: false
};
export type InternalPlayerDependencies = {
  prepare: (itemId: string, positionMs: number, options: { reuseSession: boolean; mtcOutputEnabled: boolean; signal?: AbortSignal }) => Promise<void>;
  ingest: (positionMs: number) => Promise<void>;
  started?: (positionMs: number) => void;
  scrub?: ((positionMs: number) => Promise<void>) | undefined;
  /** reason: set for programmatic pauses/stops; absent means the operator asked. */
  pause: (reason?: string) => Promise<void>;
  stop: (reason?: string) => Promise<void>;
  resolveAudio: (relativePath: string) => Promise<string>;
  configuration: () => Omit<import('@tb/schema').NativeProgramConfiguration, 'preciseSeeking'>;
  changed: (state: InternalPlayerState) => void;
  notice?: (message: string, itemId: string | null) => void;
  /** A failure no window sees in the player's state (2026-11-09: the Off a stop owed): after the player closed, or while
   * its program plays on without a window (setWatched). The host logs it as an error and shows it in red, in the window or
   * in the next window that opens a program. */
  closedFault: (message: string, itemId: string | null) => void;
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

/** The rundown song whose lighting a lights-off belongs to. */
export type LightingReleaseSong = { itemId: string; title: string };

/** A playing song's lighting is the console's Timecode show following the song's timecode (2026-11-01: the
 * MIDI and network playback modes were removed). The player itself only switches the song's executors off
 * when it stops. */
export type ProgramLightingOutput = {
  /** Notes where the Off goes when `song` stops; sends nothing. */
  prepare(document: LightingDocument, song: LightingReleaseSong): Promise<void>;
  /** Drops a preparation still under way; one that finished is kept for the stop. */
  cancelPreparation(): void;
  /** The song stopped: its executors are switched off. A failure is a LightingReleaseFailure naming the song the
   * Off was prepared for, which is not always the song playing now. */
  release(): Promise<void>;
};
