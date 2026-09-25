import type { CueActionRunner, ManagedMediaEvent, PreflightMode, RuntimeUpdate } from '@tb/core/link';
import type { LinkCue, LinkProject } from '@tb/schema';
import type { ManagedOutputRuntime } from './managed-output-runtime';
import { useRuntimeStore } from '../stores/runtime-store';
import { sceneOutputAt } from './scene-output-timeline';
import { appendMediaReport } from './runtime-report-store';

export async function reportSkippedTimelineMedia(managed: ManagedOutputRuntime, events: readonly ManagedMediaEvent[], reason: string): Promise<void> {
  for (const report of await managed.reportSkippedMedia(events, reason)) appendMediaReport(report);
}

export async function executeSkippedTimelineCue(cue: LinkCue, reason: string, runner: CueActionRunner,
  managed: ManagedOutputRuntime, mode: PreflightMode, nextCueId: () => string | null): Promise<void> {
  const report = await runner.skip(managed.compileVisualCue(cue), mode, reason);
  useRuntimeStore.getState().setState({ reports: [...useRuntimeStore.getState().reports, report], nextCueId: nextCueId() });
}

export async function synchronizeTimelineTransport(project: LinkProject, itemId: string | undefined, action: 'pause' | 'start', frame: number,
  managed: ManagedOutputRuntime, runner: CueActionRunner,
  execute: (cues: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]) => Promise<void>): Promise<void> {
  await managed.executeTransport(runner, action, frame);
  if (action !== 'start' || project.obsOutputMode !== 'scenes' || !itemId) return;
  const work = sceneOutputAt(project, itemId, frame);
  // Internal audio resumes the paused decoder; don't seek/restart it a second time.
  await execute(work.cues, project.playbackSource === 'internal' ? [] : work.media);
}

export async function executeDueCues(cues: LinkCue[], runner: CueActionRunner, managed: ManagedOutputRuntime,
  mode: PreflightMode, canExecute: () => boolean, nextCueId: () => string | null): Promise<void> {
  for (const cue of cues) {
    useRuntimeStore.getState().setState({ currentCueId: cue.id });
    const compiled = managed.compileVisualCue(cue);
    for (const action of compiled.actions) managed.trackVisualActionAttempt(cue.id, action);
    const report = await runner.run(compiled, mode, canExecute);
    managed.applyVisualCueResult(cue, compiled, report.results);
    useRuntimeStore.getState().setState({ reports: [...useRuntimeStore.getState().reports, report] });
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
      const reason = blocked ? `当前批次已被前序错误阻断：${blocked.message}` : '运行已暂停、中断或停止，未执行排队动作';
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
