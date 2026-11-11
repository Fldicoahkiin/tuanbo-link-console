import { emptyInternalPlayerState, type InternalPlayerState, type NativeProgramPlayer, type PlaybackBoundary } from '@tb/core/link';
import { nativeProgramOpenSchema, nativeProgramControlSchema, nativeProgramEventSchema, parseLinkProject,
  type LinkProject, type NativeProgramAttachment, type NativeProgramOpen, type NativeProgramConfiguration, type NativeProgramEvent } from '@tb/schema';
import type { ClosedProgramFaults } from './main-process-errors';

type Host = { controller: Pick<NativeProgramPlayer, keyof NativeProgramPlayer>; close(): Promise<void> };
type Entry = { request: NativeProgramOpen; projectId: string; document: string; host: Host | null; configuration: NativeProgramConfiguration;
  state: InternalPlayerState; sequence: number; currentCueId: string | null; cancelled: boolean; orphaned: boolean;
  cancellation: AbortController; ready: Promise<void> };
type Factory = (project: LinkProject, request: NativeProgramOpen, callbacks: {
  configuration(): NativeProgramConfiguration; changed(state: InternalPlayerState): void; cueChanged(id: string | null): void;
  /** A failure no player state shows (the player closed, or plays on without a window): logged and shown in red. Without
   * `kind`, the lights-off a stop owed, which the quit asks about (ClosedProgramFaults.collect); `leftOpen`, the action
   * MIDI the close left open, which it does not (2026-11-11). */
  closedFault(message: string, itemId: string | null, kind?: 'leftOpen'): void;
}) => Host;

/** Owns the single formal program session. Old UI disposal cannot stop a new
 * program; replacement waits for acknowledged cleanup, never starts a second output.
 * A program keeps running when its window's renderer exits or its page reloads, until
 * the next page of the same project takes it over. */
export class NativeProgramService {
  private current: Entry | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  private running = false;
  /** Every argument is required, so link-main cannot leave one out:
   * - `runningChanged`: the program started or stopped preparing, playing or paused, attached to a window or not; the
   *   license session of the show follows it (link-main passes `programLicense(...).runningChanged`, which reaches
   *   LicenseAccess; license-rules.test.ts checks that path).
   * - `faults`: where a failure goes that no player state shows. The service tells it when no window can show it (the
   *   window's page is gone) and when a window opened a program again. */
  constructor(private readonly create: Factory, private readonly publish: (event: NativeProgramEvent) => void,
    private readonly authorize: () => Promise<void>, private readonly runningChanged: (running: boolean) => void,
    private readonly faults: ClosedProgramFaults) {}

  /** `checkProject`: the window names the project the program reads; checked before a host is created. */
  async open(value: unknown, checkProject?: (projectPath: string, project: LinkProject) => Promise<void>): Promise<NativeProgramAttachment> {
    // A window opens a program only after it subscribed to main-process errors (LinkApp): red text reaches it from
    // now on, also when this open is refused.
    this.faults.windowOpened();
    const request = nativeProgramOpenSchema.parse(value);
    const project = parseLinkProject(JSON.parse(request.document));
    if (project.playbackSource !== 'internal') throw new Error('只有“联动台播放”的工程才能在后台播放');
    if (this.current?.request.ownerId === request.ownerId) throw new Error('节目控制会话编号重复');
    const previous = this.current, document = JSON.stringify(project);
    if (previous?.orphaned && active(previous.state)) {
      if (previous.request.projectPath !== request.projectPath || previous.projectId !== project.projectId) {
        // There is no control here for the program playing in the background: only its own project takes it back (2026-11-10).
        throw new Error(`界面重新加载前的节目还在后台播放，现在打开的工程不能播放。请打开工程「${previous.request.projectPath}」接回控制，再在那里停止播放`);
      }
      previous.orphaned = false; previous.request = request; previous.configuration = request.configuration;
      previous.host?.controller.setWatched(true);
      this.emit(previous);
      return previous.document === document ? 'adopted' : 'outdated';
    }
    const entry: Entry = { request, projectId: project.projectId, document, host: null, configuration: request.configuration,
      state: { ...emptyInternalPlayerState }, sequence: 0, currentCueId: null, cancelled: false, orphaned: false,
      cancellation: new AbortController(), ready: Promise.resolve() };
    if (previous) { previous.cancelled = true; previous.cancellation.abort(); this.enqueueClose(previous); }
    this.current = entry; this.reportRunning();
    entry.ready = this.cleanup.then(async () => {
      await this.authorized(entry.cancellation.signal);
      await checkProject?.(request.projectPath, project);
      if (this.current !== entry || entry.cancelled) return;
      entry.host = this.create(project, request, {
        configuration: () => entry.configuration,
        changed: state => { entry.state = state; this.reportRunning(); this.emit(entry); },
        cueChanged: id => { entry.currentCueId = id; this.emit(entry); },
        closedFault: (message, itemId, kind) => {
          if (!kind) { this.faults.report(message, { projectId: entry.projectId, itemId }); return; }
          this.faults.closeFailed(message, { level: 'error', category: 'device', device: '动作 MIDI', projectId: entry.projectId,
            ...(itemId ? { itemId } : {}), message, result: 'failed' });
        }
      });
      entry.host.controller.clock.subscribeBoundary(boundary => this.emit(entry, boundary));
      this.emit(entry);
    });
    await entry.ready;
    return 'opened';
  }

