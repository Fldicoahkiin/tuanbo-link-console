import { applyProjectItemsChange, emptyInternalPlayerState, previousNotStopped, projectFileReferences, toUserErrorReason, type InternalPlayerState, type NativeProgramPlayer, type PlaybackBoundary } from '@tb/core/link';
import { nativeProgramOpenSchema, nativeProgramControlSchema, nativeProgramDocumentSchema, nativeProgramEventSchema, nativeProgramStartsSong, parseLinkProject,
  type NativeProgramDocument,
  type LinkProject, type NativeProgramAttachment, type NativeProgramDocumentAnswer, type NativeProgramDocumentVersion, type NativeProgramOpen,
  type NativeProgramConfiguration, type NativeProgramEvent } from '@tb/schema';
import type { ClosedProgramFaults } from './main-process-errors';

type Host = { controller: Pick<NativeProgramPlayer, keyof NativeProgramPlayer>; close(): Promise<void>;
  /** Reads the audio engine now, not a status kept from before (0.5.9 S6): true once it has stopped. Asked only after
   * this host's close failed. A host that cannot tell is taken as still sounding. */
  engineStopped?(): boolean };
/** A version of the window's project the program has (0.5.9 S7). */
type Version = { project: LinkProject; version: NativeProgramDocumentVersion };
/** The program of one window's page, from its open until it closes (0.5.9 S7: one session, not one per edit). `project`
 * and `version` are the newest version it has (0.5.9 S8a: a held song takes it as it arrives, liveRevisionEffect);
 * `versions` names each project it was given, so an event says which one the held song's picture follows. */
type Entry = { request: NativeProgramOpen; projectId: string; project: LinkProject; version: NativeProgramDocumentVersion;
  versions: WeakMap<LinkProject, NativeProgramDocumentVersion>; host: Host | null; configuration: NativeProgramConfiguration;
  state: InternalPlayerState; currentCueId: string | null; cancelled: boolean; orphaned: boolean;
  cancellation: AbortController; ready: Promise<void>;
  /** The page's versions in the order it sent them (0.5.9 S9): each is checked (its files too) before the next, and a
   * control that starts a song waits for them. Never rejected. */
  documents: Promise<void>;
  /** Controls other than stop and reset, in the order the page sent them: each is dispatched after the one before it,
   * and one that starts a song after the versions sent before it. Never rejected. */
  turn: Promise<void>;
  /** Stops and resets so far: a song start still waiting when one came is not played (the stop came after it). */
  stops: number;
  /** Builds this entry's host on the close chain; again when the operator presses stop after `heldBack`. */
  start: () => Promise<void>;
  /** Its open was refused because the program before it had not stopped (`held`). */
  heldBack: boolean };
/** A program whose close failed with its audio engine not stopped: no new program opens while that engine still sounds. */
type Held = { host: Host; reason: string };
type Factory = (project: LinkProject, request: NativeProgramOpen, callbacks: {
  configuration(): NativeProgramConfiguration; changed(state: InternalPlayerState): void; cueChanged(id: string | null): void;
  /** A failure no player state shows (the player closed, or plays on without a window): logged and shown in red. Without
   * `kind`, the lights-off a stop owed, which the quit asks about (ClosedProgramFaults.collect); `leftOpen`, the action
   * MIDI the close left open, which it does not (2026-11-11). */
  closedFault(message: string, itemId: string | null, kind?: 'leftOpen'): void;
}) => Host;

/** The program as the show state reads it (ShowStateService): the player's state, the project it plays and whether a
 * window shows it (false while it plays on after its page is gone). */
export type NativeProgramSnapshot = { state: InternalPlayerState; projectPath: string; projectId: string; watched: boolean };

/** Owns the single formal program session (0.5.9 S7, design 02 §3.2). A window's page opens it once; the page's edits
 * reach it as versions (`document`), so editing never closes or opens it again: it ends at the quit, when its page is
 * gone with nothing held, when the page leaves 联动台播放 (close), or when the page opens another project or path. Old UI
 * disposal cannot stop a new program; replacement waits for acknowledged cleanup, never starts a second output. A
 * program keeps running when its window's renderer exits or its page reloads, until the next page of the same project
 * takes it over. */
