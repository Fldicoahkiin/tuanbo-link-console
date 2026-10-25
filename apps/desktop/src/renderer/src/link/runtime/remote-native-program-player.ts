import { emptyInternalPlayerState, lightingStartCheck, nativeAudioAnalysis, songLightingStatus, toUserErrorMessage,
  type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi, type PlaybackBoundary, type PlaybackClock, type SongLightingStatus } from '@tb/core/link';
import type { LinkProject, NativePlayerStatus, NativeProgramAttachment, NativeProgramEvent, NativeProgramOperation } from '@tb/schema';

type Api = Pick<LinkDesktopApi, 'openNativeProgram' | 'controlNativeProgram' | 'onNativeProgramEvent' | 'onNativePlaybackStatus' | 'getNativePlaybackDevices'>;

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
  private attachment: NativeProgramAttachment | null = null;
  private readonly analysis = nativeAudioAnalysis(() => this.native?.itemId === this.state.itemId ? this.native : null);
  readonly clock: PlaybackClock = {
    read: () => this.clockState,
    subscribeBoundary: listener => { this.boundaries.add(listener); return () => { this.boundaries.delete(listener); }; }
  };

  constructor(private readonly project: LinkProject, projectPath: string, revision: number, private readonly dependencies: InternalPlayerDependencies,
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
      document: JSON.stringify(project), configuration: this.configuration() }).then(attachment => { this.attachment = attachment; });
    void this.ready.catch(error => this.failed(error));
  }
  /** A song the operator starts is checked first; a failed check asks whether to play it without lighting.
   * The answer is asked once per song and kind of problem: later starts reuse it, and the engine still
   * shows that the song plays without lighting. A song that checks out asks again the next time it fails. */
  async play(itemId: string, positionMs?: number, paused = false): Promise<void> {
    let withoutLighting = false;
    try {
      const check = await this.startCheck(itemId);
      const choices = this.dependencies.withoutLightingChoices, key = `${this.project.projectId}\n${itemId}`;
      if (!check) choices?.delete(key);
      else if (choices?.get(key) === check.topic) {
        withoutLighting = true;
        this.dependencies.notice?.(`开播前检查：沿用操作员选择无灯光播放；${check.reason}`, itemId);
      } else {
        if (!this.dependencies.confirmWithoutLighting) throw new Error(`${check.reason}；无法询问是否无灯光播放`);
        if (!await this.dependencies.confirmWithoutLighting(check.reason)) return;
        choices?.set(key, check.topic);
        withoutLighting = true;
      }
    } catch (error) { this.failed(error); return; }
    return this.send({ kind: 'play', itemId, ...(positionMs === undefined ? {} : { positionMs }), paused, ...(withoutLighting ? { withoutLighting } : {}) });
  }
  pause(): Promise<void> { return this.send({ kind: 'pause' }); }
  resume(): Promise<void> { return this.send({ kind: 'resume' }); }
  stop(): Promise<void> { return this.send({ kind: 'stop' }); }
  reset(): Promise<void> { return this.send({ kind: 'reset' }); }
  /** Starting from stop goes through the start check; pause and resume keep the song's route. */
  toggle(): Promise<void> {
    if (this.state.status !== 'playing' && this.state.status !== 'paused' && this.state.itemId) return this.play(this.state.itemId);
    return this.send({ kind: 'toggle' });
  }
  seek(positionMs: number): Promise<void> { return this.send({ kind: 'seek', positionMs }); }
  scrub(itemId: string, positionMs: number): Promise<void> { return this.send({ kind: 'scrub', itemId, positionMs }); }
  skip(direction: -1 | 1): Promise<void> { return this.send({ kind: 'skip', direction }); }
  externalStop(): void { void this.stop(); }
  freeze(message: string): void { void this.send({ kind: 'freeze', message }); }
  reportUnavailable(message: string): void { void this.send({ kind: 'unavailable', message }); }
  runtimeUnavailable(message: string): void { void this.send({ kind: 'runtimeUnavailable', message }); }
  reportFault(message: string): void { void this.send({ kind: 'fault', message }); }
  setVolume(volume: number): void { void this.send({ kind: 'volume', volume }); }
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
  private async startCheck(itemId: string): Promise<{ topic: SongLightingStatus['state']; reason: string } | null> {
    const topic = songLightingStatus(this.project, itemId).state;
    let ports: string[] | null = null;
    // Only a ready song needs the present MIDI outputs.
    if (topic === 'ready') {
      try { ports = (await this.api.getNativePlaybackDevices()).midiOutputs.map(output => output.name); }
      catch (error) { return { topic, reason: `这首歌可演出，但时间码输出端口无法确认：${toUserErrorMessage(error)}` }; }
    }
    const reason = lightingStartCheck(this.project, itemId, { portName: this.dependencies.configuration().mtcPortName, ports });
    return reason ? { topic, reason } : null;
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
