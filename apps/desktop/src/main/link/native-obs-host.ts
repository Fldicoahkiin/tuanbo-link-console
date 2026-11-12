import { ObsPictureLeftover, ObsProgramSession, obsRecoveryText, OUTPUT_RECOVERY_RULES, OutputRecovery, pictureCleanupReason, pictureErrorDetail, projectFromObsSnapshot,
  type ObsProgramSessionDependencies, type ProgramClock } from '@tb/core/link';
import { nativeObsNextSchema, nativeObsPrepareSchema, type LinkProject, nativeObsStopSchema, type NativeObsNext, nativeObsStatusSchema, type NativeObsPrepare, type NativeObsStop, type NativeObsStatus, type NativePlayerStatus, type NativePlayerControl, type ObsPictureItem } from '@tb/schema';
import { ObsPreparationCancelled } from './native-obs-outputs';

type Outputs = Omit<ObsProgramSessionDependencies, 'state' | 'cueReport' | 'mediaReport' | 'fault' | 'clearFault' | 'pictureItems' | 'pictureFollow'> & {
  /** Prepares this song's owned scenes again after OBS reconnects; starts no decoder. */
  restoreScenes?: (assertCurrent: () => void) => Promise<void>;
  /** After the song stopped: the decoders holding its last frame, by clip (R14). */
  heldDecoders?: () => ReadonlyMap<string, string>;
  /** A later song takes that decoder over; `reuse` when it shows it on as it is. */
  handOver?: (sourceName: string, reuse: boolean) => Promise<void>;
};
/** `cleanup`: this song's picture cleanup, run once. `leftover`: why it failed, until the program has heard it once
 * (a program that closed before it could show it hands it back, for the next song). */
/** `connection`: OBS is away, which the picture waits for (design 01 §4.5, R7), listed with the session's own parts
 * (`parts`) and recovery counts (`counts`). `restores`: this song's picture restored after OBS came back (obs.restore).
 * `lost`: the preparation failed while OBS was away; it is prepared again, at the position then, once OBS is back.
 * `rejoin`: prepared (again) while the music was not where it was prepared: at the first clock of the music the picture
 * is rebuilt at the current position, after this (the owned scenes prepared again, or nothing).
 * `started`: the music clocked this picture once. `released`: what the stop left on its last frame is being taken off (R14).
 * `next`: the next song's files as last asked for (the request's, or a later prepareNext); `nextTurn` counts those asks,
 * and `nextTask` is the one preparation of them in flight. */
type Entry = { request: NativeObsPrepare; project: LinkProject; session: ObsProgramSession; state: NativeObsStatus; awaitingPause: boolean; ended: boolean; filesStarted: boolean;
  now: () => number; restoreScenes: Outputs['restoreScenes']; cleanup: Promise<void> | null; leftover: ObsPictureLeftover | null;
  connection: ObsPictureItem | null; parts: ObsPictureItem[]; counts: NonNullable<NativeObsStatus['recoveries']>; restores: OutputRecovery;
  lost: boolean; rejoin: Rejoin | null; outputs: Outputs; started: boolean; released: Promise<void> | null;
  next: NativeObsPrepare['nextFiles'] | null; nextTurn: number; nextTask: Promise<void> | null };
/** `restore`: what comes before the rebuild (the owned scenes prepared again, or nothing). `late`: OBS never went away;
 * the music only started before the picture was ready, and the red text says that instead of a reconnect. */
type Rejoin = { restore: () => Promise<void>; late: boolean };
const NOTHING = (): Promise<void> => Promise.resolve();
const LATE = '这首歌的画面准备好时音乐已经在放了';
/** A recovery of the song's picture for the run log, as the session logs its own (R5): the channel, the item, the count and the limit. */
export type PictureRecoveryLog = { level: 'warning' | 'error'; message: string; result: 'succeeded' | 'failed'; projectId: string; itemId: string;
  details: { channel: 'obs'; item: string; recoveries: { row: string; key: string; count: number; max: number }[] } };
type Dependencies = {
  audio: () => NativePlayerStatus | null;
  outputs: (request: NativeObsPrepare, positionMs: number, assertCurrent: () => void) => Outputs | Promise<Outputs>;
  changed: (status: NativeObsStatus) => void;
  error: (message: string) => void;
  prepareNextFiles?: (request: NativeObsPrepare, assertCurrent: () => void) => Promise<void>;
  /** Lets go of the next song's picture prepared ahead for this session (NativeObsPreloadPool.cancelNext). */
  cancelNextFiles?: (sessionId: string) => Promise<void>;
  /** Each restore of the picture after OBS came back, and its limit (obs.restore). */
  recovered?: (entry: PictureRecoveryLog) => void;
};
const RESTORE = OUTPUT_RECOVERY_RULES['obs.restore'];
/** A picture failure nobody else reports, in two wordings (2026-11-09): `log` keeps OBS's own words with the request
 * and source names, for the run log; `shown` is what the operator reads. Named, so the two cannot be swapped. */
