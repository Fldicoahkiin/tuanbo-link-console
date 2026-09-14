import type { CueActionRunner } from '@tb/core/link';
import type { ManagedOutputCleanup, ManagedOutputRuntime } from './managed-output-runtime';
import { appendCueReport, appendMediaReport } from './runtime-report-store';

type CleanupRuntime = Pick<ManagedOutputRuntime, 'executeMedia' | 'compileVisualCue' | 'applyVisualCueResult'>;
type CleanupRunner = Pick<CueActionRunner, 'run'>;

export async function executeManagedOutputCleanup(
  cleanup: ManagedOutputCleanup,
  runtime: CleanupRuntime,
  runner: CleanupRunner
): Promise<void> {
  const errors: Error[] = [];
  for (const event of cleanup.mediaEvents) {
    try {
      const report = await runtime.executeMedia(event, 'live');
      appendMediaReport(report);
      if (report.status !== 'succeeded') errors.push(new Error(report.error ?? `${event.assetName} 停止失败`));
    } catch (error) {
      errors.push(toError(error));
    }
  }
  for (const cue of cleanup.cameraCues) {
    try {
      const executionCue = runtime.compileVisualCue(cue);
      const report = await runner.run(executionCue, 'live');
      runtime.applyVisualCueResult(cue, executionCue, report.results);
      appendCueReport(report);
      for (const result of report.results) {
        if (result.status === 'failed') errors.push(new Error(result.error ?? `${result.kind} 清理失败`));
      }
    } catch (error) {
      errors.push(toError(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(`受管 OBS 输出清理不完整：${errors.map((error) => error.message).join('；')}`, {
      cause: new AggregateError(errors)
    });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
