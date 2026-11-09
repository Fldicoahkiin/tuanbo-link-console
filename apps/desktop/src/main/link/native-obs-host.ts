import { ObsPictureLeftover, ObsProgramSession, pictureCleanupReason, pictureErrorDetail, projectFromObsSnapshot, type ObsProgramSessionDependencies } from '@tb/core/link';
import { nativeObsPrepareSchema, nativeObsStopSchema, nativeObsStatusSchema, type NativeObsPrepare, type NativeObsStop, type NativeObsStatus, type NativePlayerStatus, type NativePlayerControl } from '@tb/schema';
import { ObsPreparationCancelled } from './native-obs-outputs';

type Outputs = Omit<ObsProgramSessionDependencies, 'state' | 'cueReport' | 'mediaReport' | 'fault'> & {
  /** Prepares this song's owned scenes again after OBS reconnects; starts no decoder. */
  restoreScenes?: (assertCurrent: () => void) => Promise<void>;
};
/** `cleanup`: this song's picture cleanup, run once. `leftover`: why it failed, until the program has heard it once
 * (a program that closed before it could show it hands it back, for the next song). */
type Entry = { request: NativeObsPrepare; session: ObsProgramSession; state: NativeObsStatus; awaitingPause: boolean; ended: boolean; filesStarted: boolean;
  now: () => number; restoreScenes: Outputs['restoreScenes']; cleanup: Promise<void> | null; leftover: ObsPictureLeftover | null };
