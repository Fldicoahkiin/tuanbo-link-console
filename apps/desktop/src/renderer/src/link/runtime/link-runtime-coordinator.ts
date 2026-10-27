import {
  CueActionRunner,
  CueRuntime, MtcQuarterFrameDecoder,
  type ManagedMediaEvent, type MtcSample, type PreflightReport, type RuntimeUpdate
} from '@tb/core/link';
import type { LinkAction, LinkCue, LinkProject } from '@tb/schema';
import { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { P1LightingOutput } from './p1-lighting-output';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { collectManagedOutputCleanupAfter, ManagedOutputRuntime } from '@tb/core/link';
import { executeManagedOutputCleanup } from './managed-output-cleanup';
import { MtcStabilityTracker } from './mtc-stability-tracker';
import { ObsIpcExecutor } from './obs-ipc-executor';
import { recordRuntimeAction, recordRuntimeOperator, reportCoordinatorError } from './runtime-action-log';
import { RuntimeMidiSession } from './runtime-midi-session';
import { appendMediaReport } from './runtime-report-store';
import { applyRuntimeState, resetRuntimeExecutionView } from './runtime-state-application';
import { P1AutoFollowController } from './p1-auto-follow-controller';
import { internalSample } from './internal-timeline';
import { seekInternalRuntime } from './internal-runtime-seek';
import { prepareInternalRuntime, prepareRuntimeArm } from './internal-runtime-preparation';
import { prepareNativeCompanionRuntime } from './native-companion-preparation';
import { InternalPreparationScope } from './internal-preparation-scope';
import { EditorScenePreview } from './editor-scene-preview';
import { executeTimelineMedia, executeTimelineWork, executeDueCues, synchronizeTimelineTransport, reportSkippedTimelineMedia, executeSkippedTimelineCue, retryReportedAction, rebuildTimelinePicture } from './timeline-work';

export class LinkRuntimeCoordinator {
  private readonly runtime: CueRuntime;
  private readonly decoder = new MtcQuarterFrameDecoder();
  private readonly midi: LinkMidiAdapter;
  private readonly runner: CueActionRunner;
  private readonly midiSession: RuntimeMidiSession;
  private tickTimer: number | null = null;
  private lastSample: MtcSample | null = null;
  private readonly mtcStability = new MtcStabilityTracker();
  private cueExecutionTail: Promise<void> = Promise.resolve();
  private executionGeneration = 0;
  private readonly managedOutput: ManagedOutputRuntime;
  private autoFollow: P1AutoFollowController | null = null;
  private disposed = false;
  private readonly editorPreview = new EditorScenePreview();
  private internalStopHandler: (() => void) | null = null;
  private internalCaptureActive = false;
  private internalClockActive = false;
  private internalObsOwner: 'renderer' | 'main' = 'renderer';
  private readonly internalPreparation = new InternalPreparationScope();
  private readonly p1Lighting = new P1LightingOutput();

  onInternalStop(handler: (() => void) | null): void { this.internalStopHandler = handler; }
  async stopAndWait(suspendAuto = true, reason?: string): Promise<void> {
    this.stop(suspendAuto, reason); await this.cueExecutionTail;
    if (this.runtime.getState() === 'error') throw new Error(useRuntimeStore.getState().reason ?? '停止清理失败');
  }
  async prepareInternal(itemId: string, preflight: (assertCurrent: () => void) => Promise<PreflightReport>, positionMs = 0, signal?: AbortSignal, notice: (message: string) => void = () => undefined): Promise<void> {
    this.internalClockActive = false;
    this.autoFollow?.suspend();
    if (this.disposed) throw new Error('这次播放已经结束');
    await this.internalPreparation.run(() => this.stopAndWait(false, '准备节目前停止上一首'), assertCurrent => {
      this.internalObsOwner = 'renderer';
      return prepareInternalRuntime(this.project, itemId, positionMs, () => preflight(assertCurrent), {
      assertCurrent, notice, select: () => this.selectItem(itemId, false), capture: () => { this.internalCaptureActive = true; },
      armFromStart: () => this.armFromStart(assertCurrent), runtime: this.runtime, managed: this.managedOutput, runner: this.runner, projectPath: this.projectPath,
      sample: (sample) => { this.lastSample = sample; }, apply: (update) => this.applyRequiredUpdate(update),
      execute: (cues, media) => this.enqueueTimelineWork(cues, media)
      });
    }, signal);
  }

  /** Native audio owns OBS in main. This companion retains only generic MIDI
   * Cue actions and the operator's timeline state; it never prepares/captures OBS. */
  async prepareNativeCompanion(itemId: string, positionMs: number, signal?: AbortSignal): Promise<void> {
    this.internalClockActive = false; this.autoFollow?.suspend();
    if (this.disposed) throw new Error('这次播放已经结束');
    await prepareNativeCompanionRuntime(this.project, itemId, positionMs, {
      scope: this.internalPreparation, stop: () => this.stopAndWait(false, '准备节目前停止上一首'),
      select: () => { this.internalObsOwner = 'main'; this.selectItem(itemId, false); },
      runtime: this.runtime, beginPreflight: () => this.beginPreflight('live'),
      initializeMidi: () => this.initializeMidi(false), midi: this.midi,
      applyPreflight: report => this.applyPreflight(report), sample: sample => { this.lastSample = sample; },
      apply: update => this.applyRequiredUpdate(update)
    }, signal);
  }
  ingestInternal(positionMs: number): Promise<void> {
    const sample = internalSample(this.project, positionMs);
    if (!this.internalClockActive && this.lastSample && ['armed', 'running'].includes(this.runtime.getState())) {
      this.applyRequiredUpdate(this.runtime.anchorMediaClock(sample));
    }
    return this.ingestSample(sample);
  }
  startInternalClock(positionMs: number): void {
    if (this.lastSample && this.runtime.getState() !== 'paused') this.applyRequiredUpdate(this.runtime.anchorMediaClock(internalSample(this.project, positionMs)));
    this.internalClockActive = true;
  }
  async seekInternal(positionMs: number): Promise<void> {
    this.internalClockActive = false;
    const item = this.currentItem();
    if (this.internalObsOwner === 'main' && item) {
      await this.prepareNativeCompanion(item.id, positionMs); await this.pauseInternal('定位后保持暂停'); return;
    }
    if (!item || !useRuntimeStore.getState().preflight?.passed || !['running', 'paused'].includes(this.runtime.getState())) throw new Error('现在不能定位，请重新播放');
    if (this.runtime.getState() === 'running') this.applyRequiredUpdate(this.runtime.pauseAutomatic('定位中暂停'));
    ++this.executionGeneration; await this.cueExecutionTail;
    const sample = internalSample(this.project, positionMs); this.lastSample = sample;
    const operation = seekInternalRuntime(this.project, this.projectPath, item.id, sample, this.runtime, this.managedOutput, this.runner, (update) => this.applyRequiredUpdate(update));
    this.cueExecutionTail = operation.catch((error: unknown) => this.reportRuntimeError(error)); await operation;
  }
  /** Recovery rule B after OBS reconnects while internal audio plays; returns how many outputs were rebuilt. */
  rebuildPicture(): Promise<number> {
    if (this.internalObsOwner === 'main' || !this.lastSample || this.runtime.getState() !== 'running') return Promise.resolve(0);
    const generation = this.executionGeneration, execution = this.cueExecutionTail.then(() => rebuildTimelinePicture(() => this.lastSample?.totalFrames ?? 0, this.runtime, this.managedOutput, (cues, media) => this.executeTimelineWork(cues, media, generation)));
    this.cueExecutionTail = execution.then(() => undefined, (error: unknown) => this.reportRuntimeError(error)); return execution;
  }
  async pauseInternal(reason?: string): Promise<void> { this.internalClockActive = false; this.pause(reason); await this.syncMediaTransport('pause'); }

  cancelEditorPreview(): void { this.executionGeneration += 1; this.editorPreview.reset(); }

  previewEditor(itemId: string, positionMs: number, preciseSeeking: boolean): Promise<void> {
    const generation = this.executionGeneration;
    const queued = this.editorPreview.enqueue(this.cueExecutionTail, this.project, this.projectPath, itemId, positionMs, preciseSeeking,
      () => !this.disposed && generation === this.executionGeneration && this.runtime.getState() === 'idle');
    this.cueExecutionTail = queued.tail;
    return queued.operation;
  }

  async enableP1AutoFollow(preflight: () => Promise<PreflightReport>): Promise<void> {
    if (this.project.playbackSource === 'internal' || !this.project.p1AutoFollow?.enabled || this.disposed) return;
    if (this.autoFollow) { await this.initializeMidi(); this.autoFollow.enable(); return; }
    this.autoFollow = new P1AutoFollowController(this.project, {
      prepare: async (itemId, isCurrent) => {
        this.stop(false, 'P1 切歌，停止上一首'); await this.cueExecutionTail;
        if (!isCurrent()) return;
        this.selectItem(itemId, false);
        const report = await preflight();
        if (!isCurrent()) return;
        if (!report.passed) throw new Error(report.checks.filter((check) => check.status === 'blocking').map((check) => check.detail).join('；'));
        await this.armFromStart();
      },
      ingest: (sample) => this.ingestSample(sample, true),
      interrupt: () => { this.executionGeneration += 1; this.p1Lighting.stop(); },
      fail: (error) => this.reportRuntimeError(error)
    });
    await this.initializeMidi();
    useRuntimeStore.getState().setState({ reason: '正在自动监听 P1：在 P1 里点歌，OBS 就会跟着切换' });
  }

  constructor(private readonly project: LinkProject, private readonly projectPath: string | null) {
    this.runtime = new CueRuntime(project);
    this.managedOutput = new ManagedOutputRuntime(project, projectPath, linkDesktopViewModel);
    this.midi = new LinkMidiAdapter(
      (profileId) => {
        const port = useIntegrationStore.getState().profile?.midiPortProfiles.find((candidate) => candidate.id === profileId);
        return port ?? null;
      },
      (error) => this.reportRuntimeError(error)
    );
    this.midiSession = new RuntimeMidiSession(this.midi, project.projectId, message => {
      void this.ingestQuarterFrame((message.messageType << 4) | message.value, message.receivedAt).catch(error => this.reportRuntimeError(error));
    }, error => this.reportRuntimeError(error));
    this.runner = new CueActionRunner([new ObsIpcExecutor(() => this.project), this.midi], {
      onStatus: (event) => recordRuntimeAction(this.project.projectId, this.currentItem(), event)
    });
  }

  async initializeMidi(input = true): Promise<void> {
    await this.midiSession.initialize(input && this.project.playbackSource !== 'internal');
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = window.setInterval(() => {
      if (this.project.playbackSource === 'internal' && (!this.internalClockActive || this.runtime.getState() === 'paused')) return;
      this.applyUpdate(this.runtime.tick(performance.now()));
    }, 100);
  }

  async waitForMtcInputPort(timeoutMs: number): Promise<void> {
    await this.midiSession.waitForInput(timeoutMs);
  }

  selectItem(itemId: string, recordOperator = true): void {
    const update = this.runtime.selectItem(itemId, -1);
    if (update.state === 'error' || update.reason) {
      this.applyUpdate(update);
      return;
    }
    this.decoder.reset(); this.mtcStability.reset();
    this.lastSample = null;
    try { this.managedOutput.selectItem(itemId); } catch (error) { this.reportRuntimeError(error); return; }
    useRuntimeStore.getState().setState({ currentItemId: itemId, reports: [], mediaReports: [], currentCueId: null, timecode: null, detectedFrameRate: null, mtcStable: false, lastMtcAt: null });
    this.applyUpdate(update);
    if (recordOperator) this.recordOperatorAction('选择当前节目', { itemId });
  }

  beginPreflight(mode: PreflightReport['mode']): void { useRuntimeStore.getState().setState({ preflight: null, mode }); this.applyRequiredUpdate(this.runtime.beginPreflight(mode)); }

  async applyPreflight(report: PreflightReport): Promise<void> {
    if (this.runtime.getState() !== 'preflight') throw new Error(`当前状态（${this.runtime.getState()}）不能使用这次开播前检查的结果`);
    await this.recordOperatorActionAsync('开播前检查', { mode: report.mode, passed: report.passed });
    useRuntimeStore.getState().setState({ preflight: report, mode: report.mode });
  }

  async arm(): Promise<void> {
    const report = useRuntimeStore.getState().preflight;
    if (!report?.passed) throw new Error('开播前检查有未通过的项目，不能待命');
    const currentSample = this.lastSample && performance.now() - this.lastSample.receivedAtMs <= 500
      ? this.lastSample
      : null;
    if (!currentSample) throw new Error('没有收到持续的 MTC 时间码。请到集成中心重新启动后再待命');
    if (!useRuntimeStore.getState().mtcStable) throw new Error('MTC 时间码还不稳定（需要连续稳定 500 ms），请稍等后重新做开播前检查');
    this.managedOutput.resetExecution();
    useRuntimeStore.getState().setState({ reports: [], mediaReports: [], currentCueId: null });
    if (this.project.obsOutputMode !== 'scenes') await linkDesktopViewModel.activateManagedObsOutput();
    await this.p1Lighting.prepare(this.project.playbackSource === 'internal' ? undefined : this.currentItem(), useIntegrationStore.getState().profile, Boolean(this.autoFollow), currentSample);
    this.applyRequiredUpdate(this.runtime.arm(performance.now(), currentSample));
    const skippedMedia = this.managedOutput.collectThrough(currentSample.totalFrames);
    await this.enqueueSkippedMedia(skippedMedia, '从当前 MTC 位置待命时，这个素材的切换点已经过了，没有自动补播');
    await this.recordOperatorActionAsync('从当前 MTC 位置待命', { skippedMediaActions: skippedMedia.length });
  }

  async armFromStart(assertCurrent: () => void = () => undefined): Promise<void> {
    const report = useRuntimeStore.getState().preflight;
    if (!report?.passed) throw new Error('开播前检查有未通过的项目，不能待命');
    await this.prepareArmFromStart(assertCurrent); assertCurrent();
    await this.recordOperatorActionAsync('从头待命');
  }

  pause(reason?: string): void {
    this.applyRequiredUpdate(this.runtime.pauseAutomatic(reason));
    if (!reason) this.recordOperatorAction('暂停自动联动');
  }

  resume(): void {
    this.applyRequiredUpdate(this.runtime.resumeAutomatic());
    this.recordOperatorAction('恢复自动联动');
  }

  async resyncCurrentTime(): Promise<void> {
    if (!this.lastSample) throw new Error('还没收到完整的 MTC 时间码');
    if (performance.now() - this.lastSample.receivedAtMs > 500) throw new Error('MTC 时间码还没恢复稳定，暂时不能按当前时间重新同步');
    const sample = this.lastSample;
    this.applyRequiredUpdate(this.runtime.resync(sample));
    const skippedMedia = this.managedOutput.collectThrough(sample.totalFrames);
    await this.enqueueSkippedMedia(skippedMedia, 'MTC 中断期间已经过了这个素材的切换点，没有自动补播');
    await this.recordOperatorActionAsync('按当前时间重新同步', { skippedMediaActions: skippedMedia.length });
  }

  rearmFromStart(): void {
    this.decoder.reset(); this.mtcStability.reset();
    this.lastSample = null;
    this.managedOutput.resetExecution();
    this.p1Lighting.restart();
    resetRuntimeExecutionView();
    this.applyRequiredUpdate(this.runtime.rearmFromStart(performance.now()));
    this.recordOperatorAction('从头重新待命');
  }

  async enableManualTakeover(): Promise<void> {
    this.applyRequiredUpdate(this.runtime.enableManualTakeover(this.lastSample));
    const skippedMedia = this.lastSample ? this.managedOutput.collectThrough(this.lastSample.totalFrames) : [];
    await this.enqueueSkippedMedia(skippedMedia, 'MTC 中断后已改为手动接管，没有自动补播');
    await this.recordOperatorActionAsync('确认手动接管', { skippedMediaActions: skippedMedia.length });
  }

  async manualGo(cueId: string): Promise<void> {
    if (this.internalObsOwner === 'main' && this.currentItem()?.cues.find(cue => cue.id === cueId)?.actions.some(action => action.kind.startsWith('obs.'))) {
      throw new Error('现在的画面由后台播放控制，不能再用手动接管触发。请先暂停，再定位到要播的位置');
    }
    await this.recordOperatorActionAsync('手动 GO', { cueId });
    const update = this.runtime.manualGo(cueId);
    this.applyUpdate(update);
    if (update.state === 'error') throw new Error(update.reason ?? '手动 GO 失败');
    await this.enqueueTimelineWork(update.dueCues, []);
  }

  async retryAction(cueId: string, actionId: string): Promise<void> {
    await this.recordOperatorActionAsync('重试失败或遗漏动作', { cueId, actionId });
    await retryReportedAction(cueId, actionId, this.runner, this.managedOutput, this.runtime.getMode());
  }

  async retryManagedMedia(event: ManagedMediaEvent): Promise<void> {
    await this.recordOperatorActionAsync('重试失败或遗漏素材动作', { eventId: event.id, clipId: event.clipId, phase: event.phase });
    const report = await this.managedOutput.executeMedia(event, 'live');
    appendMediaReport(report);
    if (report.status === 'failed') throw new Error(report.error ?? '素材动作重试失败');
  }

  async testAction(action: LinkAction): Promise<void> {
    await this.recordOperatorActionAsync('单步测试动作', { actionId: action.id, kind: action.kind });
    const result = await this.runner.retry('single-action-test', action);
    if (result.status === 'failed') throw new Error(result.error ?? '单步测试失败');
  }

  stop(suspendAuto = true, reason?: string): void {
    this.editorPreview.reset();
    this.internalPreparation.cancel();
    ++this.executionGeneration;
    this.p1Lighting.stop();
    this.internalClockActive = false;
    if (suspendAuto) { this.internalStopHandler?.(); this.autoFollow?.suspend(); }
    if (this.runtime.getState() === 'stopping') return;
    this.applyUpdate(this.runtime.stop(reason)); if (this.runtime.getState() === 'idle') return;
    if (!reason) this.recordOperatorAction('停止运行');
    const settled = this.internalPreparation.settledBefore(this.cueExecutionTail);
    const cleanupExecution = collectManagedOutputCleanupAfter(settled, this.managedOutput).then(async (cleanup) => {
      await executeManagedOutputCleanup(cleanup, this.managedOutput, this.runner);
      if (this.internalCaptureActive) { await linkDesktopViewModel.setInternalAudioCapture(false); this.internalCaptureActive = false; }
    });
    this.cueExecutionTail = cleanupExecution.then(
      () => { this.managedOutput.resetExecution(); this.applyUpdate(this.runtime.completeStop()); },
      (error: unknown) => this.reportRuntimeError(error)
    );
  }

  dispose(): void {
    this.internalPreparation.cancel();
    this.p1Lighting.stop();
    this.disposed = true; this.autoFollow?.dispose();
    this.executionGeneration += 1;
    this.midiSession.dispose();
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.midi.dispose();
  }

  private async ingestQuarterFrame(dataByte: number, receivedAt: number): Promise<void> {
    if (this.project.playbackSource === 'internal') return;
    const sample = this.decoder.push(dataByte, receivedAt);
    if (!sample) return;
    if (this.autoFollow) { this.autoFollow.push(sample); return; }
    await this.ingestSample(sample);
  }

  private async ingestSample(sample: MtcSample, followP1 = false): Promise<void> {
    const previousSample = this.lastSample, previousFrame = previousSample?.totalFrames ?? -1;
    const previousState = this.runtime.getState(); this.lastSample = sample;
    useRuntimeStore.getState().setState({
      timecode: sample.timecode,
      detectedFrameRate: sample.frameRate,
      mtcStable: this.mtcStability.update(previousSample, sample),
      lastMtcAt: sample.receivedAtMs
    });
    const resumingP1 = followP1 && previousState === 'timecodeLost';
    const resumingMedia = this.project.playbackSource === 'internal' && previousState === 'paused';
    const update = resumingMedia ? this.runtime.resumeMedia(sample) : resumingP1 ? this.runtime.resumeP1(sample) : this.runtime.ingest(sample);
    this.applyUpdate(update);
    if (this.internalObsOwner === 'main') {
      const cues = update.dueCues.flatMap(entry => {
        const actions = entry.cue.actions.filter(action => action.kind.startsWith('midi.'));
        return actions.length ? [{ ...entry, cue: { ...entry.cue, actions } }] : [];
      });
      await this.enqueueTimelineWork(cues, []); return;
    }
    if (update.state === 'running') this.p1Lighting.tick(sample);
    if ((resumingP1 || resumingMedia) && update.state === 'running') await this.syncMediaTransport('start');
    const managedMedia = (previousState === 'armed' || previousState === 'running' || resumingP1 || resumingMedia) && update.state === 'running'
      ? this.managedOutput.collectCrossed(previousFrame, sample.totalFrames)
      : [];
    const skippedMedia = previousState === 'paused' && update.state === 'paused' && !update.manualTakeover
      ? this.managedOutput.collectCrossed(previousFrame, sample.totalFrames)
      : [];
    const scenes = update.state === 'running' ? this.managedOutput.sceneTimeline : null;
    const work = scenes ? scenes[update.rebuild ? 'rebuild' : 'cross'](previousFrame, sample.totalFrames, update.dueCues, managedMedia) : { cues: update.dueCues, media: managedMedia };
    await this.enqueueTimelineWork(work.cues, work.media);
    await this.enqueueSkippedMedia(skippedMedia, '自动联动暂停期间已经过了这个素材的切换点，没有自动补播');
  }

  private enqueueTimelineWork(dueCues: RuntimeUpdate['dueCues'], mediaEvents: ManagedMediaEvent[]): Promise<void> {
    if (dueCues.length === 0 && mediaEvents.length === 0) return Promise.resolve();
    const generation = this.executionGeneration;
    const execution = this.cueExecutionTail.then(() => this.executeTimelineWork(dueCues, mediaEvents, generation));
    this.cueExecutionTail = execution.catch((error: unknown) => this.reportRuntimeError(error));
    return execution;
  }

  private enqueueSkippedMedia(events: readonly ManagedMediaEvent[], reason: string): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    const execution = this.cueExecutionTail.then(() => reportSkippedTimelineMedia(this.managedOutput, events, reason));
    this.cueExecutionTail = execution.catch((error: unknown) => this.reportRuntimeError(error));
    return execution;
  }

  private async executeTimelineWork(dueCues: RuntimeUpdate['dueCues'], mediaEvents: ManagedMediaEvent[], generation: number): Promise<void> {
    const canExecute = (): boolean => generation === this.executionGeneration;
    await executeTimelineWork(dueCues, mediaEvents, {
      canExecute, media: (event) => executeTimelineMedia(event, this.managedOutput, this.runtime.getMode(),
        this.autoFollow || this.project.playbackSource === 'internal' ? this.lastSample?.totalFrames ?? event.frameNumber : null),
      cue: (cue) => this.executeDueCues([cue], canExecute),
      skipCue: (cue, reason) => executeSkippedTimelineCue(cue, reason, this.runner, this.managedOutput, this.runtime.getMode(), () => this.nextCueId()),
      skipMedia: (event, reason) => reportSkippedTimelineMedia(this.managedOutput, [event], reason)
    });
  }

  private async executeDueCues(cues: LinkCue[], canExecute: () => boolean): Promise<void> {
    await executeDueCues(cues, this.runner, this.managedOutput, this.runtime.getMode(), canExecute,
      () => this.nextCueId());
  }

  private async prepareArmFromStart(assertCurrent: () => void = () => undefined): Promise<void> {
    this.decoder.reset(); this.mtcStability.reset(); this.lastSample = null;
    this.managedOutput.resetExecution(); resetRuntimeExecutionView();
    this.applyRequiredUpdate(await prepareRuntimeArm(this.project, this.currentItem(), {
      profile: useIntegrationStore.getState().profile, autoFollow: Boolean(this.autoFollow), lighting: this.p1Lighting, runtime: this.runtime, assertCurrent
    }));
  }

  private applyUpdate(update: RuntimeUpdate): void {
    if (useRuntimeStore.getState().state !== update.state && ['paused', 'timecodeLost', 'error', 'stopping'].includes(update.state)) {
      this.executionGeneration += 1;
      try { this.p1Lighting.suspend(this.lastSample); } catch (error) { this.reportRuntimeError(error); return; }
      if (this.autoFollow && (update.state === 'timecodeLost' || update.state === 'error')) void this.syncMediaTransport('pause').catch((error: unknown) => this.reportRuntimeError(error));
    }
    applyRuntimeState({ project: this.project, item: this.currentItem(), update, nextCueId: this.nextCueId() });
  }

  private async syncMediaTransport(action: 'pause' | 'start'): Promise<void> {
    if (this.internalObsOwner === 'main') return;
    const generation = this.executionGeneration;
    const execution = this.cueExecutionTail.then(() => synchronizeTimelineTransport(this.project, this.currentItem()?.id, action, this.lastSample?.totalFrames ?? 0,
      this.managedOutput, this.runner, this.runtime.getMode(), (cues, media) => this.executeTimelineWork(cues, media, generation)));
    this.cueExecutionTail = execution.catch((error: unknown) => this.reportRuntimeError(error));
    await execution;
  }

  private applyRequiredUpdate(update: RuntimeUpdate): void { this.applyUpdate(update); if (update.state === 'error') throw new Error(update.reason ?? '运行状态变更失败'); }

  private nextCueId(): string | null {
    return this.runtime.getNextCueId(this.lastSample?.totalFrames ?? -1);
  }

  private currentItem() { const id = useRuntimeStore.getState().currentItemId; return this.project.rundown.find((item) => item.id === id); }

  private reportRuntimeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.applyUpdate(this.runtime.failExecution(message));
    reportCoordinatorError(message, (reason) => useRuntimeStore.getState().setState({ state: 'error', reason }));
  }

  private recordOperatorAction(message: string, details?: Readonly<Record<string, unknown>>): void { void this.recordOperatorActionAsync(message, details).catch((error: unknown) => this.reportRuntimeError(error)); }

  private recordOperatorActionAsync(message: string, details?: Readonly<Record<string, unknown>>): Promise<void> { return recordRuntimeOperator(this.project.projectId, this.currentItem(), message, details); }

}