export type PictureFailure = { log: string; shown: string };

/** Main-process ownership boundary. Admission binds to the exact audio session
 * and generation, never to a song name or a renderer timer. */
export class NativeObsHost {
  private entry: Entry | null = null;
  private requested: NativeObsPrepare | null = null;
  private epoch = 0;
  /** Reported while a song's picture was being prepared: shown on that song once its picture exists. */
  private unshown: string[] = [];
  private displayed: NativeObsStatus | null = null;
  private displayedAt = -Infinity;
  private preparing = 0;
  /** Counts OBS going away: a preparation that saw it was lost to it, not failed. */
  private outages = 0;
  /** Stopped songs whose picture stays on its last frame (R14), until the next song's picture is on, the program
   * closes, or OBS comes back after going away. */
  private readonly holds: Entry[] = [];
  constructor(private readonly dependencies: Dependencies) {}
  get status(): NativeObsStatus | null { return this.entry?.state ?? null; }

  /** The program's own stop of its picture hears a failed cleanup, once (2026-11-09); every other stop resolves. */
  async stopOwned(input: NativeObsStop): Promise<void> {
    const request = nativeObsStopSchema.parse(input);
    if (!this.requested || this.requested.sessionId !== request.sessionId || this.requested.generation !== request.generation) {
      throw new Error('这是上一次准备的停止请求，已忽略，当前节目不受影响');
    }
    const entry = this.entry;
    await this.stop();
    const leftover = this.claim(entry);
    if (leftover) throw leftover;
  }

  /** OBS went away: the picture waits for it (design 01 §3.2 row 10, R7). Nothing is sent or repaired meanwhile; a song
   * still being prepared is not cancelled: once its preparation ends it plays without its picture, which is prepared
   * again when OBS is back. Shown on the song once per outage, which is waiting, not a failure of the picture. */
  disconnect(reason: string): void {
    this.outages++;
    const entry = this.entry;
    if (!entry || ['stopped', 'failed'].includes(entry.state.state) || entry.connection) return;
    const message = `OBS 断开了：${reason}。音乐和时间码照常，画面先停在这里，OBS 重新连上后按当前位置接上`;
    entry.connection = { id: 'obs.connection', scope: 'waiting', state: 'waiting', detail: message }; this.listItems(entry);
    this.fault(message);
  }

  /** OBS reports a new scene on program (`CurrentProgramSceneChanged`): the playing or paused song's picture decides
   * whether someone switched it by hand (R8, 2026-11-10 decision 5). Not while OBS is away or the song is prepared again. */
  programSceneChanged(sceneName: string): void {
    const entry = this.entry;
    if (!entry || entry.connection || entry.lost || entry.state.state !== 'running' && entry.state.state !== 'paused') return;
    entry.session.programSceneChanged(sceneName);
  }

  /** Recovery rule B once OBS is back (R7, design 01 §4.7): OBS may have forgotten the owned scenes, so they are
   * prepared again and the picture is rebuilt at the current position, while the music plays or is paused (paused, the
   * clips are located there and kept paused). A song whose preparation OBS going away cut short is prepared again
   * there and joins. Each counts against obs.restore for the song; past it the picture is left as it is, in red.
   * Reported in red either way and logged once; scenes that could not be prepared again do not stop the cameras
   * coming back. A rebuilt part that did not come back stays named in that text (2026-11-09). */
  async reconnected(): Promise<void> {
    // Nothing plays a stopped song's last frame: it is not restored, only taken off (R14).
    void this.releaseAfterOutage();
    const entry = this.entry;
    if (!entry) return;
    const away = entry.connection !== null;
    if (away) { entry.connection = null; this.listItems(entry); }
    // A preparation still running hears OBS back where it ends (`prepareSession`); a prepared song OBS never left needs nothing.
    if (['stopped', 'failed', 'preparing'].includes(entry.state.state) || entry.state.state === 'ready' && !away && !entry.lost) return;
    if (!this.restoreAllowed(entry)) return;
    // A stop or newer song meanwhile cancels the restore; that is not a material that failed to prepare.
    const current = (): void => { if (this.entry !== entry || ['stopped', 'failed'].includes(entry.state.state)) throw new ObsPreparationCancelled('画面状态已变，没有恢复'); };
    const restore = (): Promise<void> => entry.restoreScenes?.(current) ?? Promise.resolve();
    if (entry.lost) { await this.prepareAgain(entry); return; }
    // Prepared and not started: rebuilt as it starts, the owned scenes first.
    if (entry.state.state === 'ready') { entry.rejoin = { restore, late: false }; return; }
    await this.rebuild(entry, restore);
  }