type Dependencies = {
  audio: () => NativePlayerStatus | null;
  outputs: (request: NativeObsPrepare, positionMs: number, assertCurrent: () => void) => Outputs | Promise<Outputs>;
  changed: (status: NativeObsStatus) => void;
  error: (message: string) => void;
  prepareNextFiles?: (request: NativeObsPrepare, assertCurrent: () => void) => Promise<void>;
};
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

  /** A song being prepared cannot start without OBS. Once admitted, the live
   * channel stays: requests fail in red until the operator reconnects OBS. */
  disconnect(reason: string): void {
    if (!this.entry || ['stopped', 'failed'].includes(this.entry.state.state)) return;
    if (this.entry.state.state !== 'preparing') {
      // Every connection-state update repeats the loss; record it once.
      const message = `OBS 连接中断：${reason}。重新连上 OBS 之前画面动作都不会执行，连上后从下一个画面动作继续`;
      if (this.entry.state.fault !== message) this.fault(message);
      return;
    }
    ++this.epoch;
    this.entry.session.abort(reason);
  }

  /** Recovery rule B after the operator reconnects OBS while this song plays: OBS
   * forgot the owned scenes, so they are prepared again and the picture is rebuilt
   * at the current position while audio continues. Reported in red either way;
   * scenes that could not be prepared again do not stop the cameras coming back. */
  async reconnected(): Promise<void> {
    const entry = this.entry;
    if (!entry || entry.state.state !== 'running') return;
    // A stop, pause or newer song meanwhile cancels the restore; that is not a material that failed to prepare.
    const current = (): void => { if (this.entry !== entry || entry.state.state !== 'running') throw new ObsPreparationCancelled('画面状态已变，没有恢复'); };
    try {
      const rebuilt = await entry.session.rebuild(() => entry.restoreScenes?.(current) ?? Promise.resolve());
      this.fault(rebuilt === null ? 'OBS 已重新连接；节目暂停了，继续播放时按当前位置恢复画面'
        : rebuilt.failure === null ? `OBS 已重新连接，画面已按当前位置恢复（${rebuilt.sent} 项）`
        : `OBS 已重新连接，但素材场景没有重新准备好：${rebuilt.failure}。机位已按当前位置恢复（${rebuilt.sent} 项），素材可能播不出来`);
    } catch (error) {
      if (this.entry === entry) this.fault(`OBS 已重新连接，但画面恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
    if (request.nextFiles && (request.nextFiles.snapshot.projectId !== request.snapshot.projectId || request.nextFiles.snapshot.revision !== request.snapshot.revision)) {
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
    const epoch = ++this.epoch;
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
      nextCueId: null, currentCueId: null, pendingCount: 0, positionMs: audio.positionMs, ...(faults.length ? { fault: faults.join('；') } : {}) };
    const session = new ObsProgramSession(project, request.projectPath, request.snapshot.item.id, {
      ...outputs,
      // A stop or a newer song cancels the preparation; that is not a material that failed to prepare.
      prepareOutputs: current => outputs.prepareOutputs(() => {
        try { current(); } catch (error) { throw new ObsPreparationCancelled(error instanceof Error ? error.message : String(error)); }
      }),
      state: update => {
        // A failed cleanup is reported once, by cleanUp; it does not fail the song again.
        if (this.entry?.request !== request || this.entry.cleanup) return;
        if (update.state === 'error' || update.state === 'timecodeLost') this.fail(update.reason ?? '画面准备已失效');
      },
      // Failed actions are already in the action log; show them without ending the channel.
      cueReport: report => {
        if (this.entry?.request !== request) return;
        const failed = report.results.find(result => result.status === 'failed');
        if (failed) this.patch({ fault: `画面动作失败：${failed.action.label} · ${failed.error ?? '未知错误'}` });
        if (report.results.some(result => result.status === 'succeeded')) this.patch({ currentCueId: report.cueId });
      },
      mediaReport: report => {
        if (this.entry?.request !== request) return;
        if (report.status === 'failed') this.patch({ fault: `素材播放失败：${report.event.assetName} · ${report.error ?? '未知错误'}` });
      },
      fault: message => { if (this.entry?.request === request) this.fault(message); }
    });
    const entry: Entry = { request, session, state, awaitingPause: false, ended: false, filesStarted: false, now: outputs.now, restoreScenes: outputs.restoreScenes, cleanup: null, leftover: null };
    this.entry = entry; this.publish();
    try {
      await session.prepare(audio.positionMs);
      if (epoch !== this.epoch || this.entry !== entry) throw new Error('画面准备已取消');
      this.assertAdmission(request);
      if (session.error) throw session.error;
      this.patch({ state: 'ready', nextCueId: session.nextCueId, notice: outputs.outputNotice?.() ?? null }); return entry.state;
    } catch (error) {
      if (this.entry === entry && epoch === this.epoch) this.fail(error instanceof Error ? error.message : String(error));
      await this.cleanUp(entry);
      throw error;
    }
  }

  /** Only NativePlayerService's locally validated observations may call this. */
  observe(audio: NativePlayerStatus, qpc100ns: string | null = null): void {
    const entry = this.entry;
    if (!entry || entry.state.state === 'failed' || entry.state.state === 'stopped') return;
    if (audio.sessionId !== entry.request.sessionId || audio.itemId !== entry.request.snapshot.item.id) {
      // A stale message from an old player must never stop or advance a new one.
      const current = this.dependencies.audio();
      if (current?.sessionId === entry.request.sessionId && current.itemId === entry.request.snapshot.item.id) return;
      void this.stop().catch(error => this.dependencies.error(String(error))); return;
    }
    if (audio.generation < entry.state.generation) return;
    if (audio.status === 'preparing' || audio.status === 'stopped' || audio.status === 'error' || audio.audioError) {
      void this.stop().catch(error => this.dependencies.error(String(error))); return;
    }
    if (entry.awaitingPause) {
      if (audio.status !== 'paused') return;
      entry.awaitingPause = false;
    }
    if (entry.state.state === 'preparing') {
      if (audio.generation !== entry.request.generation || !['ready', 'paused'].includes(audio.status)) {
        const reason = '画面还没准备好音频就变了，这一首不联动画面，也不会中途补上';
        void this.stop().catch(error => this.dependencies.error(String(error)));
        this.patch({ reason }); this.dependencies.error(reason);
      }
      return;
    }
    if (audio.status === 'playing' || audio.status === 'ended') {
      // Status-only changes (volume/MIDI/transport admission) are not device
      // observations. A final position is delivered once, not replayed forever.
      if (qpc100ns === null || qpc100ns === '0' || entry.ended) return;
      // Windows libuv hrtime and IAudioClock's QPC use the same machine counter.
      // Preserve its age through pipe batching instead of restarting the deadline
      // at receive time. No wall clock or renderer clock participates here.
      const ageMs = Number(process.hrtime.bigint() - BigInt(qpc100ns) * 100n) / 1e6;
      entry.session.clock(audio.positionMs, entry.now() - ageMs);
      entry.ended = audio.status === 'ended';
      if (entry.session.error) { this.fail(entry.session.error.message); return; }
      this.patch({ state: 'running', generation: audio.generation, positionMs: audio.positionMs, pendingCount: entry.session.pendingCount, nextCueId: entry.session.nextCueId });
      if (!entry.filesStarted && audio.status === 'playing' && entry.request.nextFiles && this.dependencies.prepareNextFiles) {
        entry.filesStarted = true;
        // This song stopping or ending cancels it, which is not a failure. Any other failure is logged once, also one
        // that ends after this song stopped and before the next song took it over (2026-11-09).
        void this.dependencies.prepareNextFiles(entry.request, () => {
          if (this.entry !== entry || ['failed', 'stopped'].includes(entry.state.state)) throw new ObsPreparationCancelled('下一个节目的文件准备已取消');
        }).catch((error: unknown) => {
          if (!(error instanceof ObsPreparationCancelled)) this.dependencies.error(`准备下一个节目的文件失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } else if (audio.status === 'paused' && entry.state.state !== 'paused') {
      this.patch({ state: 'paused', generation: audio.generation, positionMs: audio.positionMs });
      void entry.session.pause().catch(error => { if (this.entry === entry) this.fail(String(error)); });
    }
  }

  /** Resolves once the picture is cleaned up, even if that failed: the failure is logged once where it ran and
   * reaches the program once (stopOwned, or the next song, also when a closing program handed it back), never on
   * each later stop or selection. */
  async stop(): Promise<void> {
    ++this.epoch;
    const entry = this.entry;
    if (!entry) return;
    if (entry.state.state !== 'stopped') this.patch({ state: 'stopped', pendingCount: 0 });
    await this.cleanUp(entry);
  }

  /** Runs once per song; a stop or a new song arriving meanwhile waits for the same cleanup. Never retried. */
  private cleanUp(entry: Entry): Promise<void> {
    entry.cleanup ??= entry.session.stop().catch((error: unknown) => {
      this.dependencies.error(`画面没有清理干净：${pictureErrorDetail(error)}`);
      const leftover: ObsPictureLeftover = new ObsPictureLeftover(entry.request.snapshot.item.id, error, () => this.giveBack(entry, leftover));
      entry.leftover = leftover;
    });
    return entry.cleanup;
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
  }
}