  /** The owning window's page is gone: its renderer exited, or a new page replaced it (window-page.ts). A program that
   * is preparing, playing or paused keeps its outputs running and is returned, and `teardown` does not run; anything
   * else is closed, and then `teardown` runs on the close chain (link-main's releaseGonePage: the audio engine, the
   * picture and the runtime the gone page held). Only what that page held: a program the next page opened meanwhile
   * stays open and keeps them, so `teardown` is left out; one it opens while `teardown` runs waits for it (2026-11-10).
   * A failed `teardown` is returned here and does not hold up later programs. Until a window opens a program again, no
   * window shows red text: what fails meanwhile waits for it. */
  async release(teardown: () => Promise<void> = () => Promise.resolve()): Promise<InternalPlayerState | null> {
    this.faults.windowExited();
    const entry = this.current;
    if (entry && active(entry.state)) { entry.orphaned = true; entry.host?.controller.setWatched(false); return entry.state; }
    if (entry) this.retire(entry);
    const released = this.cleanup.then(async (): Promise<{ failed: unknown } | null> => {
      if (this.current) return null;
      try { await teardown(); return null; } catch (error) { return { failed: error }; }
    });
    // A program that could not close keeps blocking new ones, as close() does.
    this.cleanup = released.then(() => undefined);
    const result = await released;
    if (result) throw result.failed;
    return null;
  }

  async control(value: unknown): Promise<void> {
    const request = nativeProgramControlSchema.parse(value), entry = this.current;
    if (!entry || entry.request.ownerId !== request.ownerId) {
      if (request.operation.kind === 'close') return;
      // The program this window opened is closed (by the quit, a page reload or a newer program); a window the quit
      // returned to opens a new one by itself (NativeProgramClosed).
      throw new Error('这个窗口的节目已经关了，这次操作没有执行。请重新打开工程，再开始播放');
    }
    if (request.operation.kind === 'close') { await this.close(); return; }
    await entry.ready;
    if (entry !== this.current || entry.cancelled || !entry.host) throw new Error('播放控制已取消');
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
    if (this.current) this.retire(this.current);
    await this.cleanup;
  }
  /** The window whose program is open (the ownerId its controller opened it with); null when none is, and while the
   * program plays on with no window (its page is gone). */
  owner(): string | null {
    return this.current && !this.current.orphaned ? this.current.request.ownerId : null;
  }
  /** The current program is closed: nothing reaches it any more, and a new one waits for its outputs. */
  private retire(entry: Entry): void {
    this.current = null; entry.cancelled = true; entry.cancellation.abort(); this.enqueueClose(entry); this.reportRunning();
  }
  private reportRunning(): void {
    const running = this.current !== null && active(this.current.state);
    if (running === this.running) return;
    this.running = running; this.runningChanged(running);
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