export class NativeProgramService {
  private current: Entry | null = null;
  /** Closes and openings in turn. Never rejected (0.5.9 S6): one close that fails holds up no later close or open; what it
   * leaves behind is `held`, and its caller still gets the failure. */
  private cleanup: Promise<void> = Promise.resolve();
  private held: Held | null = null;
  private running = false;
  /** Event order across every program of the app: a page keeps one owner for all the programs it opens (0.5.9 S7), and
   * drops an event not newer than the last it heard, so a new program's events never count from 0 again. */
  private sequence = 0;
  private readonly stateListeners = new Set<() => void>();
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
    const previous = this.current, version = { sessionId: request.sessionId, revision: request.revision };
    // The same page opens again only for another project or path, or after its open failed: never in place of the song
    // it holds (opening another project waits for 停止 in the window).
    if (previous?.request.ownerId === request.ownerId && active(previous.state)) throw new Error('节目还在播放，现在不能换工程。请先停止播放');
    if (previous?.orphaned && active(previous.state)) {
      if (previous.request.projectPath !== request.projectPath || previous.projectId !== project.projectId) {
        // There is no control here for the program playing in the background: only its own project takes it back (2026-11-10).
        throw new Error(`界面重新加载前的节目还在后台播放，现在打开的工程不能播放。请打开工程「${previous.request.projectPath}」接回控制，再在那里停止播放`);
      }
      const same = JSON.stringify(previous.project) === JSON.stringify(project);
      // The same document is this page's version already. Another one is the newest from now on: the song held plays
      // on as it started (0.5.9 S8a), its picture following a version this page never had, and the next song plays it.
      if (same) { previous.version = version; previous.versions.set(previous.project, version); } else this.apply(previous, { project, version });
      previous.orphaned = false; previous.request = request; previous.configuration = request.configuration;
      previous.host?.controller.setWatched(true);
      this.stateChanged();
      this.emit(previous);
      return same ? 'adopted' : 'outdated';
    }
    const entry: Entry = { request, projectId: project.projectId, project, version, versions: new WeakMap([[project, version]]), host: null, configuration: request.configuration,
      state: { ...emptyInternalPlayerState }, currentCueId: null, cancelled: false, orphaned: false,
      cancellation: new AbortController(), ready: Promise.resolve(), documents: Promise.resolve(), turn: Promise.resolve(), stops: 0, start: () => Promise.resolve(), heldBack: false };
    // Nobody waits for this close: what fails in it is logged and shown here, and stays `held` if the engine went on.
    if (previous) { previous.cancelled = true; previous.cancellation.abort(); void this.enqueueClose(previous).catch((error: unknown) => this.closeFailed(previous, error)); }
    this.current = entry; this.reportRunning();
    entry.start = async () => {
      this.letGo(entry);
      await this.authorized(entry.cancellation.signal);
      await checkProject?.(request.projectPath, project);
      // A program builds at most one host.
      if (this.current !== entry || entry.cancelled || entry.host) return;
      // The version the page sent last, also one that reached it while this was authorized.
      entry.host = this.create(entry.project, { ...request, revision: entry.version.revision }, {
        configuration: () => entry.configuration,
        changed: state => {
          entry.state = state;
          this.reportRunning(); this.emit(entry);
        },
        cueChanged: id => { entry.currentCueId = id; this.emit(entry); },
        closedFault: (message, itemId, kind) => {
          if (!kind) { this.faults.report(message, { projectId: entry.projectId, itemId }); return; }
          this.faults.closeFailed(message, { level: 'error', category: 'device', device: '动作 MIDI', projectId: entry.projectId,
            ...(itemId ? { itemId } : {}), message, result: 'failed' });
        }
      });
      entry.host.controller.clock.subscribeBoundary(boundary => this.emit(entry, boundary));
      this.emit(entry);
    };
    entry.ready = this.cleanup.then(entry.start);
    await entry.ready;
    return 'opened';
  }

  /** A newer version of the page's project (0.5.9 S7, S8a, S9; design 02 §3.3–§3.5, §3.7), needing no license: it only
   * changes what the program holds in memory. The next song plays it; a song held plays on as it started and takes of
   * it only what liveRevisionEffect says (answered `live`). A page whose program closed, another page, and another
   * project or path are refused: those open again. Applied in the order the page sent them, before any later control
   * of the page that starts a song.
   * A version is the whole document or an increment on the newest version the program has (`base`); an increment on
   * any other version is answered `resync`, and the page sends the whole document. Both
   * pass the same checks: the whole project as `parseLinkProject` checks it, and the files it references inside the
   * project's folder (`checkFiles`, as an open checks them; an increment, the files the version before did not have). */
  async document(value: unknown, checkFiles: (projectPath: string, relativePaths: string[]) => Promise<void>): Promise<NativeProgramDocumentAnswer> {
    const request = nativeProgramDocumentSchema.parse(value), entry = this.current;
    if (!entry || entry.cancelled || entry.orphaned || entry.request.ownerId !== request.ownerId) throw new Error(PROGRAM_CLOSED);
    const received = entry.documents.then(() => this.receive(entry, request, checkFiles));
    entry.documents = received.then(() => undefined, () => undefined);
    return received;
  }

  private async receive(entry: Entry, request: NativeProgramDocument,
    checkFiles: (projectPath: string, relativePaths: string[]) => Promise<void>): Promise<NativeProgramDocumentAnswer> {
    if (!this.receiving(entry, request.ownerId)) throw new Error(PROGRAM_CLOSED);
    if (request.key.projectId !== entry.projectId || request.key.projectPath !== entry.request.projectPath) {
      throw new Error('这一版属于另一个工程，节目没有换工程。请重新打开工程');
    }
    // The newest version this program has, also while a song is held.
    const latest: Version = { project: entry.project, version: entry.version };
    let project: LinkProject, known: ReadonlySet<string>;
    if (request.change.kind === 'full') {
      project = parseLinkProject(JSON.parse(request.change.document)); known = new Set();
    } else {
      if (request.base !== latest.version.revision || request.key.sessionId !== latest.version.sessionId) {
        return { kind: 'resync', reason: '节目这边没有这次修改所基于的版本' };
      }
      project = applyProjectItemsChange(latest.project, request.change);
      known = new Set(projectFileReferences(latest.project).map(file => file.relativePath));
    }
    if (project.projectId !== entry.projectId) throw new Error('这一版属于另一个工程，节目没有换工程。请重新打开工程');
    if (project.playbackSource !== 'internal') throw new Error('只有“联动台播放”的工程才能在后台播放');
    await checkFiles(entry.request.projectPath, projectFileReferences(project).map(file => file.relativePath).filter(path => !known.has(path)));
    if (!this.receiving(entry, request.ownerId)) throw new Error(PROGRAM_CLOSED);
    const next: Version = { project, version: { sessionId: request.key.sessionId, revision: request.revision } };
    const live = active(entry.state);
    this.apply(entry, next); this.emit(entry);
    return { kind: 'applied', revision: request.revision, effect: live ? 'live' : 'stopped' };
  }
  /** `entry` is the open program of the page `ownerId`, shown in its window. */
  private receiving(entry: Entry, ownerId: string): boolean {
    return entry === this.current && !entry.cancelled && !entry.orphaned && entry.request.ownerId === ownerId;
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
    if (entry && active(entry.state)) { entry.orphaned = true; entry.host?.controller.setWatched(false); this.stateChanged(); return entry.state; }
    const closed = entry ? this.retire(entry).then(() => null, (error: unknown) => ({ failed: error })) : Promise.resolve(null);
    const released = this.cleanup.then(async (): Promise<{ failed: unknown } | null> => {
      // A program that did not close is returned, and its outputs are left as they are; it is `held` for the next open.
      const failure = await closed;
      if (failure || this.current) return failure;
      try { await teardown(); return null; } catch (error) { return { failed: error }; }
    });
    // Never rejected: a failed close or teardown holds up no later close or open.
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
      throw new Error(PROGRAM_CLOSED);
    }
    if (request.operation.kind === 'close') { await this.close(); return; }
    // A song starts with every version the page sent before it (0.5.9 S9). Stop never waits: a song start still waiting
    // for its versions is not played, as it would have been stopped; the other controls keep their order behind it.
    const kind = request.operation.kind, starts = nativeProgramStartsSong(kind), stops = entry.stops;
    let turn: Promise<void> | null = null;
    if (kind === 'stop' || kind === 'reset') entry.stops += 1;
    else {
      const documents = entry.documents;
      turn = entry.turn.then(() => starts ? documents : undefined);
      entry.turn = turn;
    }
    // Refused because the song before had not stopped: stop is the operator asking again (not a retry of ours). The
    // engine is read once more; stopped now, this program opens and the next play plays, else the same refusal.
    // One start at a time: `heldBack` is cleared as this one begins (letGo sets it again on a refusal), so a stop pressed
    // meanwhile waits for the same `ready` below and gets the same answer: the refusal, or a normal stop once open.
    if (request.operation.kind === 'stop' && entry.heldBack) { entry.heldBack = false; entry.ready = this.cleanup.then(entry.start); await entry.ready; return; }
    await entry.ready;
    if (turn) await turn;
    if (entry !== this.current || entry.cancelled || !entry.host) throw new Error('播放控制已取消');
    if (starts && entry.stops !== stops) return;
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
      case 'volume': return player.previewVolume(operation.itemId, operation.volume);
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

  /** Closes the current program; its caller sees a close that failed (in red, and in the log). */
  async close(): Promise<void> {
    const closing = this.current ? this.retire(this.current) : null;
    await this.cleanup;
    await closing;
  }
  /** The window whose program is open (the ownerId its controller opened it with); null when none is, and while the
   * program plays on with no window (its page is gone). */
  owner(): string | null {
    return this.current && !this.current.orphaned ? this.current.request.ownerId : null;
  }
  /** The open program, also while it plays on with no window; null when none is open. */
  snapshot(): NativeProgramSnapshot | null {
    const entry = this.current;
    return entry ? { state: entry.state, projectPath: entry.request.projectPath, projectId: entry.projectId, watched: !entry.orphaned } : null;
  }
  /** Called after every change `snapshot()` shows: a program opened, taken over, left without a window or closed, and
   * every player state. */
  onStateChanged(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }
  /** `next` is the newest version from now on: the next song plays it, a song held takes what liveRevisionEffect says;
   * with no host yet, the host is built with it. */
  private apply(entry: Entry, next: Version): void {
    entry.project = next.project; entry.version = next.version; entry.versions.set(next.project, next.version);
    entry.host?.controller.updateProject(next.project, next.version.revision, entry.request.projectPath);
  }
  /** The current program is closed: nothing reaches it any more, and a new one waits for its outputs. */
  private retire(entry: Entry): Promise<void> {
    this.current = null; entry.cancelled = true; entry.cancellation.abort();
    const closing = this.enqueueClose(entry); this.reportRunning();
    return closing;
  }
  private stateChanged(): void {
    for (const listener of this.stateListeners) listener();
  }
  /** The license session follows whether the program runs; the show state follows every change. */
  private reportRunning(): void {
    this.stateChanged();
    const running = this.current !== null && active(this.current.state);
    if (running === this.running) return;
    this.running = running; this.runningChanged(running);
  }
  /** The close of `entry`, on the close chain. Its caller gets the failure; the chain does not (0.5.9 S6): a host that did
   * not close is `held` until its engine is read as stopped, and later closes still run. */
  private enqueueClose(entry: Entry): Promise<void> {
    // Failed authorization creates no output. Its error is returned to open(),
    // while disposal still releases a host if construction succeeded.
    const closing = this.cleanup.then(() => entry.ready.then(() => entry.host?.close(), () => entry.host?.close()));
    this.cleanup = closing.then(() => undefined, (error: unknown) => {
      if (entry.host) this.held = { host: entry.host, reason: toUserErrorReason(error).replace(/[。.；;\s]+$/u, '') || '未知错误' };
    });
    return closing;
  }
  /** Before a program opens: the one before it that did not close is read again now. Stopped, it is let go; still
   * sounding, this open is refused, and pressing stop asks again (control). Never a second engine beside a sounding one. */
  private letGo(entry: Entry): void {
    const held = this.held;
    entry.heldBack = false;
    if (!held) return;
    if (held.host.engineStopped?.() !== true) { entry.heldBack = true; throw new Error(previousNotStopped(held.reason)); }
    this.held = null;
  }
  /** A close nobody waits for failed (a newer program replaced it): logged as an error and shown in red once. */
  private closeFailed(entry: Entry, error: unknown): void {
    const reason = toUserErrorReason(error).replace(/[。.；;\s]+$/u, '') || '未知错误';
    this.faults.closeFailed(`上一个节目没能正常关掉：${reason}。如果还听得到上一首，请按停止`,
      { level: 'error', category: 'device', device: '播放器', projectId: entry.projectId, message: `上一个节目没能正常关掉：${reason}`, result: 'failed' });
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
    // The project the held song's picture follows, as the version the program was given it with (0.5.9 S8a).
    const picture = entry.host ? entry.versions.get(entry.host.controller.currentProject()) ?? entry.version : entry.version;
    this.publish(nativeProgramEventSchema.parse({ version: 1, ownerId: entry.request.ownerId, sequence: ++this.sequence,
      state: entry.state, clock, currentCueId: entry.currentCueId, documentVersion: entry.version, pictureVersion: picture, ...(boundary ? { boundary } : {}) }));
  }
}

/** What a page is told whose program is closed (by the quit, a page reload or a newer program); a page the quit
 * returned to opens a new one by itself (NativeProgramClosed). */
const PROGRAM_CLOSED = '这个窗口的节目已经关了，这次操作没有执行。请重新打开工程，再开始播放';

function active(state: InternalPlayerState): boolean {
  return state.status === 'preparing' || state.status === 'playing' || state.status === 'paused';
}
