import type { CueActionRunner, ManagedMediaEvent, PreflightMode, RuntimeUpdate } from '@tb/core/link';
import type { LinkCue } from '@tb/schema';
import type { ManagedOutputRuntime } from './managed-output-runtime';
import { useRuntimeStore } from '../stores/runtime-store';

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
