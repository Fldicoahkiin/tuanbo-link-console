import type { ActionExecutionEvent } from '@tb/core/link';
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

export async function recordRuntimeAction(
  projectId: string,
  item: RundownItem | undefined,
  event: ActionExecutionEvent
): Promise<void> {
  await linkDesktopViewModel.recordLog({
    level: event.status === 'failed' ? 'error' : event.status === 'skipped' ? 'warning' : 'info',
    category: 'action',
    message: `${event.label} · ${event.status}`,
    projectId,
    ...(item ? { itemId: item.id } : {}),
    cueId: event.cueId,
    actionId: event.actionId,
    executionId: event.executionId,
    device: event.kind.startsWith('obs.') ? 'obs' : 'midi',
    result: event.status,
    ...(event.error ? { details: { error: event.error, at: event.at } } : { details: { at: event.at } })
  });
}
