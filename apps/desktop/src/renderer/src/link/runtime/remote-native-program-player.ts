import { emptyInternalPlayerState, isPreviousNotStopped, nativeAudioAnalysis, toUserErrorMessage,
  type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi, type PlaybackBoundary, type PlaybackClock } from '@tb/core/link';
import { nativeProgramStartsSong, type LinkProject, type NativePlayerStatus, type NativeProgramEvent, type NativeProgramOperation } from '@tb/schema';
import { ProgramDocumentFeed, programVersionKey, type ProgramDocument } from './program-document-feed';

type Api = Pick<LinkDesktopApi, 'openNativeProgram' | 'controlNativeProgram' | 'documentNativeProgram' | 'onNativeProgramEvent' | 'onNativeProgramClosed' | 'onNativePlaybackStatus'>;
/** What the window supplies: settings to play with, the project as the window has it, and where to show and log what
 * happens. */
export type RemotePlayerDependencies = Pick<InternalPlayerDependencies, 'configuration' | 'changed' | 'preciseSeeking'> & {
  /** The window's project now (the document store), sent whole at the open and as each newer version (0.5.9 S7); null
   * when it has none for 联动台播放 (none open, or it follows P1: the window closes this program then). */
  document: () => ProgramDocument | null;
  notice: (message: string, itemId: string | null) => void;
  /** The whole project as the program reads it, encoded off the window's thread and apart from saving (0.5.9 S9). */
  encode: (project: LinkProject) => Promise<string>;
  /** The background program answered an open of this page: which version it plays is known from now on (`project`). */
  attached: () => void;
};

/** The page's own name for the program it opens (0.5.9 S7, design 02 §3.2): made once as the page loads, so a page
 * that opens the program again (another project, after the quit was cancelled) is still the same page to main. */
export const PROGRAM_PAGE_OWNER = crypto.randomUUID();

/** UI controller is a remote for the main-process program host. It never schedules playback, sends lighting, or
 * invents time while the UI is busy. One per window page (0.5.9 S7): it opens the program once and sends each newer
 * version of the project to it, so editing never closes or opens the program. It opens again only when the page
 * opens another project or path (once no song is held), after an open that failed (at the next edit, as a new open
 * did before), and when the quit closed the program and the operator went back to the app. */
export class RemoteNativeProgramPlayer {
  /** The open; replaced by each new open, and once a stop pressed after a refused open has opened the program (send). */
  private ready: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly boundaries = new Set<(boundary: PlaybackBoundary) => void>();
  private state: InternalPlayerState = { ...emptyInternalPlayerState };
  private clockState = { positionMs: 0, durationMs: 0, ready: false, playing: false, seeking: false };
  private native: NativePlayerStatus | null = null;
  private sequence = -1;
  private disposed = false;
  /** Controls other than stop and reset, in the order they were pressed: one that may start a song goes after the
   * newest version of the project (ProgramDocumentFeed.flush), and the others after it. */
  private turn: Promise<void> = Promise.resolve();
  /** Stops and resets so far: a song start still waiting for its version when one was pressed is not sent. */
  private stops = 0;
  /** Where the page's program is: `opening` (the version it opens with), `open`, `refused` (its open waits for the
   * song before to stop: send), `failed` (the next edit opens again). */
  private link: { kind: 'opening' | 'open' | 'refused'; document: ProgramDocument } | { kind: 'failed' } = { kind: 'failed' };
  private readonly feed: ProgramDocumentFeed;
  /** The newest version the program holds, and the one the held song's picture follows, as its last event said. */
  private onAir: string | null = null;
  private picture: string | null = null;
  private readonly analysis = nativeAudioAnalysis(() => this.native?.itemId === this.state.itemId ? this.native : null);
  readonly clock: PlaybackClock = {
    read: () => this.clockState,
    subscribeBoundary: listener => { this.boundaries.add(listener); return () => { this.boundaries.delete(listener); }; }
  };

