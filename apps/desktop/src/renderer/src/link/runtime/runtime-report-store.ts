import type { ActionExecutionResult, CueExecutionReport, LinkRunMode } from '@tb/core/link';
import { useRuntimeStore, type ManagedMediaExecutionReport } from '../stores/runtime-store';

// Full action evidence has already been persisted by the runner. This store is
// only the recent operator view, never the source of execution/deduplication.
const MAX_RECENT_REPORTS = 256;
const MAX_RECENT_ACTIONS = 2048;

export function appendMediaReport(report: ManagedMediaExecutionReport): void {
  useRuntimeStore.getState().setState({ mediaReports: [...useRuntimeStore.getState().mediaReports.slice(-(MAX_RECENT_REPORTS - 1)), report] });
}

export function appendCueReport(report: CueExecutionReport): void {
  const recent = report.results.length > MAX_RECENT_ACTIONS ? { ...report, results: report.results.slice(-MAX_RECENT_ACTIONS) } : report;
  const reports = [...useRuntimeStore.getState().reports.slice(-(MAX_RECENT_REPORTS - 1)), recent];
  let actions = recent.results.length, first = reports.length - 1;
  while (first > 0 && actions + reports[first - 1]!.results.length <= MAX_RECENT_ACTIONS) { actions += reports[--first]!.results.length; }
  useRuntimeStore.getState().setState({ reports: reports.slice(first) });
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
