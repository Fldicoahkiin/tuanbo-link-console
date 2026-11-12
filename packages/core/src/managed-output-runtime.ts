import { MANAGED_OBS_SCENE_NAME, compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import { playbackFramesPerSecond } from './mtc-timecode';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { LinkRunMode } from './cue-runtime';
import type { LinkAction, LinkCue, LinkProject, RundownItem } from '@tb/schema';
import { SceneOutputTimeline } from './scene-output-timeline';

/** What a media step came to, as the main process's OBS output tells it. `withdrawn`: none of
 * its requests went out; `unanswered`: one went out and OBS never answered, so it may or may
 * not have been carried out; `failed`: OBS refused or the step stopped part way, `onAir` when
 * the clip is on the picture all the same, `outOfStep` when that clip is not in step with the
 * music, `sent` when one of its requests went out (then a clip not known to be on air may be
 * all the same: the session counts it as not known, 0.5.9 R5). The report and its log keep the
 * wording the step's error had; only the picture session reads the kind. */
export type ManagedMediaOutcome =
  | { kind: 'done' }
  | { kind: 'withdrawn'; reason: string }
  | { kind: 'unanswered'; reason: string }
  | { kind: 'failed'; reason: string; onAir: boolean; outOfStep: boolean; sent: boolean };

/** `outcome`: the step's kind, when the output told it. */
export type ManagedMediaExecutionReport = {
  executionId: string; event: ManagedMediaEvent; status: 'succeeded' | 'failed' | 'skipped';
  startedAt: number; finishedAt: number; durationMs: number; error?: string; outcome?: ManagedMediaOutcome;
};

/** `executeManagedMediaEvent` either throws, as over IPC, or resolves with the step's outcome. */
export type ManagedOutputRuntimeDependencies = Pick<LinkDesktopApi, 'recordLog'> & {
  executeManagedMediaEvent: (payload: Parameters<LinkDesktopApi['executeManagedMediaEvent']>[0]) => Promise<ManagedMediaOutcome | void>;
};

export type ManagedOutputCleanup = { cameraCues: LinkCue[] };

/** The skipped report for a clip stop whose start this run did not send. */
export const MEDIA_NOT_STARTED = '对应的片段这次没有成功启动';

/** One media action per input, playing or pausing it with the song. */
export function mediaTransportActions(action: 'pause' | 'start', sources: readonly string[]): LinkAction[] {
  return sources.map((inputName) => ({ id: crypto.randomUUID(), label: `P1 同步${action === 'pause' ? '暂停' : '继续'}`,
    kind: 'obs.mediaAction', inputName, action }));
}

/** A clip start moved to `currentFrame`: the compiled start `original`, its source position
 * that far into the clip, with `event`'s scene switch choice. Stops and images are unchanged. */
export function alignManagedMediaEvent(event: ManagedMediaEvent, original: ManagedMediaEvent, currentFrame: number, frameRate: LinkProject['timebase']['frameRate']): ManagedMediaEvent {
  if (event.phase !== 'start' || event.assetKind === 'image') return event;
  return { ...original, deferSceneSwitch: event.deferSceneSwitch, sourceOffsetMs: original.sourceOffsetMs
    + Math.round(Math.max(0, currentFrame - original.frameNumber) * 1000 / playbackFramesPerSecond(frameRate)) };
}

export class ManagedOutputRuntime {
  private selectedItem: RundownItem | null = null;
  private preparedScenes: SceneOutputTimeline | null = null;
  get sceneTimeline(): SceneOutputTimeline | null { return this.preparedScenes; }
  private readonly activeObsSourcesByLayer = new Map<string, Set<string>>();

  constructor(
    private project: LinkProject,
    private readonly projectPath: string | null,
    private readonly dependencies: ManagedOutputRuntimeDependencies
  ) {}

  selectItem(itemId: string): void {
    this.selectedItem = this.project.rundown.find((item) => item.id === itemId) ?? null;
    this.preparedScenes = new SceneOutputTimeline(this.project, itemId, compileManagedMediaTimeline(this.project, itemId).events);
    this.resetExecution();
  }

  /** A newer version of the song's plan while it plays (0.5.9 R9): what is derived from the project is replaced, the
   * run's record of what it showed (its cleanup at the stop) stays. The caller built `scenes` from `project`, so that
   * nothing here can fail half way. */
  retarget(project: LinkProject, itemId: string, scenes: SceneOutputTimeline): void {
    this.project = project;
    this.selectedItem = project.rundown.find((item) => item.id === itemId) ?? null;
    this.preparedScenes = scenes;
  }

  /** Forgets the sources this run showed on the owned output scene. */
  resetExecution(): void {
    this.activeObsSourcesByLayer.clear();
  }

  /** An older show-source cue first hides what its track showed before. */
  compileVisualCue(cue: LinkCue): LinkCue {
    if (!cue.layerId) return cue;
    const show = findManagedShowAction(cue);
    if (!show) return cue;
    const hides = [...(this.activeObsSourcesByLayer.get(cue.layerId) ?? [])]
      .filter((sourceName) => sourceName !== show.sourceName)
      .map((sourceName, index): LinkAction => ({
        id: `${cue.id}:hide-previous:${index}`, label: `隐藏上一来源 · ${sourceName}`,
        kind: 'obs.setSceneItemEnabled', sceneName: MANAGED_OBS_SCENE_NAME, sourceName, enabled: false
      }));
    return hides.length ? { ...cue, actions: [...hides, ...cue.actions] } : cue;
  }

  applyVisualCueResult(
    originalCue: LinkCue,
    executionCue: LinkCue,
    results: Array<{ actionId: string; status: string }>
  ): void {
    if (!originalCue.layerId) return;
    const durationHide = findManagedHideAction(originalCue);
    if (durationHide) {
      const hideResult = results.find((result) => result.actionId === durationHide.id);
      if (hideResult?.status === 'succeeded') this.removeActiveObsSource(originalCue.layerId, durationHide.sourceName);
      return;
    }
    const show = findManagedShowAction(originalCue);
    if (!show) return;
    const showResult = results.find((result) => result.actionId === show.id);
    for (const hide of executionCue.actions.filter((action) => action.id.startsWith(`${originalCue.id}:hide-previous:`))) {
      const hideResult = results.find((result) => result.actionId === hide.id);
      if (hide.kind === 'obs.setSceneItemEnabled' && hideResult?.status === 'succeeded') {
        this.removeActiveObsSource(originalCue.layerId, hide.sourceName);
      }
    }
    if (showResult?.status === 'succeeded') this.addActiveObsSource(originalCue.layerId, show.sourceName);
  }

  trackVisualActionAttempt(cueId: string, action: LinkAction): void {
    if (action.kind !== 'obs.setSceneItemEnabled' || action.sceneName !== MANAGED_OBS_SCENE_NAME || !action.enabled) return;
    const layerId = this.selectedItem?.cues.find((cue) => cue.id === cueId)?.layerId;
    if (layerId) this.addActiveObsSource(layerId, action.sourceName);
  }

  /** The sources this run shows on the owned output scene, over all its tracks. */
  ownedSceneSources(): ReadonlySet<string> {
    return new Set([...this.activeObsSourcesByLayer.values()].flatMap((sources) => [...sources]));
  }

  takeCleanup(): ManagedOutputCleanup {
    const cameraCues = [...this.activeObsSourcesByLayer.entries()].flatMap(([layerId, sourceNames]) => [...sourceNames].map((sourceName, index) => ({
      id: `managed-camera-stop:${layerId}:${index}`,
      name: `停止机位 · ${sourceName}`,
      timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      enabled: true,
      notes: '运行停止清理',
      layerId,
      actions: [{
        id: `managed-camera-stop:${layerId}:hide`, label: `隐藏来源 · ${sourceName}`,
        kind: 'obs.setSceneItemEnabled' as const, sceneName: MANAGED_OBS_SCENE_NAME, sourceName, enabled: false
      }]
    })));
    return { cameraCues };
  }

  /** Sends a clip event, reported and logged. Which clips are on air is not kept here: the picture
   * session decides from its ledger. */
  sendMedia(event: ManagedMediaEvent, mode: LinkRunMode, canExecute: () => boolean = () => true): Promise<ManagedMediaExecutionReport> {
    return this.runMedia(event, mode, canExecute);
  }

  /** A clip event not sent, reported and logged as skipped with why. */
  async skippedMedia(event: ManagedMediaEvent, reason: string): Promise<ManagedMediaExecutionReport> {
    const executionId = crypto.randomUUID();
    const startedAt = performance.now();
    await this.recordMediaEvent(event, executionId, 'skipped', 0, reason);
    return mediaReport(executionId, event, 'skipped', startedAt, performance.now(), reason);
  }

  private async runMedia(event: ManagedMediaEvent, mode: LinkRunMode, canExecute: () => boolean): Promise<ManagedMediaExecutionReport> {
    const executionId = crypto.randomUUID();
    const startedAt = performance.now();
    if (!this.projectPath) {
      return this.finishFailedMedia(event, executionId, startedAt, '工程还没保存，不能把本地媒体放进 OBS', mode);
    }
    // Preparation can yield to pause/stop. Recheck immediately before crossing the
    // output boundary, not only before this async operation began.
    if (!canExecute()) {
      const reason = '运行已取消或已过时，素材动作没有发送';
      await this.recordMediaEvent(event, executionId, 'skipped', performance.now() - startedAt, reason);
      return mediaReport(executionId, event, 'skipped', startedAt, performance.now(), reason);
    }
    let outcome: ManagedMediaOutcome | void;
    try {
      outcome = await this.dependencies.executeManagedMediaEvent({ projectPath: this.projectPath, event });
      if (!outcome || outcome.kind === 'done') {
        await this.recordMediaEvent(event, executionId, 'succeeded', performance.now() - startedAt);
        return { ...mediaReport(executionId, event, 'succeeded', startedAt, performance.now()), ...(outcome ? { outcome } : {}) };
      }
    } catch (error) {
      return this.finishFailedMedia(event, executionId, startedAt, error instanceof Error ? error.message : String(error), mode);
    }
    // An outcome other than done is reported exactly as the error it stands for would be.
    return this.finishFailedMedia(event, executionId, startedAt, outcome.reason, mode, outcome);
  }

  private async finishFailedMedia(
    event: ManagedMediaEvent,
    executionId: string,
    startedAt: number,
    error: string,
    mode: LinkRunMode,
    outcome?: ManagedMediaOutcome
  ): Promise<ManagedMediaExecutionReport> {
    await this.recordMediaEvent(event, executionId, 'failed', performance.now() - startedAt, error);
    const report = { ...mediaReport(executionId, event, 'failed', startedAt, performance.now(), error), ...(outcome ? { outcome } : {}) };
    if (mode === 'rehearsal') throw new ManagedMediaExecutionError(report);
    return report;
  }

  /** One result entry per media action, with how long it took and, when it failed or was skipped, why. */
  private async recordMediaEvent(
    event: ManagedMediaEvent,
    executionId: string,
    result: 'succeeded' | 'failed' | 'skipped',
    durationMs: number,
    error?: string
  ): Promise<void> {
    await this.dependencies.recordLog({
      level: result === 'failed' ? 'error' : 'info',
      category: 'action',
      message: `${event.phase === 'start' ? '播放' : '停止'}素材 · ${event.assetName} · ${result}${error ? `：${error}` : ''}`,
      projectId: this.project.projectId,
      itemId: event.itemId,
      cueId: event.id,
      actionId: event.id,
      executionId,
      device: 'obs',
      result,
      details: { clipId: event.clipId, layerId: event.layerId, frameNumber: event.frameNumber, sourceOffsetMs: event.sourceOffsetMs, sceneName: event.sceneName, durationMs: Math.round(durationMs), ...(error ? { error } : {}) }
    });
  }

  private addActiveObsSource(layerId: string, sourceName: string): void {
    const sources = this.activeObsSourcesByLayer.get(layerId) ?? new Set<string>();
    sources.add(sourceName);
    this.activeObsSourcesByLayer.set(layerId, sources);
  }

  private removeActiveObsSource(layerId: string, sourceName: string): void {
    const sources = this.activeObsSourcesByLayer.get(layerId);
    if (!sources) return;
    sources.delete(sourceName);
    if (sources.size === 0) this.activeObsSourcesByLayer.delete(layerId);
  }
}

function findManagedHideAction(cue: LinkCue): Extract<LinkAction, { kind: 'obs.setSceneItemEnabled' }> | null {
  const action = cue.actions.find((candidate) => (
    candidate.kind === 'obs.setSceneItemEnabled'
    && candidate.sceneName === MANAGED_OBS_SCENE_NAME
    && !candidate.enabled
  ));
  return action?.kind === 'obs.setSceneItemEnabled' ? action : null;
}

export class ManagedMediaExecutionError extends Error {
  constructor(readonly report: ManagedMediaExecutionReport) {
    super(report.error ?? `${report.event.assetName} 执行失败`);
    this.name = 'ManagedMediaExecutionError';
  }
}

function mediaReport(
  executionId: string,
  event: ManagedMediaEvent,
  status: ManagedMediaExecutionReport['status'],
  startedAt: number,
  finishedAt: number,
  error?: string
): ManagedMediaExecutionReport {
  return {
    executionId,
    event,
    status,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    ...(error ? { error } : {})
  };
}

function findManagedShowAction(cue: LinkCue): Extract<LinkAction, { kind: 'obs.setSceneItemEnabled' }> | null {
  const action = cue.actions.find((candidate) => (
    candidate.kind === 'obs.setSceneItemEnabled'
    && candidate.sceneName === MANAGED_OBS_SCENE_NAME
    && candidate.enabled
  ));
  return action?.kind === 'obs.setSceneItemEnabled' ? action : null;
}