  /** The picture at the current position from nothing, after `restore`; reported in red once. `late`: OBS never went
   * away, the picture only joins music that started before it was ready, and the text says so. */
  private async rebuild(entry: Entry, restore: () => Promise<void>, late = false): Promise<void> {
    const cause = late ? LATE : 'OBS 已重新连接';
    try {
      const rebuilt = await entry.session.recover(restore);
      if (this.entry === entry) this.fault(rebuilt === null ? `${cause}；节目暂停了，继续播放时按当前位置恢复画面` : obsRecoveryText(rebuilt, true, cause));
    } catch (error) {
      if (this.entry === entry) this.fault(`${cause}，但画面恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One more restore of this song's picture (obs.restore), counted, logged and, at the limit, shown in red. */
  private restoreAllowed(entry: Entry): boolean {
    const result = entry.restores.record('obs.restore', 'song', entry.now()), max = RESTORE.limit.max, limit = result.outcome === 'limit';
    const message = limit ? RESTORE.limitText : `OBS 重新连上了，按当前位置恢复这首歌的画面（第 ${result.count} 次，最多 ${max} 次）`;
    this.dependencies.recovered?.({ level: limit ? 'error' : 'warning', message, result: limit ? 'failed' : 'succeeded', projectId: entry.request.snapshot.projectId,
      itemId: entry.request.snapshot.item.id, details: { channel: 'obs', item: 'obs.restore', recoveries: [{ row: 'obs.restore', key: 'song', count: Math.min(result.count, max), max }] } });
    if (limit) {
      entry.parts = [...entry.parts.filter(part => part.id !== 'obs.restore'), { id: 'obs.restore', scope: 'item', state: 'limit', detail: message }];
      this.listItems(entry); this.fault(message);
    } else this.listItems(entry);
    return !limit;
  }

  /** The song whose preparation OBS going away cut short, prepared again at the position the music is at now; it joins
   * at the first clock of the music. Its earlier session is cleaned up first, like a song before the next. */
  private async prepareAgain(entry: Entry): Promise<void> {
    const outages = this.outages, epoch = this.epoch;
    const current = (): void => { if (this.entry !== entry || epoch !== this.epoch || ['stopped', 'failed'].includes(entry.state.state)) throw new ObsPreparationCancelled('画面准备已取消'); };
    const earlier = entry.session;
    await earlier.stop().then(() => earlier.release()).catch((error: unknown) => this.dependencies.error(`画面没有清理干净：${pictureErrorDetail(error)}`));
    try {
      current();
      const audio = this.playingSong(entry.request);
      const outputs = await this.dependencies.outputs(entry.request, audio.positionMs, current);
      current();
      const session = this.createSession(entry.request, entry.project, outputs);
      Object.assign(entry, { session, outputs, lost: false, now: outputs.now, restoreScenes: outputs.restoreScenes, parts: entry.parts.filter(part => part.id === 'obs.restore'), counts: [] });
      await session.prepare(audio.positionMs);
      current();
      if (session.error) throw session.error;
      entry.rejoin = { restore: NOTHING, late: false };
      this.patch({ nextCueId: session.nextCueId, notice: outputs.outputNotice?.() ?? null });
      this.fault('OBS 已重新连接，这首歌的画面准备好了，按当前位置接上');
    } catch (error) {
      if (error instanceof ObsPreparationCancelled || this.entry !== entry || epoch !== this.epoch) return;
      // OBS went away again: prepared again once it is back, within the same limit.
      if (this.outages !== outages || entry.connection) { this.waitForObs(entry); return; }
      this.fail(`OBS 已重新连接，但这首歌的画面没有重新准备好：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** The preparation was lost to OBS going away: the song plays without its picture until OBS is back. */
  private waitForObs(entry: Entry): void {
    entry.lost = true; entry.session.abort('OBS 断开，画面等 OBS 重新连上后再准备');
    this.fault('OBS 断开了，这首歌的画面还没准备好。音乐和时间码照常，OBS 重新连上后按当前位置准备好画面接上');
  }

  /** Called after audio request validation, before it waits behind in-flight
   * native work. Queue cancellation cannot wait for the eventual acknowledgement. */
  interrupt(request: NativePlayerControl): void {
    const entry = this.entry;
    if (!entry || request.sessionId !== entry.request.sessionId || request.generation < entry.state.generation
      || ['failed', 'stopped'].includes(entry.state.state)) return;
    if (request.kind === 'stop' || request.kind === 'seek') {
      void this.stop().catch(error => this.dependencies.error(String(error))); return;
    }
    if (request.kind === 'pause') {
      entry.awaitingPause = true;
      void entry.session.pause().catch(error => { if (this.entry === entry) this.fail(String(error)); });
    } else if (request.kind === 'play') entry.awaitingPause = false;
  }

  async prepare(input: NativeObsPrepare): Promise<NativeObsStatus> {
    const request = nativeObsPrepareSchema.parse(input);
    // The next song plays the newest version: never one older than this song's (0.5.9 S8a).
    if (request.nextFiles && (request.nextFiles.snapshot.projectId !== request.snapshot.projectId || request.nextFiles.snapshot.revision < request.snapshot.revision)) {
      throw new Error('下一个节目的文件准备和当前工程版本对不上');
    }
    this.assertAdmission(request);
    this.requested = request;
    this.preparing++;
    try { return await this.prepareSession(request); }
    // A song that never got its picture leaves nothing to show them on; they are in the log.
    finally { if (--this.preparing === 0) this.unshown = []; }
  }

  /** A failure nobody else reports (a picture prepared in advance and cleaned up in the background): `log`, with
   * OBS's own words, is logged once; `shown` is shown in red on the song playing or about to. */
  report({ log, shown }: PictureFailure): void {
    this.dependencies.error(log);
    const entry = this.entry;
    if (this.preparing > 0 && entry?.request !== this.requested) this.unshown.push(shown);
    else if (entry && !['stopped', 'failed'].includes(entry.state.state)) this.patch({ fault: shown });
  }

  /** A program picture is being prepared or is on air; a preselection must not stop it. */
  get busy(): boolean { return this.preparing > 0 || Boolean(this.entry && !['stopped', 'failed'].includes(this.entry.state.state)); }

  private async prepareSession(request: NativeObsPrepare): Promise<NativeObsStatus> {
    const epoch = ++this.epoch, outages = this.outages;
    const previous = this.entry;
    // A failed cleanup was logged where it ran. It must not keep this song, or any
    // after it, from its picture (2026-11-09). The previous song's own status is no longer shown.
    if (previous) await this.cleanUp(previous);
    if (epoch !== this.epoch) throw new Error('画面准备已被新的操作取消');
    const audio = this.assertAdmission(request), project = projectFromObsSnapshot(request.snapshot);
    const outputs = await this.dependencies.outputs(request, audio.positionMs, () => { if (epoch !== this.epoch) throw new Error('画面资源交接已取消'); });
    if (epoch !== this.epoch) {
      await outputs.releaseOutputs().catch((error: unknown) => this.report({ log: `取消的画面准备没有清理干净，不影响播放。原因：${pictureErrorDetail(error)}`,
        shown: `取消的画面准备没有清理干净，不影响播放。原因：${pictureCleanupReason(error)}` }));
      throw new Error('画面资源交接已取消');
    }
    const faults = this.unshown.splice(0);
    // Shown in red on this song, whose picture goes on, unless the program's own stop of that picture heard it already.
    const leftover = this.claim(previous);
    if (leftover) faults.unshift(leftover.next(request.snapshot.item.id));
    const state: NativeObsStatus = { version: 1, sessionId: request.sessionId, generation: request.generation,
      itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'preparing', reason: null,
      nextCueId: null, currentCueId: null, pendingCount: 0, positionMs: audio.positionMs, items: [], recoveries: [], ...(faults.length ? { fault: faults.join('；') } : {}) };
    const session = this.createSession(request, project, outputs);
    const entry: Entry = { request, project, session, state, awaitingPause: false, ended: false, filesStarted: false, now: outputs.now, restoreScenes: outputs.restoreScenes,
      cleanup: null, leftover: null, connection: null, parts: [], counts: [], restores: new OutputRecovery(), lost: false, rejoin: null, outputs, started: false, released: null,
      next: request.nextFiles ?? null, nextTurn: 0, nextTask: null };
    this.entry = entry; this.publish();
    try {
      await session.prepare(audio.positionMs);
      if (epoch !== this.epoch || this.entry !== entry) throw new Error('画面准备已取消');
      // The music may have started meanwhile (design 01 §3.2 row 13): the picture joins at the current position.
      const now = this.playingSong(request);
      if (now.status === 'playing' || now.generation !== request.generation) entry.rejoin ??= { restore: NOTHING, late: true };
      if (session.error) throw session.error;
      this.patch({ state: 'ready', nextCueId: session.nextCueId, notice: outputs.outputNotice?.() ?? null });
      // Prepared at a position, its frame is on now (a seek while paused): the last frame before it goes (R14).
      if (session.showsPicture()) void this.releaseHolds(entry);
      return entry.state;
    } catch (error) {
      // OBS went away while this was prepared (row 10): the song plays without its picture, prepared again once OBS is back.
      if (this.entry === entry && epoch === this.epoch && (this.outages !== outages || entry.connection) && !(error instanceof ObsPreparationCancelled)) {
        this.patch({ state: 'ready', notice: outputs.outputNotice?.() ?? null }); this.waitForObs(entry);
        // Already back: prepared again now.
        if (!entry.connection) void this.reconnected();
        return entry.state;
      }
      if (this.entry === entry && epoch === this.epoch) this.fail(error instanceof Error ? error.message : String(error));
      // A picture that never played keeps nothing on its last frame.
      await this.release(entry);
      throw error;
    }
  }

  /** The picture session of one preparation of `request`. Only the session the song holds now reaches the song's status:
   * one cut short by OBS going away, and still settling, does not. */
  private createSession(request: NativeObsPrepare, project: LinkProject, outputs: Outputs): ObsProgramSession {
    let session: ObsProgramSession | null = null;
    const outages = this.outages;
    const owner = (): Entry | null => this.entry?.request === request && session !== null && this.entry.session === session ? this.entry : null;
    session = new ObsProgramSession(project, request.projectPath, request.snapshot.item.id, {
      ...outputs,
      // A stop or a newer song cancels the preparation; that is not a material that failed to prepare.
      prepareOutputs: current => outputs.prepareOutputs(() => {
        try { current(); } catch (error) { throw new ObsPreparationCancelled(error instanceof Error ? error.message : String(error)); }
      }),
      state: update => {
        const entry = owner();
        // A failed cleanup is reported once, by cleanUp; it does not fail the song again. A preparation OBS going
        // away cut short is not failed either (row 10): `prepareSession` hears it as it ends. A lost timecode still
        // fails it: on the internal clock nothing brings it back (see the session's `requireUpdate`).
        if (!entry || entry.cleanup || entry.lost || update.state !== 'error' && update.state !== 'timecodeLost') return;
        if (entry.state.state === 'preparing' && (entry.connection || this.outages !== outages)) return;
        this.fail(update.reason ?? '画面准备已失效');
      },
      // Failed actions are already in the action log; show them without ending the channel.
      cueReport: report => {
        if (!owner()) return;
        const failed = report.results.find(result => result.status === 'failed');
        if (failed) this.patch({ fault: `画面动作失败：${failed.action.label} · ${failed.error ?? '未知错误'}` });
        if (report.results.some(result => result.status === 'succeeded')) this.patch({ currentCueId: report.cueId });
      },
      mediaReport: report => {
        if (!owner()) return;
        if (report.status === 'failed') this.patch({ fault: `素材播放失败：${report.event.assetName} · ${report.error ?? '未知错误'}` });
      },
      fault: message => { if (owner()) this.fault(message); },
      // While OBS is away nothing is repaired (R5): once it is back the picture is restored as a whole.
      connected: () => { const entry = owner(); return entry !== null && !entry.connection && (outputs.connected?.() ?? true); },
      // A part that is right again takes its red text with it, if that is still the one shown.
      clearFault: message => { if (owner()?.state.fault === message) this.patch({ fault: null }); },
      // Each part on its own (design 01 §4.5): one failing never fails the song's picture.
      pictureItems: (items, recoveries) => {
        const entry = owner();
        if (!entry) return;
        entry.parts = [...items, ...entry.parts.filter(part => part.id === 'obs.restore')]; entry.counts = recoveries; this.listItems(entry);
      },
      // The picture read back (R8): shown as the session says it, never taken from what was sent.
      pictureFollow: (follow, takeover) => {
        const entry = owner();
        if (entry && !['stopped', 'failed'].includes(entry.state.state)) this.patch({ follow: { state: follow.state, detail: follow.detail }, takeover });
      }
    });
    return session;
  }

  /** Only NativePlayerService's locally validated observations may call this. */
  observe(clock: ProgramClock): void {
    const entry = this.entry;
    if (!entry) return;
    if (entry.state.state === 'failed' || entry.state.state === 'stopped') {
      // Music plays without a picture of its own (given up before it was ready, or failed): the last frame of a song
      // stopped before it goes (R14). A late clock of the stopped song itself leaves that song's own frame alone.
      if (clock.state === 'running') void this.releaseHolds(clock.sessionId === entry.request.sessionId && clock.itemId === entry.request.snapshot.item.id ? entry : null);
      return;
    }
    if (clock.sessionId !== entry.request.sessionId || clock.itemId !== entry.request.snapshot.item.id) {
      // A stale message from an old player must never stop or advance a new one.
      const current = this.dependencies.audio();
      if (current?.sessionId === entry.request.sessionId && current.itemId === entry.request.snapshot.item.id) return;
      void this.stop().catch(error => this.dependencies.error(String(error))); return;
    }
    if (clock.generation < entry.state.generation) return;
    if (clock.state === 'stopped') {
      void this.stop().catch(error => this.dependencies.error(String(error))); return;
    }
    if (entry.awaitingPause) {
      if (clock.state !== 'held') return;
      entry.awaitingPause = false;
    }
    if (entry.state.state === 'preparing') {
      // The music started before the picture was ready (design 01 §3.2 row 13): it joins at the current position once
      // it is prepared. A seek or stop meanwhile stops it (`interrupt`), and the program prepares it again there.
      if (clock.state === 'running') entry.rejoin ??= { restore: NOTHING, late: true };
      return;
    }
    if (entry.lost) {
      // No picture until OBS is back; the song goes on and the status follows it.
      if (clock.state === 'running' || clock.state === 'ended') this.patch({ state: 'running', generation: clock.generation, positionMs: clock.positionMs, pendingCount: 0 });
      else if (clock.state === 'held') this.patch({ state: 'paused', generation: clock.generation, positionMs: clock.positionMs });
      return;
    }
    if (clock.state === 'running' || clock.state === 'ended') {
      // Status-only changes (volume/MIDI/transport admission) are not device
      // observations. A final position is delivered once, not replayed forever.
      if (clock.observedAtMs === null || entry.ended) return;
      // Windows libuv hrtime and IAudioClock's QPC use the same machine counter.
      // Preserve its age through pipe batching instead of restarting the deadline
      // at receive time. No wall clock or renderer clock participates here.
      const ageMs = Number(process.hrtime.bigint()) / 1e6 - clock.observedAtMs;
      // Prepared where the music no longer was: it starts where the music is now, and the picture is rebuilt there.
      const rejoin = clock.state === 'running' ? entry.rejoin : null;
      if (rejoin) { entry.rejoin = null; entry.session.joinNextClock(); }
      const first = !entry.started; entry.started = true;
      entry.session.clock(clock.positionMs, entry.now() - ageMs);
      entry.ended = clock.state === 'ended';
      if (entry.session.error) { this.fail(entry.session.error.message); return; }
      this.patch({ state: 'running', generation: clock.generation, positionMs: clock.positionMs, pendingCount: entry.session.pendingCount, nextCueId: entry.session.nextCueId });
      const rebuilt = rejoin ? this.rebuild(entry, rejoin.restore, rejoin.late) : null;
      // The last frame of the song before goes once this song's picture is on: nothing black in between (R14).
      if (first && this.holds.some(hold => hold !== entry)) void (rebuilt ?? entry.session.settled()).then(() => this.releaseHolds(entry));
      if (!entry.filesStarted && clock.state === 'running') this.startNextFiles(entry);
    } else if (clock.state === 'held' && entry.state.state !== 'paused') {
      this.patch({ state: 'paused', generation: clock.generation, positionMs: clock.positionMs });
      void entry.session.pause().catch(error => { if (this.entry === entry) this.fail(String(error)); });
    }
  }

  /** The next song's files and picture as the newest version has them, while this song's picture runs (0.5.9 S8b):
   * what was prepared ahead is let go and these are prepared instead, the way the first clock of the music prepares
   * them. One preparation at a time: the new one begins once the old one has ended. The song's own picture session is
   * not touched. Resolves once the new one has begun (or, before the music first plays, once it is kept for that clock);
   * its failure is logged, as for the first. A picture that has stopped or failed prepares nothing ahead. */
  async prepareNext(input: NativeObsNext): Promise<void> {
    const request = nativeObsNextSchema.parse(input), entry = this.entry;
    if (!entry || entry.request.sessionId !== request.sessionId || entry.request.generation !== request.generation) throw new Error('下一首的画面准备请求已过期');
    if (['stopped', 'failed'].includes(entry.state.state)) return;
    const next = request.nextFiles;
    if (next && (next.snapshot.projectId !== entry.request.snapshot.projectId || next.snapshot.revision < entry.request.snapshot.revision)) {
      throw new Error('下一个节目的文件准备和当前工程版本对不上');
    }
    entry.next = next; const turn = ++entry.nextTurn;
    const previous = entry.nextTask;
    if (!previous) return;
    // The old one's checks fail from here on (`nextTurn`); what it prepared in OBS is let go.
    await this.dependencies.cancelNextFiles?.(request.sessionId).catch((error: unknown) => this.dependencies.error(`清理下一个节目的准备失败：${pictureErrorDetail(error)}`));
    await previous;
    if (this.entry !== entry || entry.nextTurn !== turn || ['stopped', 'failed'].includes(entry.state.state)) return;
    entry.nextTask = null; entry.filesStarted = false;
    // Playing: begun now. Paused or not started: at the next clock of the music.
    if (this.dependencies.audio()?.status === 'playing') this.startNextFiles(entry);
  }

  /** The next song's files and picture, prepared ahead while this song plays, as `entry.next` has them now. */
  private startNextFiles(entry: Entry): void {
    const nextFiles = entry.next, prepare = this.dependencies.prepareNextFiles;
    if (!nextFiles || !prepare) return;
    entry.filesStarted = true;
    const turn = entry.nextTurn;
    // This song stopping or ending, or a newer ask (prepareNext), cancels it, which is not a failure. Any other failure
    // is logged once, also one that ends after this song stopped and before the next song took it over (2026-11-09).
    entry.nextTask = prepare({ ...entry.request, nextFiles }, () => {
      if (this.entry !== entry || entry.nextTurn !== turn || ['failed', 'stopped'].includes(entry.state.state)) throw new ObsPreparationCancelled('下一个节目的文件准备已取消');
    }).catch((error: unknown) => {
      if (!(error instanceof ObsPreparationCancelled)) this.dependencies.error(`准备下一个节目的文件失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Resolves once the picture is cleaned up, even if that failed: the failure is logged once where it ran and
   * reaches the program once (stopOwned, or the next song, also when a closing program handed it back), never on
   * each later stop or selection. */
  async stop(): Promise<void> {
    ++this.epoch;
    const entry = this.entry;
    if (!entry) return;
    // A stopped song is not read back (R14): it neither follows nor is taken over.
    if (entry.state.state !== 'stopped') this.patch({ state: 'stopped', pendingCount: 0, ...entry.state.follow || entry.state.takeover ? { follow: null, takeover: null } : {} });
    await this.cleanUp(entry);
  }

  /** Runs once per song; a stop or a new song arriving meanwhile waits for the same cleanup. Never retried. */
  private cleanUp(entry: Entry): Promise<void> {
    if (!entry.released && !this.holds.includes(entry)) this.holds.push(entry);
    entry.cleanup ??= entry.session.stop().catch((error: unknown) => {
      this.dependencies.error(`画面没有清理干净：${pictureErrorDetail(error)}`);
      const leftover: ObsPictureLeftover = new ObsPictureLeftover(entry.request.snapshot.item.id, error, () => this.giveBack(entry, leftover));
      entry.leftover = leftover;
    });
    return entry.cleanup;
  }
  /** The program closes (`sessionId`), or the engine (none): its song stops and everything its stopped songs left on
   * their last frame is taken off, as before R14. */
  async close(sessionId?: string): Promise<void> {
    const mine = (entry: Entry): boolean => sessionId === undefined || entry.request.sessionId === sessionId;
    if (this.entry && mine(this.entry)) await this.stop();
    await Promise.all(this.holds.filter(mine).map(entry => this.release(entry)));
  }
  /** The decoders stopped songs hold their last frame on, with the clip each holds (`HeldPictures`). */
  heldDecoders(): ReadonlyMap<string, string> {
    // Also while one is being taken off: a later song asking for it waits for that (`takeOver`).
    return new Map(this.holds.flatMap(entry => [...entry.outputs.heldDecoders?.() ?? []]));
  }
  /** A later song takes `sourceName` over: a stopped song taking its last frame off finishes that first; otherwise the
   * one holding it hands it over (it gives way unless `reuse`). */
  async takeOver(sourceName: string, reuse: boolean): Promise<void> {
    for (const entry of [...this.holds]) {
      if (!entry.outputs.heldDecoders?.().has(sourceName)) continue;
      if (entry.released) await entry.released;
      else await entry.outputs.handOver?.(sourceName, reuse);
    }
  }
  /** Takes off what the stopped song left on its last frame; once, never retried. A failure is logged and shown on the
   * song playing or the next one; `afterOutage`, only logged: OBS may have lost those sources with the connection, and
   * nothing of them is on air for any song (R14). */
  private release(entry: Entry, afterOutage = false): Promise<void> {
    entry.released ??= (async () => {
      try {
        await this.cleanUp(entry);
        // A camera the song now playing shows on the owned output scene is that song's: it stays shown.
        await entry.session.release(() => this.entry && this.entry !== entry ? this.entry.session.ownedSceneSources() : new Set<string>());
      } catch (error) {
        if (afterOutage) { this.dependencies.error(`OBS 重新连上后，停下的歌留在 OBS 里的最后一帧没有清理干净：${pictureErrorDetail(error)}`); return; }
        this.dependencies.error(`画面没有清理干净：${pictureErrorDetail(error)}`);
        const leftover: ObsPictureLeftover = new ObsPictureLeftover(entry.request.snapshot.item.id, error, () => this.giveBack(entry, leftover));
        this.giveBack(entry, leftover);
      } finally {
        const index = this.holds.indexOf(entry);
        if (index >= 0) this.holds.splice(index, 1);
      }
    })();
    return entry.released;
  }
  /** All but `keep`; while OBS is away they wait for it (`releaseAfterOutage`), which is not a failed cleanup. */
  private releaseHolds(keep: Entry | null): Promise<void> {
    return Promise.all(this.holds.filter(entry => entry !== keep && entry.outputs.connected?.() !== false).map(entry => this.release(entry))).then(() => undefined);
  }
  /** OBS came back while songs were stopped on their last frame: that frame is not restored (nothing plays it), only
   * taken off, so that no decoder counts as on air after the outage. */
  private releaseAfterOutage(): Promise<void> {
    return Promise.all(this.holds.map(entry => this.release(entry, true))).then(() => undefined);
  }
  /** A program that closed before it could show a failed cleanup hands it back (2026-11-09). A song that already took
   * the picture over, for example the next program's first song, which waited for this cleanup, will not ask for it
   * again: it shows it now, next to its own fault. Otherwise the song that starts next shows it. */
  private giveBack(entry: Entry, leftover: ObsPictureLeftover): void {
    const current = this.entry;
    if (current && current !== entry && !['stopped', 'failed'].includes(current.state.state)) {
      this.patch({ fault: [leftover.next(current.request.snapshot.item.id), current.state.fault].filter(Boolean).join('；') });
      return;
    }
    (current ?? entry).leftover ??= leftover;
  }
  /** That song's failed cleanup, for whoever shows it; afterwards nobody else gets it. */
  private claim(entry: Entry | null): ObsPictureLeftover | null {
    const leftover = entry?.leftover ?? null;
    if (entry) entry.leftover = null;
    return leftover;
  }

  private assertAdmission(request: NativeObsPrepare): NativePlayerStatus {
    const audio = this.dependencies.audio();
    if (!audio || audio.sessionId !== request.sessionId || audio.generation !== request.generation || audio.itemId !== request.snapshot.item.id
      || !['ready', 'paused'].includes(audio.status) || audio.audioError) throw new Error('画面准备的不是当前这首歌，这一首不联动画面，也不会中途加入');
    return audio;
  }
  /** This song's audio, also once it plays: a preparation joining the music (R7). */
  private playingSong(request: NativeObsPrepare): NativePlayerStatus {
    const audio = this.dependencies.audio();
    if (!audio || audio.sessionId !== request.sessionId || audio.generation < request.generation || audio.itemId !== request.snapshot.item.id
      || !['ready', 'paused', 'playing'].includes(audio.status) || audio.audioError) throw new Error('画面准备的不是当前这首歌，这一首不联动画面，也不会中途加入');
    return audio;
  }
  /** The connection, then the session's parts, as the status lists them, with the song's recovery counts. */
  private listItems(entry: Entry): void {
    if (this.entry !== entry || ['stopped', 'failed'].includes(entry.state.state)) return;
    const restores = entry.restores.counts().map(count => ({ row: count.row, key: count.key, count: Math.min(count.count, RESTORE.limit.max), exhausted: count.exhausted, max: RESTORE.limit.max }));
    this.patch({ items: [...entry.connection ? [entry.connection] : [], ...entry.parts].slice(0, 256), recoveries: [...restores, ...entry.counts].slice(0, 256) });
  }
  private patch(patch: Partial<NativeObsStatus>): void {
    if (!this.entry) return;
    this.entry.state = nativeObsStatusSchema.parse({ ...this.entry.state, ...patch }); this.publish();
  }
  private publish(): void {
    if (!this.entry) return;
    const status = this.entry.state, previous = this.displayed, now = this.entry.now();
    const urgent = !previous || status.sessionId !== previous.sessionId || status.itemId !== previous.itemId
      || status.generation !== previous.generation || status.state !== previous.state || status.reason !== previous.reason;
    if (!urgent && now - this.displayedAt < 50) return;
    this.displayed = status; this.displayedAt = now; this.dependencies.changed(status);
  }
  private fault(message: string): void {
    if (!this.entry || ['stopped', 'failed'].includes(this.entry.state.state)) return;
    this.patch({ fault: message }); this.dependencies.error(message);
  }
  private fail(reason: string): void {
    if (!this.entry || this.entry.state.state === 'failed') return;
    this.patch({ state: 'failed', reason }); this.entry.session.abort(reason); this.dependencies.error(reason);
    // A song whose picture failed shows nothing of its own; the last frame of the one before goes now.
    void this.releaseHolds(this.entry);
  }
}
