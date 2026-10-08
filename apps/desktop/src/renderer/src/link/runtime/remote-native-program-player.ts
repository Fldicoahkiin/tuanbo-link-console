import { emptyInternalPlayerState, nativeAudioAnalysis, toUserErrorMessage,
  type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi, type PlaybackBoundary, type PlaybackClock } from '@tb/core/link';
import type { LinkProject, NativePlayerStatus, NativeProgramEvent, NativeProgramOperation } from '@tb/schema';

type Api = Pick<LinkDesktopApi, 'openNativeProgram' | 'controlNativeProgram' | 'onNativeProgramEvent' | 'onNativePlaybackStatus'>;

/** UI controller is a remote for the main-process program host. It never
 * schedules playback, sends lighting, or invents time while the UI is busy. */
export class RemoteNativeProgramPlayer {
  private readonly ownerId = crypto.randomUUID();
  private readonly ready: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly boundaries = new Set<(boundary: PlaybackBoundary) => void>();
  private state: InternalPlayerState = { ...emptyInternalPlayerState };
  private clockState = { positionMs: 0, durationMs: 0, ready: false, playing: false, seeking: false };
  private native: NativePlayerStatus | null = null;
  private sequence = -1;
  private disposed = false;
  private readonly analysis = nativeAudioAnalysis(() => this.native?.itemId === this.state.itemId ? this.native : null);
  readonly clock: PlaybackClock = {
    read: () => this.clockState,
    subscribeBoundary: listener => { this.boundaries.add(listener); return () => { this.boundaries.delete(listener); }; }
  };

  constructor(project: LinkProject, projectPath: string, revision: number, private readonly dependencies: InternalPlayerDependencies,
    private readonly api: Api, private readonly observed: (event: NativeProgramEvent) => void) {
    const program = api.onNativeProgramEvent(event => {
      if (this.disposed || event.ownerId !== this.ownerId || event.sequence <= this.sequence) return;
      this.sequence = event.sequence;
      const ids = event.state.playedItemIds;
      // IPC copies arrays; preserve stable control state during device-clock updates.
      this.state = { ...event.state, playedItemIds: ids.length === this.state.playedItemIds.length
        && ids.every((id, index) => id === this.state.playedItemIds[index]) ? this.state.playedItemIds : ids };
      this.clockState = event.clock;
      this.dependencies.changed(this.state); this.observed(event);
      if (event.boundary) for (const listener of this.boundaries) listener(event.boundary);
    });
    const audio = api.onNativePlaybackStatus(status => { if (!this.disposed) this.native = status; });
    this.unsubscribe = () => { program(); audio(); };
    this.ready = api.openNativeProgram({ version: 1, ownerId: this.ownerId, projectPath, revision,
      document: JSON.stringify(project), configuration: this.configuration() });
    void this.ready.catch(error => this.failed(error));
  }
  play(itemId: string, positionMs?: number, paused = false): Promise<void> {
    return this.send({ kind: 'play', itemId, ...(positionMs === undefined ? {} : { positionMs }), paused });
  }
  pause(): Promise<void> { return this.send({ kind: 'pause' }); }
  resume(): Promise<void> { return this.send({ kind: 'resume' }); }
  stop(): Promise<void> { return this.send({ kind: 'stop' }); }
  reset(): Promise<void> { return this.send({ kind: 'reset' }); }
  toggle(): Promise<void> { return this.send({ kind: 'toggle' }); }
  seek(positionMs: number): Promise<void> { return this.send({ kind: 'seek', positionMs }); }
  scrub(itemId: string, positionMs: number): Promise<void> { return this.send({ kind: 'scrub', itemId, positionMs }); }
  skip(direction: -1 | 1): Promise<void> { return this.send({ kind: 'skip', direction }); }
  externalStop(): void { void this.stop(); }
  freeze(message: string): void { void this.send({ kind: 'freeze', message }); }
  reportUnavailable(message: string): void { void this.send({ kind: 'unavailable', message }); }
  runtimeUnavailable(message: string): void { void this.send({ kind: 'runtimeUnavailable', message }); }
  setVolume(volume: number): void { void this.send({ kind: 'volume', volume }); }
  setEndAction(endAction: InternalPlayerState['endAction']): void { void this.send({ kind: 'endAction', endAction }); }
  setPlaylist(playlistId: string): void { void this.send({ kind: 'playlist', playlistId }); }
  toggleMtc(): void { void this.send({ kind: 'toggleMtc' }); }
  receiveMidi(bytes: Uint8Array): void { void this.send({ kind: 'midi', bytes: [...bytes] }); }
  fade(out: boolean): void { void this.send({ kind: 'fade', out }); }
  preloadSelected(itemId: string): void { void this.send({ kind: 'preload', itemId }); }
  getAudioAnalysis() { return this.state.status === 'playing' ? this.analysis : null; }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.boundaries.clear();
    // Close is sent immediately, including while open is waiting for authorization.
    await this.api.controlNativeProgram({ version: 1, ownerId: this.ownerId, operation: { kind: 'close' } });
  }
  private configuration() { return { ...this.dependencies.configuration(), preciseSeeking: this.dependencies.preciseSeeking?.() ?? false }; }
  private async send(operation: NativeProgramOperation): Promise<void> {
    try {
      await this.ready;
      if (this.disposed) return;
      await this.api.controlNativeProgram({ version: 1, ownerId: this.ownerId, operation, configuration: this.configuration() });
    } catch (error) { this.failed(error); }
  }
  private failed(error: unknown): void {
    if (this.disposed) return;
    const message = toUserErrorMessage(error);
    this.state = { ...this.state, status: 'error', error: message, errorTitle: '后台节目控制失败' };
    this.dependencies.changed(this.state); this.dependencies.notice?.(message, this.state.itemId);
  }
}
