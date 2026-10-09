import { useEffect, useRef } from 'react';
import { useDocumentStore } from './stores/document-store';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { isProjectReopenSuspended } from './stores/project-recovery';

const LAST_PROJECT_PATH_KEY = 'tblink.last-project-path.v1';

export function useProjectPersistence(notify: (message: string, tone?: 'info' | 'error') => void): void {
  const project = useDocumentStore((state) => state.project);
  const path = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
  const revision = useDocumentStore((state) => state.revision);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let lastPath: string | null;
    try {
      lastPath = localStorage.getItem(LAST_PROJECT_PATH_KEY);
      if (lastPath && isProjectReopenSuspended(lastPath)) {
        notify(`上次工程显示异常，已暂停自动打开。工程文件保留在原位置，可通过“打开工程”重新选择：${lastPath}`, 'error');
        return;
      }
    } catch (error) {
      notify(`读取上次工程路径失败：${toMessage(error)}`, 'error');
      return;
    }
    if (!lastPath) return;
    void linkDesktopViewModel.openProject(lastPath).then((result) => {
      if (cancelled || useDocumentStore.getState().project) return;
      useDocumentStore.getState().setProject(result.project, result.path);
      notify(`已恢复上次工程：${result.project.name}`);
    }).catch((error: unknown) => {
      if (!cancelled) notify(`上次工程恢复失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    });
    return () => { cancelled = true; };
  }, [notify]);

  useEffect(() => {
    if (!path) return;
    try {
      localStorage.setItem(LAST_PROJECT_PATH_KEY, path);
    } catch (error) {
      notify(`保存上次工程路径失败：${toMessage(error)}`, 'error');
    }
  }, [notify, path]);

  useEffect(() => {
    if (!dirty || !project || !path) return;
    const timer = window.setTimeout(() => {
      saveChainRef.current = saveChainRef.current.then(async () => {
        const document = useDocumentStore.getState();
        if (!document.dirty || !document.project || !document.path) return;
        const savingRevision = document.revision;
        const savingDocumentId = document.documentId;
        const savedPath = await linkDesktopViewModel.saveProject(document.path, document.project);
        if (!savedPath) throw new Error('自动保存未返回工程路径');
        useDocumentStore.getState().markSaved(savedPath, savingRevision, savingDocumentId);
      }).catch((error: unknown) => {
        notify(`工程自动保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [dirty, notify, path, project, revision]);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
