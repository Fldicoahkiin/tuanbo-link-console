import type { LinkCue, LinkProject } from '@tb/schema';
import { CueActionRunner, type CueExecutionReport, type LinkActionExecutor } from './cue-action-runner';
import { CueRuntime, type RuntimeUpdate } from './cue-runtime';
import { frameNumberToTimecode, millisecondsToFrameNumber, playbackFramesPerSecond, type MtcSample } from './mtc-timecode';
import { ManagedOutputRuntime, type ManagedMediaExecutionReport, type ManagedOutputRuntimeDependencies } from './managed-output-runtime';
import type { ManagedMediaEvent } from './managed-media-timeline';

export type ObsProgramSessionDependencies = ManagedOutputRuntimeDependencies & {
  /** `canSend` is checked before every request; `dispatched` runs when one is sent. */
  guardOutput: <T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void) => Promise<T>;
  prepareOutputs: (assertCurrent: () => void) => Promise<void>;
  outputNotice?: () => string | null;
  /** Returns the clip it made ready; one already past its boundary starts late (rule B). */
  prepareUpcoming?: (frame: number, assertCurrent: () => void) => Promise<ManagedMediaEvent | null>;
  releaseOutputs: () => Promise<void>;
  executor: LinkActionExecutor;
  seekMedia: (event: ManagedMediaEvent) => Promise<void>;
  /** Puts a playing clip back in step with the music; returns the drift corrected, or null. */
  correctMediaDrift?: (event: ManagedMediaEvent) => Promise<number | null>;
  cueReport: (report: CueExecutionReport) => void;
  mediaReport: (report: ManagedMediaExecutionReport) => void;
  state: (update: RuntimeUpdate) => void;
  /** A live output fault: shown in red while the channel keeps running. */
  fault: (message: string) => void;
  now: () => number;
};

type OutputGate = { allowed: () => boolean; dispatched: () => void; lateBeforeSend: () => boolean };
/** The deadline applies until the first request of an output is sent. After
 * that only cancellation stops it, so a scene switch is never left without the
 * PLAY that belongs to it. */
function outputGate(current: () => boolean, onTime: () => boolean): OutputGate {
  let sent = false, late = false;
  return {
    allowed: () => {
      if (!current()) return false;
      if (sent || onTime()) return true;
      late = true; return false;
    },
    dispatched: () => { sent = true; },
    lateBeforeSend: () => late && !sent
  };
}
type TimelineEntry = { frame: number; priority: number; cue: LinkCue } | { frame: number; priority: number; event: ManagedMediaEvent };

/** Owns an immutable program and consumes device-clock observations. No renderer,
 * wall-clock playhead, or UI lifetime participates in scheduling. The host must
 * prepare resources and bind this session to a specific native audio generation. */
