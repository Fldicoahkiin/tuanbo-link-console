import { MANAGED_OBS_SCENE_NAME, collectCrossedManagedMediaEvents, compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import type { CueActionRunner } from './cue-action-runner';
import { playbackFramesPerSecond } from './mtc-timecode';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { LinkRunMode } from './cue-runtime';
import type { LinkAction, LinkCue, LinkProject, RundownItem } from '@tb/schema';
import { SceneOutputTimeline } from './scene-output-timeline';

export type ManagedMediaExecutionReport = {
  executionId: string; event: ManagedMediaEvent; status: 'succeeded' | 'failed' | 'skipped';
  startedAt: number; finishedAt: number; durationMs: number; error?: string;
};

export type ManagedOutputRuntimeDependencies = Pick<LinkDesktopApi, 'executeManagedMediaEvent' | 'recordLog'>;

export type ManagedOutputCleanup = { cameraCues: LinkCue[]; mediaEvents: ManagedMediaEvent[] };

export async function collectManagedOutputCleanupAfter(
  pendingTimelineWork: Promise<void>,
  runtime: Pick<ManagedOutputRuntime, 'takeCleanup'>
): Promise<ManagedOutputCleanup> {
  await pendingTimelineWork;
  return runtime.takeCleanup();
}

export class ManagedOutputRuntime {
  private selectedItem: RundownItem | null = null;
  private mediaEvents: ManagedMediaEvent[] = [];
  private preparedScenes: SceneOutputTimeline | null = null;
  get sceneTimeline(): SceneOutputTimeline | null { return this.preparedScenes; }
  private readonly executedMediaEventIds = new Set<string>();
  private readonly activeMediaByLayer = new Map<string, Map<string, ManagedMediaEvent>>();
  private readonly activeObsSourcesByLayer = new Map<string, Set<string>>();

  constructor(
    private readonly project: LinkProject,
    private readonly projectPath: string | null,
    private readonly dependencies: ManagedOutputRuntimeDependencies
  ) {}

  selectItem(itemId: string): void {
    this.selectedItem = this.project.rundown.find((item) => item.id === itemId) ?? null;
    this.mediaEvents = compileManagedMediaTimeline(this.project, itemId).events;
    this.preparedScenes = this.project.obsOutputMode === 'scenes' ? new SceneOutputTimeline(this.project, itemId, this.mediaEvents) : null;
    this.resetExecution();
  }

  resetExecution(): void {
    this.executedMediaEventIds.clear();
    this.activeMediaByLayer.clear();
    this.activeObsSourcesByLayer.clear();
  }
  isActiveMedia(event: ManagedMediaEvent): boolean {
    return this.activeMediaByLayer.get(event.layerId)?.get(event.sourceName)?.clipId === event.clipId;
  }
  adoptSeek(event: ManagedMediaEvent | ManagedMediaEvent[] | undefined, frame: number): void {
    this.resetExecution(); this.collectThrough(frame);
    for (const entry of Array.isArray(event) ? event : event ? [event] : []) this.addActiveMedia(entry);
  }

  transportActions(action: 'pause' | 'start'): LinkAction[] {
    const names = new Set([...this.activeMediaByLayer.values()].flatMap((entries) =>
      [...entries.values()].filter((event) => event.assetKind !== 'image').map((event) => event.sourceName)));
    return [...names].map((inputName) => ({ id: crypto.randomUUID(), label: `P1 同步${action === 'pause' ? '暂停' : '继续'}`,
      kind: 'obs.mediaAction', inputName, action }));
  }

  alignEvent(event: ManagedMediaEvent, currentFrame: number): ManagedMediaEvent {
    if (event.phase !== 'start' || event.assetKind === 'image') return event;
    const original = this.mediaEvents.find((candidate) => candidate.id === event.id) ?? event;
    return { ...original, deferSceneSwitch: event.deferSceneSwitch, sourceOffsetMs: original.sourceOffsetMs
      + Math.round(Math.max(0, currentFrame - original.frameNumber) * 1000 / playbackFramesPerSecond(this.project.timebase.frameRate)) };
  }

  async executeTransport(runner: CueActionRunner, action: 'pause' | 'start', currentFrame: number): Promise<void> {
    if (action === 'start' && this.project.obsOutputMode !== 'scenes') {
      const events = [...this.activeMediaByLayer.values()].flatMap((entries) => [...entries.values()]);
      for (const event of events.filter((entry) => entry.assetKind !== 'image')) {
        await this.executeMedia(this.alignEvent(event, currentFrame), 'rehearsal');
      }
      return;
    }
    for (const command of this.transportActions(action)) {
      const result = await runner.retry('p1-transport', command);
      if (result.status === 'failed') throw new Error(result.error ?? 'OBS 媒体同步失败');
    }
  }

  collectCrossed(previousFrame: number, currentFrame: number): ManagedMediaEvent[] {
    const events = collectCrossedManagedMediaEvents(this.mediaEvents, previousFrame, currentFrame, this.executedMediaEventIds);
    for (const event of events) this.executedMediaEventIds.add(event.id);
    return events;
  }

  collectThrough(currentFrame: number): ManagedMediaEvent[] {
    const events = this.mediaEvents.filter((event) => (
      event.frameNumber <= currentFrame && !this.executedMediaEventIds.has(event.id)
    ));
    for (const event of events) this.executedMediaEventIds.add(event.id);
    return events;
  }

  async reportSkippedMedia(
    events: readonly ManagedMediaEvent[],
    reason: string
  ): Promise<ManagedMediaExecutionReport[]> {
    const reports: ManagedMediaExecutionReport[] = [];
    for (const event of events) {
      const executionId = crypto.randomUUID();
      const at = performance.now();
      await this.recordMediaEvent(event, executionId, 'skipped', reason);
      reports.push(mediaReport(executionId, event, 'skipped', at, performance.now(), reason));
    }
    return reports;
  }

  compileVisualCue(cue: LinkCue): LinkCue {
    if (!cue.layerId || !this.selectedItem) return cue;
    const show = findManagedShowAction(cue);
    if (!show) return cue;
    const layerIndex = this.selectedItem.visualLayers.findIndex((layer) => layer.id === cue.layerId);
    if (layerIndex < 0) return cue;
    const generated: LinkAction[] = [];
    const previousSources = [...(this.activeObsSourcesByLayer.get(cue.layerId) ?? [])]
      .filter((sourceName) => sourceName !== show.sourceName);
    for (const [index, previousSource] of previousSources.entries()) {
      generated.push({
        id: `${cue.id}:hide-previous:${index}`, label: `隐藏上一来源 · ${previousSource}`,
        kind: 'obs.setSceneItemEnabled', sceneName: MANAGED_OBS_SCENE_NAME, sourceName: previousSource, enabled: false
      });
    }
    generated.push({
      id: `${cue.id}:layer-index`, label: `应用图层层序 · ${show.sourceName}`,
      kind: 'obs.setSceneItemIndex', sceneName: MANAGED_OBS_SCENE_NAME, sourceName: show.sourceName,
      sceneItemIndex: Math.max(0, this.selectedItem.visualLayers.length - layerIndex - 1)
    });
    return { ...cue, actions: [...generated, ...cue.actions] };
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

  applyRetriedVisualAction(cueId: string, action: LinkAction, status: string): void {
    if (status !== 'succeeded' || action.kind !== 'obs.setSceneItemEnabled' || action.sceneName !== MANAGED_OBS_SCENE_NAME) return;
    const originalCueId = cueId.endsWith(':duration-end') ? cueId.slice(0, -':duration-end'.length) : cueId;
    const layerId = this.selectedItem?.cues.find((cue) => cue.id === originalCueId)?.layerId;
    if (!layerId) return;
    if (action.enabled) this.addActiveObsSource(layerId, action.sourceName);
    else this.removeActiveObsSource(layerId, action.sourceName);
  }

  trackVisualActionAttempt(cueId: string, action: LinkAction): void {
    if (action.kind !== 'obs.setSceneItemEnabled' || action.sceneName !== MANAGED_OBS_SCENE_NAME || !action.enabled) return;
    const layerId = this.selectedItem?.cues.find((cue) => cue.id === cueId)?.layerId;
    if (layerId) this.addActiveObsSource(layerId, action.sourceName);
  }

  takeCleanup(): ManagedOutputCleanup {
    const mediaEvents = [...this.activeMediaByLayer.values()].flatMap((sources) => [...sources.values()]).map((event) => ({
      ...event, id: `${event.id}:operator-stop`, phase: 'stop' as const
    }));
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
    return { cameraCues, mediaEvents };
  }

  async executeMedia(event: ManagedMediaEvent, mode: LinkRunMode, canExecute: () => boolean = () => true): Promise<ManagedMediaExecutionReport> {
    const executionId = crypto.randomUUID();
    const startedAt = performance.now();
    if (event.phase === 'stop' && this.activeMediaByLayer.get(event.layerId)?.get(event.sourceName)?.clipId !== event.clipId) {
      const error = '对应片段未在本次运行中成功启动';
      await this.recordMediaEvent(event, executionId, 'skipped', error);
      return mediaReport(executionId, event, 'skipped', startedAt, performance.now(), error);
    }
    if (!this.projectPath) {
      return this.finishFailedMedia(event, executionId, startedAt, '工程尚未保存，不能向 OBS 发布本地媒体', mode);
    }
    await this.recordMediaEvent(event, executionId, 'running');
    // Logging and preparation can yield to pause/stop. Recheck immediately before
    // crossing the output boundary, not only before this async operation began.
    if (!canExecute()) {
      const reason = '运行已取消或超过执行边界，未发送素材动作';
      await this.recordMediaEvent(event, executionId, 'skipped', reason);
      return mediaReport(executionId, event, 'skipped', startedAt, performance.now(), reason);
    }
    try {
      await this.dependencies.executeManagedMediaEvent({ projectPath: this.projectPath, event });
      if (event.phase === 'start') this.addActiveMedia(event);
      else this.removeActiveMedia(event);
      await this.recordMediaEvent(event, executionId, 'succeeded');
      return mediaReport(executionId, event, 'succeeded', startedAt, performance.now());
    } catch (error) {
      if (event.phase === 'start') this.addActiveMedia(event);
      return this.finishFailedMedia(event, executionId, startedAt, error instanceof Error ? error.message : String(error), mode);
    }
  }

  private async finishFailedMedia(
    event: ManagedMediaEvent,
    executionId: string,
    startedAt: number,
    error: string,
    mode: LinkRunMode
  ): Promise<ManagedMediaExecutionReport> {
    await this.recordMediaEvent(event, executionId, 'failed', error);
    const report = mediaReport(executionId, event, 'failed', startedAt, performance.now(), error);
    if (mode === 'rehearsal') throw new ManagedMediaExecutionError(report);
    return report;
  }

  private async recordMediaEvent(
    event: ManagedMediaEvent,
    executionId: string,
    result: 'running' | 'succeeded' | 'failed' | 'skipped',
    error?: string
  ): Promise<void> {
    await this.dependencies.recordLog({
      level: result === 'failed' ? 'error' : result === 'skipped' ? 'warning' : 'info',
      category: 'action',
      message: `${event.phase === 'start' ? '播放' : '停止'}素材 · ${event.assetName} · ${result}`,
      projectId: this.project.projectId,
      itemId: event.itemId,
      cueId: event.id,
      actionId: event.id,
      executionId,
      device: 'obs',
      result,
      details: { clipId: event.clipId, layerId: event.layerId, frameNumber: event.frameNumber, sourceOffsetMs: event.sourceOffsetMs, sceneName: event.sceneName, ...(error ? { error } : {}) }
    });
  }

  private addActiveObsSource(layerId: string, sourceName: string): void {
    const sources = this.activeObsSourcesByLayer.get(layerId) ?? new Set<string>();
    sources.add(sourceName);
    this.activeObsSourcesByLayer.set(layerId, sources);
  }

  private addActiveMedia(event: ManagedMediaEvent): void {
    const sources = this.activeMediaByLayer.get(event.layerId) ?? new Map<string, ManagedMediaEvent>();
    sources.set(event.sourceName, event);
    this.activeMediaByLayer.set(event.layerId, sources);
  }

  private removeActiveMedia(event: ManagedMediaEvent): void {
    const sources = this.activeMediaByLayer.get(event.layerId);
    if (!sources) return;
    sources.delete(event.sourceName);
    if (sources.size === 0) this.activeMediaByLayer.delete(event.layerId);
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
