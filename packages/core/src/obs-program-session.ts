import type { LinkCue, LinkProject } from '@tb/schema';
import { CueActionRunner, type CueExecutionReport, type LinkActionExecutor } from './cue-action-runner';
import { CueRuntime, type RuntimeUpdate } from './cue-runtime';
import { frameNumberToTimecode, millisecondsToFrameNumber, playbackFramesPerSecond, type MtcSample } from './mtc-timecode';
import { ManagedOutputRuntime, type ManagedMediaExecutionReport, type ManagedOutputRuntimeDependencies } from './managed-output-runtime';
import type { ManagedMediaEvent } from './managed-media-timeline';

export type ObsProgramSessionDependencies = ManagedOutputRuntimeDependencies & {
  guardOutput: <T>(canSend: () => boolean, operation: () => Promise<T>) => Promise<T>;
  prepareOutputs: (assertCurrent: () => void) => Promise<void>;
  prepareUpcoming?: (frame: number, assertCurrent: () => void) => Promise<void>;
  releaseOutputs: () => Promise<void>;
  executor: LinkActionExecutor;
  seekMedia: (event: ManagedMediaEvent) => Promise<void>;
  cueReport: (report: CueExecutionReport) => void;
  mediaReport: (report: ManagedMediaExecutionReport) => void;
  state: (update: RuntimeUpdate) => void;
  now: () => number;
};

/** Owns an immutable program and consumes device-clock observations. No renderer,
 * wall-clock playhead, or UI lifetime participates in scheduling. The host must
 * prepare resources and bind this session to a specific native audio generation. */
