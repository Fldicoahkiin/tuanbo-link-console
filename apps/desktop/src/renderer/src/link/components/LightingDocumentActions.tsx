import { useRef, useState } from 'react';
import { FolderArchive, FolderOpen, Save } from 'lucide-react';
import type { ProjectArchiveResult } from '@tb/schema';
import { Button, Dialog } from '../ui';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
import { confirmReplaceDocument, saveDocument } from '../project-document';
import { useDocumentStore } from '../stores/document-store';
import { currentShowWait, useShowGate } from '../stores/show-state-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

async function revealArchives(name?: string): Promise<void> {
  const path = useDocumentStore.getState().path;
  if (!path) throw new Error('请先保存工程');
  await linkDesktopViewModel.projectArchives({ version: 1, action: 'reveal', projectPath: path, ...(name ? { name } : {}) });
}

/** 第 3 题 (S3b): the sync waits only while the program moves, prepares or stops; restoring an archive replaces the
 * project, which waits until the show has stopped. Both say why in showGate's own words. */
async function saveLightingProject(notify: (text: string) => void): Promise<void> {
  const state = useDocumentStore.getState();
  if (!state.project) return;
  const outcome = await saveDocument();
  if (outcome.status === 'failed') throw new Error(outcome.message);
  if (outcome.status === 'canceled') return;
  const archived = await archiveMa2Project(state.documentId, state.project, 'manual');
  if (!archived) throw new Error('工程已保存，手动存档未创建');
  notify('工程已保存并创建存档');
}

async function lightingArchives(): Promise<ProjectArchiveResult['entries']> {
  const path = useDocumentStore.getState().path;
  if (!path) throw new Error('请先保存工程');
  return (await linkDesktopViewModel.projectArchives({ version: 1, action: 'list', projectPath: path })).entries;
}
async function restoreLightingArchive(name: string): Promise<boolean> {
  const state = useDocumentStore.getState(), wait = currentShowWait('document.replace');
  if (wait !== null || !state.path || !state.project) throw new Error(wait ?? '请先保存工程');
  // 保存 puts the latest edits into the "恢复前" archive the restore makes; 不保存 drops them.
  const replaced = await confirmReplaceDocument('restore-archive');
  if (!replaced) return false;
  const projectPath = useDocumentStore.getState().path;
  if (!projectPath) throw new Error('请先保存工程');
  await linkDesktopViewModel.projectArchives({ version: 1, action: 'restore', projectPath, name });
  const reopened = await linkDesktopViewModel.openProject(projectPath);
  useDocumentStore.getState().setProject(reopened.project, reopened.path, { upgraded: reopened.upgraded });
  await replaced();
  return true;
}

export function LightingDocumentActions({ disabled, notify }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const replaceGate = useShowGate('document.replace');
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const [archives, setArchives] = useState<ProjectArchiveResult['entries']>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const save = () => saveLightingProject(notify);
  const loadArchives = async (): Promise<void> => {
    setArchives(await lightingArchives()); setConfirmRestore(null); setArchiveOpen(true);
  };
  const restore = async (name: string): Promise<void> => {
    if (!await restoreLightingArchive(name)) return;
    setConfirmRestore(null); setArchiveOpen(false); notify('已恢复存档；恢复前的工程另存为“恢复前”存档');
  };
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (guard.current) return;
    guard.current = true; setBusy(true);
    try { await action(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { guard.current = false; setBusy(false); }
  };
  return <>
    <Button variant="secondary" size="sm" icon={Save} disabled={disabled || busy} aria-label="保存工程" title="保存工程并创建存档" onClick={() => void run(save)}>保存</Button>
    <Button variant="ghost" size="sm" icon={FolderArchive} disabled={disabled || busy} title="查看和恢复存档" onClick={() => void run(loadArchives)}>存档</Button>
    {archiveOpen ? <Dialog title="灯光工程存档" description="保存整个工程和原始 XML，同步前会自动存一份。恢复时写回原工程位置，恢复前的工程也会另存一份。" onClose={() => setArchiveOpen(false)}
      actions={<Button variant="secondary" icon={FolderOpen} onClick={() => void run(() => revealArchives())}>打开存档位置</Button>}>
      {!archives.length ? <p>还没有存档，点“保存”创建。</p> : <ul className="lighting-sync-archives">{archives.slice(0, 100).map(entry => <li key={entry.name}>
        <span>{new Date(entry.createdAt).toLocaleString()} · {entry.reason === 'manual' ? '手动保存' : '同步前'}</span>
        <Button variant="ghost" size="sm" aria-label={`定位存档 ${entry.name}`} onClick={() => void run(() => revealArchives(entry.name))}>定位文件</Button>
        {confirmRestore === entry.name
          ? <Button variant="danger" size="sm" aria-label={`确认恢复存档 ${entry.name}`} disabled={busy || replaceGate.kind === 'wait'} onClick={() => void run(() => restore(entry.name))}>确认恢复</Button>
          : <Button variant="secondary" size="sm" aria-label={`恢复存档 ${entry.name}`} disabled={busy || replaceGate.kind === 'wait'} onClick={() => setConfirmRestore(entry.name)}>恢复</Button>}
      </li>)}</ul>}
    </Dialog> : null}
  </>;
}
