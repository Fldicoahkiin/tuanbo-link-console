import type { RuntimeUpdate } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export function applyRuntimeState(input: {
  project: LinkProject;
  item: RundownItem | undefined;
  update: RuntimeUpdate;
  nextCueId: string | null;
}): void {
  const previous = useRuntimeStore.getState();
  useRuntimeStore.getState().setState({
    state: input.update.state,
    manualTakeover: input.update.manualTakeover,
    missedCueIds: input.update.missedCueIds,
    nextCueId: input.nextCueId,
    reason: input.update.reason ?? ((input.update.state === 'error' || input.update.state === 'timecodeLost') && previous.state === input.update.state
      ? previous.reason
      : null)
  });
  if (previous.state === input.update.state) return;
  void linkDesktopViewModel.recordLog({
    level: input.update.state === 'error' || input.update.state === 'timecodeLost' ? 'error' : 'info',
    category: 'state',
    message: `${previous.state} → ${input.update.state}`,
    projectId: input.project.projectId,
    ...(input.item ? { itemId: input.item.id } : {}),
    details: {
      previousState: previous.state,
      nextState: input.update.state,
      reason: input.update.reason ?? '状态机事件'
    }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    useRuntimeStore.getState().setState({ state: 'error', reason: `运行状态日志写入失败：${message}` });
  });
}
export function resetRuntimeExecutionView(): void {
  useRuntimeStore.getState().setState({ timecode: null, detectedFrameRate: null, mtcStable: false,
    lastMtcAt: null, reports: [], mediaReports: [], currentCueId: null });
}
