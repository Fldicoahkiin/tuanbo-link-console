import { actionResultLog, type ActionExecutionEvent } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export async function recordRuntimeOperator(projectId: string, item: RundownItem | undefined,
  message: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
  await linkDesktopViewModel.recordLog({ level: 'info', category: 'operator', message, projectId,
    ...(item ? { itemId: item.id } : {}), ...(details ? { details } : {}) });
}

export function reportCoordinatorError(message: string, onLogFailure: (message: string) => void): void {
  void linkDesktopViewModel.recordLog({ level: 'error', category: 'system', message }).catch((error: unknown) => {
    onLogFailure(`${message}；运行日志写入失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Only an action's result is logged, with how long it took and, when it failed or was skipped, why. */
export async function recordRuntimeAction(
  projectId: string,
  item: RundownItem | undefined,
  event: ActionExecutionEvent
): Promise<void> {
  const entry = actionResultLog(event);
  if (!entry) return;
  await linkDesktopViewModel.recordLog({
    ...entry,
    category: 'action',
    projectId,
    ...(item ? { itemId: item.id } : {}),
    cueId: event.cueId,
    actionId: event.actionId,
    executionId: event.executionId,
    device: event.kind.startsWith('obs.') ? 'obs' : 'midi'
  });
}