export class ObsProgramSession {
  private preloadWork: Promise<void> | null = null;
  /** Clip starts that failed this session; a late-ready decoder may start each once. */
  private readonly failedStarts = new Set<string>();
  /** Drift is checked every 5 s, never within 1 s of a media start, resume or seek. */
  private nextDriftCheck = -Infinity;
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
    // Picture actions have a 100 ms execution boundary; any longer silence between
    // device observations is a gap rebuilt at the current position (rule B).
    this.runtime = new CueRuntime(project, 100);
    this.managed = new ManagedOutputRuntime(project, projectPath, dependencies);
    // Live mode: a failed action is reported in red and later actions still run.
    this.runner = new CueActionRunner([dependencies.executor], { now: dependencies.now,
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
      for (const entry of work.cues) {
        this.requireCurrent(generation);
        const failed = (await this.cue(entry.cue, () => generation === this.generation && !this.closed)).results.find(result => result.status === 'failed');
        if (failed) throw new Error(failed.error ?? 'OBS 动作执行失败');
      }
      const targets = work.media.map(event => this.managed.alignEvent(event, sample.totalFrames));
      // A seek may reach OBS before its acknowledgement is interrupted. Retain
      // the intended owned targets so cancellation can clean them up as well.
      this.managed.adoptSeek(targets, sample.totalFrames); this.settleMedia(sample.totalFrames);
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
      if (!Number.isFinite(age) || age < 0) throw new Error(`设备位置的时间依据无效（采样年龄 ${age}ms），画面通道停止`);
      if (age > 100) { this.fault(`设备位置晚到 ${Math.round(age)}ms，超过 100ms 执行边界；本次位置不执行画面动作，不补发`); return; }
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
        // A rebuild after stalled position updates is always reported.
        if (update.state === 'running' && update.reason) this.fault(update.reason);
      }
      this.advancing = true; this.frame = sample.totalFrames;
      if (update.state !== 'running') return;
      this.preload(sample.totalFrames); this.watchDrift(sample.totalFrames);
      const media = this.managed.collectCrossed(previousFrame, sample.totalFrames);
      const work = update.rebuild ? this.managed.sceneTimeline!.rebuild(previousFrame, sample.totalFrames, update.dueCues, media)
        : this.managed.sceneTimeline!.cross(previousFrame, sample.totalFrames, update.dueCues, media);
      if (!work.cues.length && !work.media.length) return;
      if (work.media.length) this.settleMedia(sample.totalFrames);
      const generation = this.generation;
      const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
      const onTime = (scheduledFrame: number): boolean => this.dependencies.now()
        <= observedAt + 100 - Math.max(0, sample.totalFrames - scheduledFrame) * 1000 / playbackFramesPerSecond(sample.frameRate);
      const entries: TimelineEntry[] = [
        ...work.cues.map(entry => ({ frame: entry.scheduledFrame, priority: 1, cue: entry.cue })),
        ...work.media.map(event => ({ frame: event.frameNumber, priority: event.phase === 'stop' ? 0 : 2, event }))
      ].sort((left, right) => left.frame - right.frame || left.priority - right.priority);
      if (this.queued >= 64) {
        const reason = 'OBS 响应积压超过 64 批画面动作，本批未发送；画面通道继续';
        this.fault(reason); void this.skip(entries, reason).catch(error => this.fault(`画面跳过记录失败：${String(error)}`)); return;
      }
      this.enqueue(async () => {
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index]!;
          // A covered decoder keeps running. The preceding composition already
          // restored its visibility; there is no command left to send here.
          // Do not turn a slow acknowledgement into a stale-command failure.
          if ('event' in entry && entry.event.phase === 'start' && entry.event.deferSceneSwitch
            && this.managed.isActiveMedia(entry.event)) continue;
          if (!current()) return;
          const group = this.group(entries, index); index += group.length - 1;
          const gate = outputGate(current, () => onTime(entry.frame));
          const label = 'cue' in entry ? entry.cue.name : entry.event.assetName;
          if (!gate.allowed()) {
            if (!current()) return;
            const reason = `OBS 动作晚于 100ms 执行边界，未发送：${label}`;
            this.fault(reason); await this.skip(group, reason); continue;
          }
          const results = await Promise.allSettled(group.map(member => this.output(member, gate)));
          for (const result of results) if (result.status === 'rejected') this.fault(`画面动作异常：${label}：${String(result.reason)}`);
          if (gate.lateBeforeSend() && current()) this.fault(`OBS 动作晚于 100ms 执行边界，未发送：${label}`);
        }
      });
    } catch (error) { this.fail(error); }
  }

  /** Members that share one event boundary and are sent together. */
  private group(entries: TimelineEntry[], index: number): TimelineEntry[] {
    const entry = entries[index]!, group = [entry];
    if ('cue' in entry) {
      const action = entry.cue.actions.length === 1 ? entry.cue.actions[0] : undefined;
      if (entry.cue.id !== `timeline-composition:${this.itemId}` || action?.kind !== 'obs.setProgramScene' || !action.sceneLayers) return group;
      // These owned decoders and their prepared composition share one event
      // boundary. Do not spend the entire deadline waiting for a scene
      // acknowledgement before issuing the media starts.
      const sources = new Set<string>();
      while (group.length < 9) {
        const next = entries[index + group.length];
        if (!next || !('event' in next) || next.frame !== entry.frame || next.event.phase !== 'start'
          || !next.event.deferSceneSwitch || !next.event.sceneName || !action.sceneLayers.includes(next.event.sceneName)
          || sources.has(next.event.sourceName) || this.managed.isActiveMedia(next.event)) break;
        group.push(next); sources.add(next.event.sourceName);
      }
      return group;
    }
    // Layers in one composed frame are independent inputs. Start them together
    // instead of spending one render tick per decoder. Never parallelize scene
    // changes, stops, a restore, or two actions on the same input.
    if (entry.event.phase !== 'start' || !entry.event.deferSceneSwitch || this.managed.isActiveMedia(entry.event)) return group;
    const sources = new Set([entry.event.sourceName]);
    while (group.length < 4) {
      const next = entries[index + group.length];
      if (!next || !('event' in next) || next.frame !== entry.frame || next.event.phase !== 'start'
        || !next.event.deferSceneSwitch || sources.has(next.event.sourceName) || this.managed.isActiveMedia(next.event)) break;
      group.push(next); sources.add(next.event.sourceName);
    }
    return group;
  }

  /** Failed results reach the host as red reports; nothing here ends the channel. */
  private async output(entry: TimelineEntry, gate: OutputGate): Promise<void> {
    if ('cue' in entry) { await this.cue(entry.cue, gate.allowed, gate.dispatched); return; }
    const event = entry.event;
    // A camera only covers these decoders; composition restores their
    // visibility. Repositioning them here interrupts a live media clock.
    if (event.phase === 'start' && this.managed.isActiveMedia(event)) {
      if (!event.deferSceneSwitch && event.sceneName) await this.cue({
        id: `restore:${event.id}`, name: '恢复持续播放的素材', enabled: true, notes: '',
        timecode: frameNumberToTimecode(entry.frame, this.project.timebase.frameRate),
        actions: [{ id: `restore:${event.id}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene', sceneName: event.sceneName }]
      }, gate.allowed, gate.dispatched);
      return;
    }
    const report = await this.dependencies.guardOutput(gate.allowed,
      () => this.managed.executeMedia(this.managed.alignEvent(event, this.frame), 'live', gate.allowed), gate.dispatched);
    if (event.phase === 'start' && report.status === 'failed') this.failedStarts.add(event.clipId);
    this.dependencies.mediaReport(report);
  }

  private async skip(entries: TimelineEntry[], reason: string): Promise<void> {
    for (const entry of entries) {
      if ('cue' in entry) this.dependencies.cueReport(await this.runner.skip(this.managed.compileVisualCue(entry.cue), 'live', reason));
      else for (const report of await this.managed.reportSkippedMedia([entry.event], reason)) this.dependencies.mediaReport(report);
    }
  }

  private preload(frame: number): void {
    const prepare = this.dependencies.prepareUpcoming;
    if (!prepare || this.preloadWork || frame - this.preloadFrame < playbackFramesPerSecond(this.project.timebase.frameRate) / 10) return;
    this.preloadFrame = frame;
    const allowed = (): boolean => !this.closed && !this.failure;
    this.preloadWork = this.dependencies.guardOutput(allowed, () => prepare(frame, () => {
      if (!allowed()) throw new Error('后续素材准备已取消');
    })).then(prepared => { if (prepared) this.startLate(prepared); }).catch(error => { if (!this.closed && !this.failure) this.fault(`后续素材预备失败：${error instanceof Error ? error.message : String(error)}；不重试，到点的素材可能无法播放`); })
      .finally(() => { this.preloadWork = null; });
  }

  private settleMedia(frame: number): void {
    this.nextDriftCheck = Math.max(this.nextDriftCheck, frame + playbackFramesPerSecond(this.project.timebase.frameRate));
  }
  /** Recovery rule B for OBS video drifting from the music over a long clip. */
  private watchDrift(frame: number): void {
    const correct = this.dependencies.correctMediaDrift;
    if (!correct || frame < this.nextDriftCheck) return;
    this.nextDriftCheck = frame + 5 * playbackFramesPerSecond(this.project.timebase.frameRate);
    const generation = this.generation;
    this.enqueue(async () => {
      for (const event of this.managed.activeMedia()) {
        const current = (): boolean => generation === this.generation && !this.closed && !this.failure && this.runtime.getState() === 'running';
        if (event.assetKind === 'image' || !current()) continue;
        const drift = await this.dependencies.guardOutput(current, () => correct(this.managed.alignEvent(event, this.frame)));
        if (drift !== null) this.fault(`素材与音乐偏差 ${drift}ms，已按当前位置校正：${event.assetName}`);
      }
    });
  }

  /** Recovery rule B for a decoder that missed its boundary: once it is ready,
   * the clip starts at the current position if it should be on air now. */
  private startLate(prepared: ManagedMediaEvent): void {
    const generation = this.generation;
    this.enqueue(async () => {
      if (this.runtime.getState() !== 'running' || !this.failedStarts.delete(prepared.clipId)) return;
      const event = this.managed.sceneTimeline!.at(this.frame).media.find(entry => entry.clipId === prepared.clipId);
      if (!event) return;
      const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
      const lateMs = Math.round((this.frame - event.frameNumber) * 1000 / playbackFramesPerSecond(this.project.timebase.frameRate));
      this.settleMedia(this.frame);
      const report = await this.dependencies.guardOutput(current, () => this.managed.executeMedia(this.managed.alignEvent(event, this.frame), 'live', current));
      this.dependencies.mediaReport(report);
      if (report.status === 'succeeded') this.fault(`素材预备晚于播放边界，已按当前位置起播：${event.assetName}（晚 ${lateMs}ms）`);
    });
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
      try {
        const failed = (await this.cue(cue, () => true)).results.find(result => result.status === 'failed');
        if (failed) errors.push(failed.error ?? '恢复机位失败');
      } catch (error) { errors.push(String(error)); }
    }
    try { await this.dependencies.releaseOutputs(); } catch (error) { errors.push(String(error)); }
    if (errors.length) { const error = new Error(`后台画面清理未完成：${errors.join('；')}`); this.fail(error); throw error; }
    this.dependencies.state(this.runtime.completeStop());
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.closed || this.failure) return;
    if (this.queued >= 64) { this.fault('OBS 响应积压超过 64 批画面动作，本批未发送；画面通道继续'); return; }
    const generation = this.generation; this.queued++;
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || this.closed || this.failure) return;
      await operation();
    }).catch(error => this.fault(`画面动作异常：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.queued--; });
  }
  private async cue(cue: LinkCue, canExecute: () => boolean, dispatched?: () => void): Promise<CueExecutionReport> {
    const compiled = this.managed.compileVisualCue(cue);
    for (const action of compiled.actions) this.managed.trackVisualActionAttempt(cue.id, action);
    const report = await this.dependencies.guardOutput(canExecute, () => this.runner.run(compiled, 'live', canExecute), dispatched);
    this.managed.applyVisualCueResult(cue, compiled, report.results); this.dependencies.cueReport(report);
    return report;
  }
  private enqueueTransport(action: 'start' | 'pause', observedAt = this.dependencies.now()): void {
    const generation = this.generation; this.settleMedia(Math.max(0, this.frame));
    this.enqueue(async () => {
      const actions = this.managed.transportActions(action);
      if (!actions.length) return;
      const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
      const gate = outputGate(current, () => action !== 'start' || this.dependencies.now() <= observedAt + 100);
      const cue = { id: `transport-${action}`, name: '同步画面播放状态', notes: '', enabled: true,
        timecode: frameNumberToTimecode(Math.max(0, this.frame), this.project.timebase.frameRate), actions };
      if (!gate.allowed()) {
        if (!current()) return;
        const reason = 'OBS 媒体恢复晚于 100ms 执行边界，未发送继续播放；活动素材保持暂停，不迟到启动';
        this.fault(reason); this.dependencies.cueReport(await this.runner.skip(cue, 'live', reason)); return;
      }
      this.dependencies.cueReport(await this.dependencies.guardOutput(gate.allowed, () => this.runner.run(cue, 'live', gate.allowed), gate.dispatched));
      if (gate.lateBeforeSend() && current()) this.fault('OBS 媒体恢复晚于 100ms 执行边界，未发送继续播放；活动素材保持暂停，不迟到启动');
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
  private fault(message: string): void {
    if (this.closed || this.failure) return;
    this.dependencies.fault(message);
  }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error)); ++this.generation;
    this.dependencies.state(this.runtime.failExecution(this.failure.message));
  }
}
