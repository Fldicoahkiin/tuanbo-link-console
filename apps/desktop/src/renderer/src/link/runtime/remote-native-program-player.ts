import { emptyInternalPlayerState, isPreviousNotStopped, nativeAudioAnalysis, toUserErrorMessage,
  type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi, type PlaybackBoundary, type PlaybackClock } from '@tb/core/link';
import type { LinkProject, NativePlayerStatus, NativeProgramAttachment, NativeProgramEvent, NativeProgramOperation } from '@tb/schema';

type Api = Pick<LinkDesktopApi, 'openNativeProgram' | 'controlNativeProgram' | 'onNativeProgramEvent' | 'onNativeProgramClosed' | 'onNativePlaybackStatus'>;
/** What the window supplies: settings to play with, and where to show and log what happens. */
export type RemotePlayerDependencies = Pick<InternalPlayerDependencies, 'configuration' | 'changed' | 'preciseSeeking'> & {
  notice: (message: string, itemId: string | null) => void;
  /** The background program answered the open, so `outdated` is known now: it comes after the first state the
   * program sends, and that state does not say which version of the project it plays. */
  attached: () => void;
  /** The quit closed the program this controller opened, and the operator went back to the app: nothing it sends is
   * played any more. The window opens a new program, as after a project change (useInternalPlayer). */
  closed: () => void;
};

/** UI controller is a remote for the main-process program host. It never
 * schedules playback, sends lighting, or invents time while the UI is busy. */
export class RemoteNativeProgramPlayer {
  private readonly ownerId = crypto.randomUUID();
  /** The open; replaced once a stop pressed after a refused open has opened the program (send). */
  private ready: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly boundaries = new Set<(boundary: PlaybackBoundary) => void>();
  private state: InternalPlayerState = { ...emptyInternalPlayerState };
  private clockState = { positionMs: 0, durationMs: 0, ready: false, playing: false, seeking: false };
  private native: NativePlayerStatus | null = null;
  private sequence = -1;
  private disposed = false;
  private attachment: NativeProgramAttachment | null = null;
  private readonly analysis = nativeAudioAnalysis(() => this.native?.itemId === this.state.itemId ? this.native : null);
  readonly clock: PlaybackClock = {
    read: () => this.clockState,
    subscribeBoundary: listener => { this.boundaries.add(listener); return () => { this.boundaries.delete(listener); }; }
  };

  constructor(private readonly project: LinkProject, projectPath: string, revision: number, private readonly dependencies: RemotePlayerDependencies,
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
    const closed = api.onNativeProgramClosed(event => { if (!this.disposed && event.ownerId === this.ownerId) this.dependencies.closed(); });
    const audio = api.onNativePlaybackStatus(status => { if (!this.disposed) this.native = status; });
    this.unsubscribe = () => { program(); closed(); audio(); };
    this.ready = api.openNativeProgram({ version: 1, ownerId: this.ownerId, projectPath, revision,
      document: JSON.stringify(project), configuration: this.configuration() }).then(attachment => {
      this.attachment = attachment;
      if (!this.disposed) this.dependencies.attached();
    });
    void this.ready.catch(error => this.failed(error));
  }
  /** Every song plays when the operator starts it (2026-10-26); the engine shows the start check as a warning. */
  play(itemId: string, positionMs?: number, paused = false): Promise<void> {
    return this.send({ kind: 'play', itemId, ...(positionMs === undefined ? {} : { positionMs }), paused });
  }
  pause(): Promise<void> { return this.send({ kind: 'pause' }); }
  resume(): Promise<void> { return this.send({ kind: 'resume' }); }
  stop(): Promise<void> { return this.send({ kind: 'stop' }); }
  reset(): Promise<void> { return this.send({ kind: 'reset' }); }
  seek(positionMs: number): Promise<void> { return this.send({ kind: 'seek', positionMs }); }
  scrub(itemId: string, positionMs: number): Promise<void> { return this.send({ kind: 'scrub', itemId, positionMs }); }
  skip(direction: -1 | 1): Promise<void> { return this.send({ kind: 'skip', direction }); }
  externalStop(): void { void this.stop(); }
  freeze(message: string): void { void this.send({ kind: 'freeze', message }); }
  reportUnavailable(message: string): void { void this.send({ kind: 'unavailable', message }); }
  runtimeUnavailable(message: string): void { void this.send({ kind: 'runtimeUnavailable', message }); }
  reportFault(message: string): void { void this.send({ kind: 'fault', message }); }
  /** The player-bar slider while it is dragged: heard at once, saved nowhere (the release saves it in the project). */
  previewVolume(volume: number): void { void this.send({ kind: 'volume', volume, preview: true }); }
  /** A song's saved volume changed in this window's project (useSongVolumeSync). */
  setSongVolume(itemId: string, volume: number): void { void this.send({ kind: 'songVolume', itemId, volume }); }
  setEndAction(endAction: InternalPlayerState['endAction']): void { void this.send({ kind: 'endAction', endAction }); }
  setPlaylist(playlistId: string): void { void this.send({ kind: 'playlist', playlistId }); }
  toggleMtc(): void { void this.send({ kind: 'toggleMtc' }); }
  receiveMidi(bytes: Uint8Array): void { void this.send({ kind: 'midi', bytes: [...bytes] }); }
  fade(out: boolean): void { void this.send({ kind: 'fade', out }); }
  preloadSelected(itemId: string): void { void this.send({ kind: 'preload', itemId }); }
  /** Taken over after a window reload, the running program plays a different
   * document than this window shows; the window opens its own once it stops. */
  get outdated(): boolean { return this.attachment === 'outdated'; }
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
      // The open was refused because the song before had not stopped (0.5.9 S6): stop asks the program again, and once
      // it opens, the other controls work again. Any other refused open stays as it was.
      if (operation.kind === 'stop' && await this.ready.then(() => false, isPreviousNotStopped)) {
        await this.api.controlNativeProgram({ version: 1, ownerId: this.ownerId, operation, configuration: this.configuration() });
        this.ready = Promise.resolve(); this.attachment = 'opened';
        if (!this.disposed) this.dependencies.attached();
        return;
      }
      await this.ready;
      if (this.disposed) return;
      await this.api.controlNativeProgram({ version: 1, ownerId: this.ownerId, operation, configuration: this.configuration() });
    } catch (error) { this.failed(error); }
  }
  private failed(error: unknown): void {
    if (this.disposed) return;
    const message = toUserErrorMessage(error);
    this.state = { ...this.state, status: 'error', error: message, errorTitle: '播放控制失败' };
    this.dependencies.changed(this.state); this.dependencies.notice(message, this.state.itemId);
  }
}
