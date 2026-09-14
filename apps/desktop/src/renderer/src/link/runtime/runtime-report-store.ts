import type { ActionExecutionResult, CueExecutionReport, LinkRunMode } from '@tb/core/link';
import { useRuntimeStore, type ManagedMediaExecutionReport } from '../stores/runtime-store';

export function appendMediaReport(report: ManagedMediaExecutionReport): void {
  useRuntimeStore.getState().setState({ mediaReports: [...useRuntimeStore.getState().mediaReports, report] });
}

export function appendCueReport(report: CueExecutionReport): void {
  useRuntimeStore.getState().setState({ reports: [...useRuntimeStore.getState().reports, report] });
}

export function appendRetryActionReport(result: ActionExecutionResult, mode: LinkRunMode): void {
  appendCueReport({
    executionId: result.executionId,
    cueId: result.cueId,
    mode,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    results: [result]
  });
}