  constructor(private readonly dependencies: RemotePlayerDependencies, private readonly api: Api,
    private readonly observed: (event: NativeProgramEvent) => void, private readonly ownerId: string = PROGRAM_PAGE_OWNER) {
    this.feed = new ProgramDocumentFeed(ownerId, () => this.disposed ? null : this.dependencies.document(),
      request => this.api.documentNativeProgram(request), message => this.dependencies.notice(message, this.state.itemId),
      project => this.dependencies.encode(project));
    const program = api.onNativeProgramEvent(event => {
      if (this.disposed || event.ownerId !== this.ownerId || event.sequence <= this.sequence) return;
      this.sequence = event.sequence;
      const ids = event.state.playedItemIds;
      // IPC copies arrays; preserve stable control state during device-clock updates.
      this.state = { ...event.state, playedItemIds: ids.length === this.state.playedItemIds.length
        && ids.every((id, index) => id === this.state.playedItemIds[index]) ? this.state.playedItemIds : ids };
      this.clockState = event.clock;
      this.onAir = programVersionKey(event.documentVersion); this.picture = programVersionKey(event.pictureVersion);
      this.feed.named([this.onAir, this.picture]);
      this.dependencies.changed(this.state); this.observed(event);
      if (event.boundary) for (const listener of this.boundaries) listener(event.boundary);
      // Another project waited for the held song to stop.
      if (this.link.kind === 'open' && !holds(this.state.status)) this.documentChanged();
    });
    // The quit closed this page's program and the operator went back to the app: it opens again, so the next song plays.
    const closed = api.onNativeProgramClosed(event => { if (!this.disposed && event.ownerId === this.ownerId) this.open(); });
    const audio = api.onNativePlaybackStatus(status => { if (!this.disposed) this.native = status; });
    this.unsubscribe = () => { program(); closed(); audio(); };
    this.open();
  }
  /** The window's project changed (the document store): the program gets the new version; another project or path, or
   * a program whose open failed, opens again. */
  documentChanged(): void {
    if (this.disposed) return;
    const link = this.link;
    if (link.kind === 'failed') { this.open(); return; }
    if (link.kind !== 'open') return;
    const document = this.dependencies.document();
    if (!document) return;
    if (document.path === link.document.path && document.project.projectId === link.document.project.projectId) { this.feed.changed(); return; }
    // Another project or path is another program, once the held song has stopped (the window waits for 停止 to open one).
    if (!holds(this.state.status)) this.open();
  }
  /** The newest version the program holds (the next song plays it); null while unknown (not answered yet, or a program
   * taken over after a reload whose version this page never had). */
  get project(): LinkProject | null { return this.link.kind === 'open' && this.onAir ? this.feed.project(this.onAir) : null; }
  /** The version the picture of the song on stage follows (0.5.9 S8a): while a song is held, the one it started with;
   * null while unknown, as `project`. */
  get pictureProject(): LinkProject | null { return this.link.kind === 'open' && this.picture ? this.feed.project(this.picture) : null; }
  /** Whether the program answered this page's open. */
  get attached(): boolean { return this.link.kind === 'open'; }
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
  /** The device settings changed: the program plays with them from the next song on (a song held keeps its sound card). */
  configure(): void { void this.send({ kind: 'configure', configuration: this.configuration() }); }
  getAudioAnalysis() { return this.state.status === 'playing' ? this.analysis : null; }
  /** The page leaves 联动台播放: its program closes. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.boundaries.clear(); this.feed.detached();
    // Close is sent immediately, including while open is waiting for authorization.
    await this.api.controlNativeProgram({ version: 1, ownerId: this.ownerId, operation: { kind: 'close' } });
  }
  private open(): void {
    const document = this.dependencies.document();
    this.feed.detached();
    // Nothing to open: the window closes this program (useInternalPlayer); the next edit with a project opens it.
    if (!document) { this.link = { kind: 'failed' }; return; }
    this.link = { kind: 'opening', document };
    const link = this.link;
    // Encoded off this thread (0.5.9 S9). A page that closed or opened again meanwhile sends nothing.
    const opening = this.dependencies.encode(document.project).then(async content => {
      if (this.disposed || this.link !== link) return;
      await this.api.openNativeProgram({ version: 1, ownerId: this.ownerId, projectPath: document.path, revision: document.revision,
        sessionId: document.sessionId, document: content, configuration: this.configuration() });
      if (this.disposed || this.link !== link) return;
      this.attach(document);
    });
    this.ready = opening;
    void opening.catch(error => {
      if (this.disposed || this.link !== link) return;
      // Refused because the song before had not stopped: stop asks again (send). Any other refusal: the next edit opens again.
      this.link = isPreviousNotStopped(error) ? { kind: 'refused', document } : { kind: 'failed' };
      this.failed(error);
    });
  }
  private attach(document: ProgramDocument): void {
    this.link = { kind: 'open', document };
    this.feed.attached(document);
    this.dependencies.attached();
    // An edit made while it opened: another project opens again, the same one is sent (attached sent it already).
    this.documentChanged();
  }
  private configuration() { return { ...this.dependencies.configuration(), preciseSeeking: this.dependencies.preciseSeeking?.() ?? false }; }
  private async send(operation: NativeProgramOperation): Promise<void> {
    try {
      // The open was refused because the song before had not stopped (0.5.9 S6): stop asks the program again, and once
      // it opens, the other controls work again. Any other refused open stays as it was.
      const link = this.link;
      if (operation.kind === 'stop' && link.kind === 'refused') {
        await this.api.controlNativeProgram({ version: 1, ownerId: this.ownerId, operation, configuration: this.configuration() });
        this.ready = Promise.resolve();
        if (!this.disposed && this.link === link) this.attach(link.document);
        return;
      }
      await this.ready;
      if (this.disposed) return;
      // Stop never waits: a song start still waiting for its version is not sent, as it would have been stopped.
      if (operation.kind === 'stop' || operation.kind === 'reset') this.stops += 1;
      else {
        const starts = nativeProgramStartsSong(operation.kind), stops = this.stops;
        const turn = this.turn.then(() => starts ? this.feed.flush() : undefined);
        this.turn = turn;
        await turn;
        if (this.disposed || (starts && stops !== this.stops)) return;
      }
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

function holds(status: InternalPlayerState['status']): boolean {
  return status === 'preparing' || status === 'playing' || status === 'paused';
}
