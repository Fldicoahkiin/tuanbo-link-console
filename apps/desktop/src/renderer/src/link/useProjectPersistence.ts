import { useEffect } from 'react';
import { useDocumentStore } from './stores/document-store';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { isProjectReopenSuspended } from './stores/project-recovery';
import { restoreUnnamedProject, showOpenedProject } from './project-document';

// Once per renderer: React's development double effects must not ask about recovery twice.
let startup: Promise<void> | null = null;

export function useProjectPersistence(notify: (message: string, tone?: 'info' | 'error') => void): void {
  useEffect(() => {
    startup ??= openStartupDocument(notify);
  }, [notify]);
}

/** An unnamed project's unsaved edits come first; otherwise the last project file reopens, with its own recovery offer. */
async function openStartupDocument(notify: (message: string, tone?: 'info' | 'error') => void): Promise<void> {
  try {
    const restored = await restoreUnnamedProject();
    if (restored !== null) { notify(`已恢复未保存的未命名工程：${restored}`); return; }
  } catch (error) {
    notify(`检查未保存的未命名工程失败：${toMessage(error)}`, 'error');
  }
  // The main process records the last project itself; it only reopens a path it recorded or approved.
  let lastPath: string | null;
  try {
    lastPath = await linkDesktopViewModel.lastProjectPath();
    if (lastPath && isProjectReopenSuspended(lastPath)) {
      notify(`上次的工程打开后显示异常，这次没有自动打开。工程文件还在原位置，可通过“打开工程”重新选择：${lastPath}`, 'error');
      return;
    }
  } catch (error) {
    notify(`读取上次工程路径失败：${toMessage(error)}`, 'error');
    return;
  }
  if (!lastPath) return;
  try {
    const result = await linkDesktopViewModel.openProject(lastPath);
    if (useDocumentStore.getState().project) return;
    const detail = await showOpenedProject(result);
    notify(`已恢复上次工程：${result.project.name}${detail ? `；${detail}` : ''}`);
  } catch (error) {
    notify(`恢复上次的工程失败：${toMessage(error)}`, 'error');
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
