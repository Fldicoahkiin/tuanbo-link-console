import type { CueActionRunner, ManagedMediaEvent, PreflightMode, RuntimeUpdate } from '@tb/core/link';
import type { LinkCue, LinkProject } from '@tb/schema';
import { ManagedMediaExecutionError, type ManagedOutputRuntime } from '@tb/core/link';
import { useRuntimeStore } from '../stores/runtime-store';
import { SceneOutputTimeline } from '@tb/core/link';
import { appendCueReport, appendMediaReport, appendRetryActionReport } from './runtime-report-store';

export async function executeTimelineMedia(event: ManagedMediaEvent, managed: ManagedOutputRuntime,
  mode: PreflightMode, frame: number | null): Promise<void> {
  try { appendMediaReport(await managed.executeMedia(frame === null ? event : managed.alignEvent(event, frame), mode)); }
  catch (error) {
    if (error instanceof ManagedMediaExecutionError) appendMediaReport(error.report);
    throw error;
  }
}

export async function reportSkippedTimelineMedia(managed: ManagedOutputRuntime, events: readonly ManagedMediaEvent[], reason: string): Promise<void> {
  for (const report of await managed.reportSkippedMedia(events, reason)) appendMediaReport(report);
}

export async function executeSkippedTimelineCue(cue: LinkCue, reason: string, runner: CueActionRunner,
  managed: ManagedOutputRuntime, mode: PreflightMode, nextCueId: () => string | null): Promise<void> {
  const report = await runner.skip(managed.compileVisualCue(cue), mode, reason);
  appendCueReport(report);
  useRuntimeStore.getState().setState({ nextCueId: nextCueId() });
}

export async function synchronizeTimelineTransport(project: LinkProject, itemId: string | undefined, action: 'pause' | 'start', frame: number,
  managed: ManagedOutputRuntime, runner: CueActionRunner, mode: PreflightMode,
  execute: (cues: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]) => Promise<void>): Promise<void> {
  // Live failures are shown on their action; the restored composition below still runs.
  const failures = await managed.executeTransport(runner, action, frame, mode);
  for (const result of failures.actions) appendRetryActionReport(result, mode);
  for (const report of failures.media) appendMediaReport(report);
  if (action !== 'start' || !itemId) return;
  const work = new SceneOutputTimeline(project, itemId).at(frame);
  // Internal audio resumes the paused decoder; don't seek/restart it a second time.
  await execute(work.cues, project.playbackSource === 'internal' ? [] : work.media);
}

/** Operator retry of a failed or missed action, as last reported in this run. */
export async function retryReportedAction(cueId: string, actionId: string, runner: CueActionRunner, managed: ManagedOutputRuntime, mode: PreflightMode): Promise<void> {
  const action = useRuntimeStore.getState().reports
    .flatMap((report) => report.results)
    .reverse()
    .find((result) => result.cueId === cueId && result.actionId === actionId)?.action;
  if (!action) throw new Error('要重试的动作不存在');
  managed.trackVisualActionAttempt(cueId, action); const result = await runner.retry(cueId, action);
  managed.applyRetriedVisualAction(cueId, action, result.status);
  appendRetryActionReport(result, mode);
  if (result.status === 'failed') throw new Error(result.error ?? '动作重试失败');
}

export async function executeDueCues(cues: LinkCue[], runner: CueActionRunner, managed: ManagedOutputRuntime,
  mode: PreflightMode, canExecute: () => boolean, nextCueId: () => string | null): Promise<void> {
  for (const cue of cues) {
    useRuntimeStore.getState().setState({ currentCueId: cue.id });
    const compiled = managed.compileVisualCue(cue);
    for (const action of compiled.actions) managed.trackVisualActionAttempt(cue.id, action);
    const report = await runner.run(compiled, mode, canExecute);
    managed.applyVisualCueResult(cue, compiled, report.results);
    appendCueReport(report);
    useRuntimeStore.getState().setState({ nextCueId: nextCueId() });
    const failed = report.results.find((result) => result.status === 'failed');
    if (failed && mode === 'rehearsal') throw new Error(`排练动作失败：${failed.kind}：${failed.error ?? '未知错误'}`);
  }
}

export async function executeTimelineWork(dueCues: RuntimeUpdate['dueCues'], mediaEvents: ManagedMediaEvent[], handlers: {
  canExecute: () => boolean;
  media: (event: ManagedMediaEvent) => Promise<void>;
  cue: (cue: LinkCue) => Promise<void>;
  skipMedia: (event: ManagedMediaEvent, reason: string) => Promise<void>;
  skipCue: (cue: LinkCue, reason: string) => Promise<void>;
}): Promise<void> {
  const work = [
    // OBS only restarts a showing source: activate the composition before its media.
    ...dueCues.map((due) => ({ frame: due.scheduledFrame, priority: 1, cue: due.cue } as const)),
    ...mediaEvents.map((event) => ({ frame: event.frameNumber, priority: event.phase === 'stop' ? 0 : 2, event } as const))
  ].sort((left, right) => left.frame - right.frame || left.priority - right.priority);
  let blocked: Error | null = null;
  for (const entry of work) {
    if (blocked || !handlers.canExecute()) {
      const reason = blocked ? `前面的动作出错，后面的动作没有执行：${blocked.message}` : '运行已暂停或停止，排队的动作没有执行';
      if ('event' in entry) await handlers.skipMedia(entry.event, reason);
      else await handlers.skipCue(entry.cue, reason);
      continue;
    }
    try {
      if ('event' in entry) await handlers.media(entry.event);
      else await handlers.cue(entry.cue);
    } catch (error) { blocked = error instanceof Error ? error : new Error(String(error)); }
  }
  if (blocked) throw blocked;
}