export class ObsProgramSession {
  private preloadWork: Promise<void> | null = null;
  private preloadFrame = -Infinity;
  private readonly runtime: CueRuntime;
  private readonly managed: ManagedOutputRuntime;
  private readonly runner: CueActionRunner;
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private queued = 0;
  private frame = -1;
  private prepared = false;
  private preparing = false;
  private advancing = false;
  private failure: Error | null = null;
  private closed = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly project: LinkProject, projectPath: string, private readonly itemId: string,
    private readonly dependencies: ObsProgramSessionDependencies) {
    if (project.playbackSource !== 'internal' || project.obsOutputMode !== 'scenes') throw new Error('后台画面会话需要内部主控场景工程');
    const item = project.rundown.find(entry => entry.id === itemId);
    if (!item) throw new Error('后台画面节目不存在');
    // Other outputs belong to independent channels, never pretend that an OBS
    // executor sent MIDI or a console action.
    if (item.cues.some(cue => cue.actions.some(action => !action.kind.startsWith('obs.')))) throw new Error('后台画面快照含非 OBS 动作，必须先分配到对应输出通道');
    this.runtime = new CueRuntime(project);
    this.managed = new ManagedOutputRuntime(project, projectPath, dependencies);
    this.runner = new CueActionRunner([dependencies.executor], { now: dependencies.now, stopOnFailure: true,
      onStatus: event => dependencies.recordLog({ level: event.status === 'failed' ? 'error' : event.status === 'skipped' ? 'warning' : 'info',
        category: 'action', message: `${event.label} · ${event.status}`, projectId: project.projectId, itemId,
        cueId: event.cueId, actionId: event.actionId, executionId: event.executionId, device: 'obs', result: event.status,
        details: { kind: event.kind, at: event.at, ...(event.error ? { error: event.error } : {}) } }).then(() => undefined)
    });
    this.requireUpdate(this.runtime.selectItem(itemId));
    this.managed.selectItem(itemId);
  }

  get error(): Error | null { return this.failure; }
  get pendingCount(): number { return this.queued; }
  get nextCueId(): string | null { return this.runtime.getNextCueId(this.frame); }
  settled(): Promise<void> { return this.tail; }
  abort(reason: string): void { this.fail(new Error(reason)); }

  async prepare(positionMs: number): Promise<void> {
    if (this.prepared || this.preparing || this.closed) throw new Error('画面会话已准备或关闭');
    this.preparing = true;
    const operation = this.prepareSession(positionMs);
    this.tail = operation.catch(error => { if (!this.closed) this.fail(error); });
    try { await operation; } finally { this.preparing = false; }
  }
  private async prepareSession(positionMs: number): Promise<void> {
    const generation = ++this.generation;
    this.requireUpdate(this.runtime.beginPreflight('live'));
    await this.dependencies.guardOutput(() => generation === this.generation && !this.closed && !this.failure,
      () => this.dependencies.prepareOutputs(() => this.requireCurrent(generation)));
    this.requireCurrent(generation);
    const sample = this.sample(positionMs);
    this.requireUpdate(this.runtime.arm(this.dependencies.now(), positionMs > 0 ? sample : null, 'awaiting-external-start'));
    this.frame = positionMs > 0 ? sample.totalFrames : -1;
    if (positionMs > 0) {
      const work = this.managed.sceneTimeline!.at(sample.totalFrames);
      for (const entry of work.cues) { this.requireCurrent(generation); await this.cue(entry.cue, () => generation === this.generation && !this.closed); }
      const targets = work.media.map(event => this.managed.alignEvent(event, sample.totalFrames));
      // A seek may reach OBS before its acknowledgement is interrupted. Retain
      // the intended owned targets so cancellation can clean them up as well.
      this.managed.adoptSeek(targets, sample.totalFrames);
      for (const event of targets) {
        this.requireCurrent(generation);
        await this.dependencies.guardOutput(() => generation === this.generation && !this.closed, () => this.dependencies.seekMedia(event));
      }
      this.requireCurrent(generation);
    }
    this.requireCurrent(generation);
    this.prepared = true;
  }

  /** Called only for fresh playing/ended observations from the bound device. */
  clock(positionMs: number, observedAt = this.dependencies.now()): void {
    if (!this.prepared || this.closed || this.failure) return;
    try {
      const age = this.dependencies.now() - observedAt;
      if (!Number.isFinite(age) || age < 0 || age > 100) throw new Error('设备位置已超过 100ms 执行边界或时间依据无效，画面通道停止；不会补发过时动作');
      const sample = this.sample(positionMs, observedAt), previousFrame = this.frame;
      let update: RuntimeUpdate;
      if (this.runtime.getState() === 'paused') {
        update = this.runtime.resumeMedia(sample);
        this.requireUpdate(update);
        this.enqueueTransport('start', observedAt);
      } else {
        if (!this.advancing && previousFrame >= 0) this.requireUpdate(this.runtime.anchorMediaClock(sample));
        update = this.runtime.ingest(sample);
        this.requireUpdate(update);
      }
      this.advancing = true; this.frame = sample.totalFrames;
      if (update.state !== 'running') return;
      this.preload(sample.totalFrames);
      const media = this.managed.collectCrossed(previousFrame, sample.totalFrames);
      const work = this.managed.sceneTimeline!.cross(previousFrame, sample.totalFrames, update.dueCues, media);
      if (!work.cues.length && !work.media.length) return;
      const generation = this.generation;
      const canExecute = (scheduledFrame: number): boolean => {
        if (generation !== this.generation || this.closed || this.failure) return false;
        const deadline = observedAt + 100 - Math.max(0, sample.totalFrames - scheduledFrame) * 1000 / playbackFramesPerSecond(sample.frameRate);
        if (this.dependencies.now() > deadline) { this.fail(new Error('OBS 动作已超过 100ms 执行边界，画面通道停止；不会补发过时动作')); return false; }
        return true;
      };
      const entries = [
        ...work.cues.map(entry => ({ frame: entry.scheduledFrame, priority: 1, cue: entry.cue } as const)),
        ...work.media.map(event => ({ frame: event.frameNumber, priority: event.phase === 'stop' ? 0 : 2, event } as const))
      ].sort((left, right) => left.frame - right.frame || left.priority - right.priority);
      this.enqueue(async () => {
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index]!;
          const allowed = (): boolean => canExecute(entry.frame);
          if (!allowed()) return;
          if ('cue' in entry) {
            const action = entry.cue.actions.length === 1 ? entry.cue.actions[0] : undefined;
            const starts: ManagedMediaEvent[] = [], sources = new Set<string>();
            if (entry.cue.id === `timeline-composition:${this.itemId}` && action?.kind === 'obs.setProgramScene' && action.sceneLayers) {
              // These owned decoders and their prepared composition share one
              // event boundary. Do not spend the entire deadline waiting for a
              // scene acknowledgement before issuing the media starts.
              while (starts.length < 8) {
                const next = entries[index + 1];
                if (!next || !('event' in next) || next.frame !== entry.frame || next.event.phase !== 'start'
                  || !next.event.deferSceneSwitch || !next.event.sceneName || !action.sceneLayers.includes(next.event.sceneName)
                  || sources.has(next.event.sourceName) || this.managed.isActiveMedia(next.event)) break;
                starts.push(next.event); sources.add(next.event.sourceName); index++;
              }
            }
            const scene = this.cue(entry.cue, allowed).catch(error => { this.fail(error); throw error; });
            const results = await Promise.allSettled([scene, ...starts.map(event => this.media(event, allowed))]);
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          } else {
            // A camera only covers these decoders; composition restores their
            // visibility. Repositioning them here interrupts a live media clock.
            if (entry.event.phase === 'start' && this.managed.isActiveMedia(entry.event)) {
              if (!entry.event.deferSceneSwitch && entry.event.sceneName) await this.cue({
                id: `restore:${entry.event.id}`, name: '恢复持续播放的素材', enabled: true, notes: '',
                timecode: frameNumberToTimecode(entry.frame, this.project.timebase.frameRate),
                actions: [{ id: `restore:${entry.event.id}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene', sceneName: entry.event.sceneName }]
              }, allowed);
              continue;
            }
            // Layers in one composed frame are independent inputs. Start them
            // together instead of spending one render tick per decoder. Never
            // parallelize scene changes, stops, or two actions on the same input.
            const group = [entry.event], sources = new Set([entry.event.sourceName]);
            if (entry.event.phase === 'start' && entry.event.deferSceneSwitch) {
              while (group.length < 4) {
                const next = entries[index + 1];
                if (!next || !('event' in next) || next.frame !== entry.frame || next.event.phase !== 'start'
                  || !next.event.deferSceneSwitch || sources.has(next.event.sourceName) || this.managed.isActiveMedia(next.event)) break;
                group.push(next.event); sources.add(next.event.sourceName); index++;
              }
            }
            const results = await Promise.allSettled(group.map(event => this.media(event, allowed)));
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          }
        }
      });
    } catch (error) { this.fail(error); }
  }

  private async media(event: ManagedMediaEvent, allowed: () => boolean): Promise<void> {
    try {
      const report = await this.dependencies.guardOutput(allowed,
        () => this.managed.executeMedia(this.managed.alignEvent(event, this.frame), 'live', allowed));
      this.dependencies.mediaReport(report);
      if (report.status === 'failed') throw new Error(report.error ?? 'OBS 素材执行失败');
    } catch (error) { this.fail(error); throw error; }
  }

  private preload(frame: number): void {
    const prepare = this.dependencies.prepareUpcoming;
    if (!prepare || this.preloadWork || frame - this.preloadFrame < playbackFramesPerSecond(this.project.timebase.frameRate) / 10) return;
    this.preloadFrame = frame;
    const allowed = (): boolean => !this.closed && !this.failure;
    this.preloadWork = this.dependencies.guardOutput(allowed, () => prepare(frame, () => {
      if (!allowed()) throw new Error('后续素材准备已取消');
    })).catch(error => { if (!this.closed && !this.failure) this.fail(error); })
      .finally(() => { this.preloadWork = null; });
  }

  async pause(): Promise<void> {
    if (!this.prepared || this.closed || this.failure) return;
    if (this.runtime.getState() === 'paused') return;
    ++this.generation; this.advancing = false;
    this.requireUpdate(this.runtime.pauseAutomatic());
    this.enqueueTransport('pause');
    await this.tail;
    const failure = this.error;
    if (failure) throw failure;
  }

  /** Invalidate first; already sent network work may finish, but no queued action
   * from this generation is allowed to follow it. Cleanup uses only owned state. */
  stop(): Promise<void> {
    this.stopping ??= this.stopSession();
    return this.stopping;
  }
  private async stopSession(): Promise<void> {
    this.closed = true; ++this.generation; this.dependencies.state(this.runtime.stop());
    await this.tail;
    await this.preloadWork;
    const errors: string[] = [], cleanup = this.managed.takeCleanup();
    for (const event of cleanup.mediaEvents) {
      try {
        const report = await this.managed.executeMedia(event, 'live'); this.dependencies.mediaReport(report);
        if (report.status === 'failed') errors.push(report.error ?? '停止素材失败');
      } catch (error) { errors.push(String(error)); }
    }
    for (const cue of cleanup.cameraCues) {
      try { await this.cue(cue, () => true); } catch (error) { errors.push(String(error)); }
    }
    try { await this.dependencies.releaseOutputs(); } catch (error) { errors.push(String(error)); }
    if (errors.length) { const error = new Error(`后台画面清理未完成：${errors.join('；')}`); this.fail(error); throw error; }
    this.dependencies.state(this.runtime.completeStop());
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.closed || this.failure) return;
    if (this.queued >= 64) { this.fail(new Error('后台画面队列已满，已停止该通道')); return; }
    const generation = this.generation; this.queued++;
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || this.closed || this.failure) return;
      await operation();
    }).catch(error => this.fail(error)).finally(() => { this.queued--; });
  }
  private async cue(cue: LinkCue, canExecute: () => boolean): Promise<void> {
    const compiled = this.managed.compileVisualCue(cue);
    for (const action of compiled.actions) this.managed.trackVisualActionAttempt(cue.id, action);
    // The first OBS failure ends this channel. The runner still reports the
    // remaining actions as skipped; independent audio/MTC channels keep running.
    const report = await this.dependencies.guardOutput(canExecute, () => this.runner.run(compiled, 'live', canExecute));
    this.managed.applyVisualCueResult(cue, compiled, report.results); this.dependencies.cueReport(report);
    const failure = report.results.find(result => result.status === 'failed');
    if (failure) throw new Error(failure.error ?? 'OBS 动作执行失败');
  }
  private enqueueTransport(action: 'start' | 'pause', observedAt = this.dependencies.now()): void {
    const generation = this.generation;
    this.enqueue(async () => {
      const actions = this.managed.transportActions(action);
      if (!actions.length) return;
      const allowed = (): boolean => {
        if (generation !== this.generation || this.closed || this.failure) return false;
        if (action === 'start' && this.dependencies.now() > observedAt + 100) {
          this.fail(new Error('OBS 媒体恢复已超过 100ms 执行边界，画面通道停止；不会迟到启动')); return false;
        }
        return true;
      };
      const report = await this.dependencies.guardOutput(allowed, () => this.runner.run({ id: `transport-${action}`, name: '同步画面播放状态', notes: '', enabled: true,
        timecode: frameNumberToTimecode(Math.max(0, this.frame), this.project.timebase.frameRate), actions }, 'live',
      allowed));
      this.dependencies.cueReport(report);
      const failed = report.results.find(result => result.status === 'failed');
      if (failed) throw new Error(failed.error ?? '同步画面播放状态失败');
    });
  }
  private sample(positionMs: number, observedAt = this.dependencies.now()): MtcSample {
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= 86400000) throw new Error('实际音频位置无效');
    const frameRate = this.project.timebase.frameRate, totalFrames = millisecondsToFrameNumber(positionMs, frameRate);
    return { frameRate, totalFrames, timecode: frameNumberToTimecode(totalFrames, frameRate), direction: 'forward', receivedAtMs: observedAt };
  }
  private requireCurrent(generation: number): void {
    if (generation !== this.generation || this.closed || this.failure) throw new Error('后台画面准备已取消');
  }
  private requireUpdate(update: RuntimeUpdate): void {
    this.dependencies.state(update);
    if (update.state === 'error' || update.state === 'timecodeLost') throw new Error(update.reason ?? '后台画面时钟失效');
  }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error)); ++this.generation;
    this.dependencies.state(this.runtime.failExecution(this.failure.message));
  }
}
