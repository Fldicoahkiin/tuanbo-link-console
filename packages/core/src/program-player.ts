import type { IntegrationProfile, NativeObsStatus, LightingDocument } from '@tb/schema';

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

export type ProgramLightingOutput = {
  prepare(document: LightingDocument, profile: IntegrationProfile | null, positionMs: number): Promise<void>;
  tick(positionMs: number): void;
  finish(positionMs: number): Promise<void> | void;
  stop(): void;
  release?(): Promise<void>;
  close?(): Promise<void>;
  /** The latest live lighting fault since the previous call; the channel keeps running. */
  takeFault?(): string | null;
};
