import { ObsProgramSession, projectFromObsSnapshot, type ObsProgramSessionDependencies } from '@tb/core/link';
import { nativeObsPrepareSchema, nativeObsStopSchema, nativeObsStatusSchema, type NativeObsPrepare, type NativeObsStop, type NativeObsStatus, type NativePlayerStatus, type NativePlayerControl } from '@tb/schema';

type Entry = { request: NativeObsPrepare; session: ObsProgramSession; state: NativeObsStatus; awaitingPause: boolean; ended: boolean; filesStarted: boolean; now: () => number };
type Dependencies = {
  audio: () => NativePlayerStatus | null;
  outputs: (request: NativeObsPrepare, positionMs: number, assertCurrent: () => void) => Omit<ObsProgramSessionDependencies, 'state' | 'cueReport' | 'mediaReport' | 'fault'> | Promise<Omit<ObsProgramSessionDependencies, 'state' | 'cueReport' | 'mediaReport' | 'fault'>>;
  changed: (status: NativeObsStatus) => void;
  error: (message: string) => void;
  prepareNextFiles?: (request: NativeObsPrepare, assertCurrent: () => void) => Promise<void>;
};

/** Main-process ownership boundary. Admission binds to the exact audio session
 * and generation, never to a song name or a renderer timer. */
export class NativeObsHost {
  private entry: Entry | null = null;
  private requested: NativeObsPrepare | null = null;
  private epoch = 0;
  private stopped: Promise<void> = Promise.resolve();
  private displayed: NativeObsStatus | null = null;
  private displayedAt = -Infinity;
  constructor(private readonly dependencies: Dependencies) {}
  get status(): NativeObsStatus | null { return this.entry?.state ?? null; }

  stopOwned(input: NativeObsStop): Promise<void> {
    const request = nativeObsStopSchema.parse(input);
    if (!this.requested || this.requested.sessionId !== request.sessionId || this.requested.generation !== request.generation) {
      return Promise.reject(new Error('后台画面停止请求属于旧准备会话，当前节目保持不变'));
    }
    return this.stop();
  }

  /** A song being prepared cannot start without OBS. Once admitted, the live
   * channel stays: requests fail in red until the operator reconnects OBS. */
  disconnect(reason: string): void {
    if (!this.entry || ['stopped', 'failed'].includes(this.entry.state.state)) return;
    if (this.entry.state.state !== 'preparing') {
      // Every connection-state update repeats the loss; record it once.
      const message = `OBS 连接中断：${reason}；画面动作失败直到重新连接 OBS，之后从下一画面事件继续`;
      if (this.entry.state.fault !== message) this.fault(message);
      return;
    }
    ++this.epoch;
    this.entry.session.abort(reason);
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
      throw new Error('下一节目文件预备与当前工程修订不一致');
    }
    this.assertAdmission(request);
    this.requested = request;
    const epoch = ++this.epoch;
    const previous = this.entry;
    if (previous) {
      this.stopped = previous.session.stop();
      await this.stopped;
    }
    if (epoch !== this.epoch) throw new Error('后台画面准备已被新操作取消');
    const audio = this.assertAdmission(request), project = projectFromObsSnapshot(request.snapshot);
    const state: NativeObsStatus = { version: 1, sessionId: request.sessionId, generation: request.generation,
      itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'preparing', reason: null,
      nextCueId: null, currentCueId: null, pendingCount: 0, positionMs: audio.positionMs };
    const outputs = await this.dependencies.outputs(request, audio.positionMs, () => { if (epoch !== this.epoch) throw new Error('后台画面资源接管已取消'); });
    if (epoch !== this.epoch) { await outputs.releaseOutputs(); throw new Error('后台画面资源接管已取消'); }
    const session = new ObsProgramSession(project, request.projectPath, request.snapshot.item.id, {
      ...outputs,
      state: update => {
        if (this.entry?.request !== request) return;
        if (update.state === 'error' || update.state === 'timecodeLost') this.fail(update.reason ?? '后台画面会话失效');
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
    const entry = { request, session, state, awaitingPause: false, ended: false, filesStarted: false, now: outputs.now }; this.entry = entry; this.publish();
    try {
      await session.prepare(audio.positionMs);
      if (epoch !== this.epoch || this.entry !== entry) throw new Error('后台画面准备已取消');
      this.assertAdmission(request);
      if (session.error) throw session.error;
      this.patch({ state: 'ready', nextCueId: session.nextCueId, notice: outputs.outputNotice?.() ?? null }); return entry.state;
    } catch (error) {
      if (this.entry === entry && epoch === this.epoch) this.fail(error instanceof Error ? error.message : String(error));
      try { await session.stop(); }
      catch (cleanup) { this.dependencies.error(`后台画面准备取消后的清理失败：${String(cleanup)}`); }
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
        const reason = '画面准备完成前音频已改变；本轮未参与，不会中途补发';
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
        const current = (): boolean => this.entry === entry && !['failed', 'stopped'].includes(entry.state.state);
        void this.dependencies.prepareNextFiles(entry.request, () => { if (!current()) throw new Error('下一节目文件预备已取消'); })
          .catch(error => { if (current()) this.dependencies.error(`下一节目文件预备失败：${String(error)}`); });
      }
    } else if (audio.status === 'paused' && entry.state.state !== 'paused') {
      this.patch({ state: 'paused', generation: audio.generation, positionMs: audio.positionMs });
      void entry.session.pause().catch(error => { if (this.entry === entry) this.fail(String(error)); });
    }
  }

  async stop(): Promise<void> {
    ++this.epoch;
    const entry = this.entry;
    if (!entry || entry.state.state === 'stopped') return this.stopped;
    this.patch({ state: 'stopped', pendingCount: 0 });
    this.stopped = entry.session.stop();
    try { await this.stopped; }
    catch (error) { if (this.entry === entry) this.fail(error instanceof Error ? error.message : String(error)); throw error; }
  }

  private assertAdmission(request: NativeObsPrepare): NativePlayerStatus {
    const audio = this.dependencies.audio();
    if (!audio || audio.sessionId !== request.sessionId || audio.generation !== request.generation || audio.itemId !== request.snapshot.item.id
      || !['ready', 'paused'].includes(audio.status) || audio.audioError) throw new Error('画面准备与当前音频会话不一致；本轮未参与，不会中途加入');
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
