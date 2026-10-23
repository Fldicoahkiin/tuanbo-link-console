import { emptyInternalPlayerState, type InternalPlayerState, type NativeProgramPlayer, type PlaybackBoundary } from '@tb/core/link';
import { nativeProgramOpenSchema, nativeProgramControlSchema, nativeProgramEventSchema, parseLinkProject,
  type LinkProject, type NativeProgramAttachment, type NativeProgramOpen, type NativeProgramConfiguration, type NativeProgramEvent } from '@tb/schema';

type Host = { controller: Pick<NativeProgramPlayer, keyof NativeProgramPlayer>; close(): Promise<void> };
type Entry = { request: NativeProgramOpen; projectId: string; document: string; host: Host | null; configuration: NativeProgramConfiguration;
  state: InternalPlayerState; sequence: number; currentCueId: string | null; cancelled: boolean; orphaned: boolean;
  cancellation: AbortController; ready: Promise<void> };
type Factory = (project: LinkProject, request: NativeProgramOpen, callbacks: {
  configuration(): NativeProgramConfiguration; changed(state: InternalPlayerState): void; cueChanged(id: string | null): void;
}) => Host;

/** Owns the single formal program session. Old UI disposal cannot stop a new
 * program; replacement waits for acknowledged cleanup, never starts a second output.
 * A program keeps running when its window's renderer exits, until a reloaded window
 * of the same project takes it over. */
export class NativeProgramService {
  private current: Entry | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  constructor(private readonly create: Factory, private readonly publish: (event: NativeProgramEvent) => void,
    private readonly authorize: () => Promise<void>) {}

  async open(value: unknown): Promise<NativeProgramAttachment> {
    const request = nativeProgramOpenSchema.parse(value);
    const project = parseLinkProject(JSON.parse(request.document));
    if (project.playbackSource !== 'internal') throw new Error('后台节目只接受内部主控工程');
    if (this.current?.request.ownerId === request.ownerId) throw new Error('节目控制会话编号重复');
    const previous = this.current, document = JSON.stringify(project);
    if (previous?.orphaned && active(previous.state)) {
      if (previous.request.projectPath !== request.projectPath || previous.projectId !== project.projectId) {
        throw new Error(`界面重新加载前的节目仍在播放：${previous.request.projectPath}。请打开该工程接管或停止播放`);
      }
      previous.orphaned = false; previous.request = request; previous.configuration = request.configuration;
      this.emit(previous);
      return previous.document === document ? 'adopted' : 'outdated';
    }
    const entry: Entry = { request, projectId: project.projectId, document, host: null, configuration: request.configuration,
      state: { ...emptyInternalPlayerState }, sequence: 0, currentCueId: null, cancelled: false, orphaned: false,
      cancellation: new AbortController(), ready: Promise.resolve() };
    if (previous) { previous.cancelled = true; previous.cancellation.abort(); this.enqueueClose(previous); }
    this.current = entry;
    entry.ready = this.cleanup.then(async () => {
      await this.authorized(entry.cancellation.signal);
      if (this.current !== entry || entry.cancelled) return;
      entry.host = this.create(project, request, {
        configuration: () => entry.configuration,
        changed: state => { entry.state = state; this.emit(entry); },
        cueChanged: id => { entry.currentCueId = id; this.emit(entry); }
      });
      entry.host.controller.clock.subscribeBoundary(boundary => this.emit(entry, boundary));
      this.emit(entry);
    });
    await entry.ready;
    return 'opened';
  }

  /** The owning window's renderer exited. A program that is preparing, playing or
   * paused keeps its outputs running and is returned; anything else is closed. */
  async release(): Promise<InternalPlayerState | null> {
    const entry = this.current;
    if (entry && active(entry.state)) { entry.orphaned = true; return entry.state; }
    await this.close();
    return null;
  }

  async control(value: unknown): Promise<void> {
    const request = nativeProgramControlSchema.parse(value), entry = this.current;
    if (!entry || entry.request.ownerId !== request.ownerId) {
      if (request.operation.kind === 'close') return;
      throw new Error('节目控制请求属于已关闭的界面会话');
    }
    if (request.operation.kind === 'close') { await this.close(); return; }
    await entry.ready;
    if (entry !== this.current || entry.cancelled || !entry.host) throw new Error('节目控制会话已取消');
    if (request.configuration) entry.configuration = request.configuration;
    const player = entry.host.controller, operation = request.operation;
    // Do not serialize transport here: stop must invalidate an in-flight play.
    switch (operation.kind) {
      case 'play': return player.play(operation.itemId, operation.positionMs, operation.paused);
      case 'pause': return player.pause();
      case 'resume': return player.resume();
      case 'stop': return player.stop();
      case 'reset': return player.reset();
      case 'toggle': return player.toggle();
      case 'toggleMtc': return player.toggleMtc();
      case 'seek': return player.seek(operation.positionMs);
      case 'scrub': return player.scrub(operation.itemId, operation.positionMs);
      case 'skip': return player.skip(operation.direction);
      case 'volume': return player.setVolume(operation.volume);
      case 'endAction': return player.setEndAction(operation.endAction);
      case 'playlist': return player.setPlaylist(operation.playlistId);
      case 'preload': return player.preloadSelected(operation.itemId);
      case 'fade': return player.fade(operation.out);
      case 'midi': return player.receiveMidi(Uint8Array.from(operation.bytes));
      case 'freeze': return player.freeze(operation.message);
      case 'unavailable': return player.reportUnavailable(operation.message);
      case 'runtimeUnavailable': return player.runtimeUnavailable(operation.message);
      case 'fault': return player.reportFault(operation.message);
      case 'configure': entry.configuration = operation.configuration; return;
    }
  }

  async close(): Promise<void> {
    const entry = this.current;
    if (entry) { this.current = null; entry.cancelled = true; entry.cancellation.abort(); this.enqueueClose(entry); }
    await this.cleanup;
  }
  private enqueueClose(entry: Entry): void {
    this.cleanup = this.cleanup.then(async () => {
      // Failed authorization creates no output. Its error is returned to open(),
      // while disposal still releases a host if construction succeeded.
      await entry.ready.then(() => entry.host?.close(), () => entry.host?.close());
    });
  }
  private async authorized(signal: AbortSignal): Promise<void> {
    let cancel: (() => void) | undefined;
    try {
      await Promise.race([this.authorize(), new Promise<void>(resolve => {
        cancel = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { if (cancel) signal.removeEventListener('abort', cancel); }
  }
  private emit(entry: Entry, boundary?: PlaybackBoundary): void {
    if (entry.cancelled || entry.orphaned || this.current !== entry) return;
    const clock = entry.host?.controller.clock.read() ?? { positionMs: entry.state.positionMs, durationMs: entry.state.durationMs,
      ready: false, playing: false, seeking: entry.state.status === 'preparing' };
    this.publish(nativeProgramEventSchema.parse({ version: 1, ownerId: entry.request.ownerId, sequence: ++entry.sequence,
      state: entry.state, clock, currentCueId: entry.currentCueId, ...(boundary ? { boundary } : {}) }));
  }
}

function active(state: InternalPlayerState): boolean {
  return state.status === 'preparing' || state.status === 'playing' || state.status === 'paused';
}
