import type { IntegrationProfile, NativeObsStatus, LightingDocument } from '@tb/schema';

export type InternalPlayerState = {
  playlistId?: string;
  status: 'stopped' | 'preparing' | 'playing' | 'paused' | 'error';
  itemId: string | null; positionMs: number; durationMs: number; volume: number;
  endAction: 'stop' | 'next' | 'loop' | 'pause'; error: string | null;
  playedItemIds: string[];
  mtcEnabled: boolean;
  mtcPositionMs: number | null;
  mtcPortName?: string | null;
  mtcSentPositionMs?: number | null;
  errorTitle: string | null;
  notice: string | null;
  mtcConnectionFailed: boolean;
};
export const emptyInternalPlayerState: InternalPlayerState = {
  status: 'stopped', itemId: null, positionMs: 0, durationMs: 0, volume: 100, endAction: 'pause', error: null, errorTitle: null, notice: null, playedItemIds: [], mtcEnabled: true, mtcPositionMs: null, mtcConnectionFailed: false
};
export type InternalPlayerDependencies = {
  prepare: (itemId: string, positionMs: number, options: { reuseSession: boolean; mtcOutputEnabled: boolean; signal?: AbortSignal }) => Promise<void>;
  ingest: (positionMs: number) => Promise<void>;
  started?: (positionMs: number) => void;
  scrub?: ((positionMs: number) => Promise<void>) | undefined;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  resolveAudio: (relativePath: string) => Promise<string>;
  configuration: () => { outputDeviceId: string; audioSampleRate?: 44100 | 48000; mtcPortName: string | null; preload?: boolean; fadeInMs?: number; fadeOutMs?: number; lightingProfile?: IntegrationProfile | null };
  changed: (state: InternalPlayerState) => void;
  notice?: (message: string, itemId: string | null) => void;
  obsChanged?: (state: NativeObsStatus) => void;
  preciseSeeking?: () => boolean;
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
  close?(): Promise<void>;
};
