import { useCallback, useEffect } from 'react';
import type { LinkProjectFile } from '@tb/core/link';
import type { LinkDocumentState } from '@tb/schema';
import { useDocumentStore, type DocumentStoreState } from './stores/document-store';
import { projectCodec } from './stores/project-codec';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';

export type SaveOutcome = { status: 'saved'; path: string } | { status: 'canceled' } | { status: 'failed'; message: string };

let saveTail: Promise<unknown> = Promise.resolve();

/**
 * The only writer of the project file. `save` writes to the current path (asking
 * for one if unnamed); `save-as` always asks. Only the saved state is marked
 * clean, so edits made while the save runs stay unsaved.
 */
export function saveDocument(mode: 'save' | 'save-as' = 'save'): Promise<SaveOutcome> {
  const result = saveTail.then(() => writeDocument(mode));
  // The caller owns the outcome; the settled tail only keeps saves in order.
  saveTail = result.then(() => undefined, () => undefined);
  return result;
}

async function writeDocument(mode: 'save' | 'save-as'): Promise<SaveOutcome> {
  const state = useDocumentStore.getState();
  if (!state.project) return { status: 'failed', message: '保存失败：还没有打开工程' };
  const { project, path, stateId, documentId, upgradeBackupPending } = state;
  let content: string;
  try { content = await projectCodec.encode(project); }
  catch (error) { return failed(error, true); }
  let saved: string | null;
  // The main process records a failed write with its path.
  const options = mode === 'save-as' ? path ? { defaultPath: path } : {}
    // The first save over a file upgraded in memory keeps the original beside it.
    : upgradeBackupPending && path ? { backupOriginal: true } : {};
  try { saved = await window.tbLink.saveProjectDocument(mode === 'save' ? path : null, content, options); }
  catch (error) { return failed(error, false); }
  if (saved === null) return { status: 'canceled' };
  if (useDocumentStore.getState().documentId !== documentId) return failed(new Error('保存过程中切换了工程，这次没有保存'), true);
  useDocumentStore.getState().markSaved(saved, stateId, documentId);
  return { status: 'saved', path: saved };
}

/**
 * A save that failed because a document worker (in this window or in the main process)
 * stopped responding can run once more, after the operator confirms restarting it.
 * It is never repeated automatically.
 */
export async function saveDocumentWithRecovery(mode: 'save' | 'save-as' = 'save'): Promise<SaveOutcome> {
  const outcome = await saveDocument(mode);
  if (outcome.status !== 'failed') return outcome;
  const local = projectCodec.failureReason();
  const remote = (await linkDesktopViewModel.projectDocumentWorkerState()).stalled;
  const reason = local ?? remote;
  if (!reason || !await linkDesktopViewModel.restartProjectDocumentWorker(reason)) return outcome;
  if (local) projectCodec.restart();
  return saveDocument(mode);
}

function failed(error: unknown, record: boolean): SaveOutcome {
  const message = `工程保存失败：${error instanceof Error ? error.message : String(error)}`;
  if (record) void linkDesktopViewModel.recordLog({ level: 'error', category: 'system', message }).catch((failure: unknown) => console.error('工程保存失败未能写入日志', failure));
  return { status: 'failed', message };
}

/**
 * Actions that copy files next to the project, or keep checkpoints beside it,
 * need a location. An unnamed project asks once (选择保存位置 / 取消) and is saved
 * there; null means the operator cancelled and the action must not run.
 */
export async function requireProjectLocation(purpose: string): Promise<string | null> {
  const state = useDocumentStore.getState();
  if (!state.project) throw new Error('请先创建或打开工程');
  if (state.path) return state.path;
  if (!await linkDesktopViewModel.confirmProjectLocation(purpose)) return null;
  const outcome = await saveDocument('save-as');
  if (outcome.status === 'failed') throw new Error(outcome.message);
  return outcome.status === 'saved' ? outcome.path : null;
}

/** Background work never opens a dialog; an unnamed project is reported as unsaved. */
export function requireSavedProjectPath(action: string): string {
  const path = useDocumentStore.getState().path;
  if (!path) throw new Error(`请先保存工程，再${action}`);
  return path;
}

/** 恢复到上次保存: after confirmation, drops every unsaved edit, the undo history and the recovery copy, and reopens the file. */
export async function revertToSaved(): Promise<'reverted' | 'cancelled'> {
  const state = useDocumentStore.getState();
  if (!state.project || !state.path) throw new Error('工程还没保存过，没有可以恢复的版本');
  const { path, documentId } = state, projectId = state.project.projectId;
  if (!await linkDesktopViewModel.confirmRevertToSaved({ name: state.project.name, consoleSynced: state.consoleSynced })) return 'cancelled';
  const file = await linkDesktopViewModel.openProject(path);
  if (useDocumentStore.getState().documentId !== documentId) throw new Error('工程已经切换，这次没有恢复');
  useDocumentStore.getState().setProject(file.project, file.path, { upgraded: file.upgraded });
  await linkDesktopViewModel.discardRecoveryCopy({ version: 1, projectPath: path, projectId });
  return 'reverted';
}

/** Shows an opened file; a recovery copy with unsaved edits is offered first. */
export async function showOpenedProject(file: LinkProjectFile): Promise<string> {
  const restored = await linkDesktopViewModel.resolveRecoveryCopy({ version: 1, projectPath: file.path, projectId: file.project.projectId });
  useDocumentStore.getState().setProject(restored ?? file.project, file.path, { restored: restored !== null, upgraded: file.upgraded });
  const upgraded = useDocumentStore.getState().upgradeBackupPending;
  return [restored ? '已恢复未保存的改动' : '', upgraded ? '这个工程来自旧版本，已按新格式打开。第一次保存时会在原位置留一份 .bak 备份' : ''].filter(Boolean).join('；');
}

/** At startup, before reopening the last file: an unnamed project's unsaved edits, if the operator restores them. */
export async function restoreUnnamedProject(): Promise<string | null> {
  const restored = await linkDesktopViewModel.resolveRecoveryCopy({ version: 1, projectPath: null });
  if (!restored) return null;
  useDocumentStore.getState().setProject(restored, null, { restored: true });
  return restored.name;
}

/** Tells the main process which document is open now. Requests it checks against
 * the open project send this first: the window's own report runs after child effects. */
export function reportDocumentState(): Promise<void> {
  return linkDesktopViewModel.setDocumentState(stateReport(useDocumentStore.getState()));
}

/** Reports the open document as soon as the store changes, synchronously, so the report reaches the
 * main process before any request a view's effect sends about the newly shown project. */
export function reportDocumentStateChanges(notify: (message: string, tone?: 'info' | 'error') => void): () => void {
  let last: LinkDocumentState | null = null;
  const report = (state: DocumentStoreState): void => {
    const next = stateReport(state);
    if (last && last.dirty === next.dirty && last.consoleSynced === next.consoleSynced && last.name === next.name
      && last.projectPath === next.projectPath && last.projectId === next.projectId) return;
    last = next;
    void linkDesktopViewModel.setDocumentState(next)
      .catch((error: unknown) => notify(`同步工程保存状态失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  };
  report(useDocumentStore.getState());
  return useDocumentStore.subscribe(report);
}

function stateReport(state: DocumentStoreState): LinkDocumentState {
  return { version: 1, dirty: state.dirty, consoleSynced: state.consoleSynced, name: state.project?.name ?? null,
    projectPath: state.path, projectId: state.project?.projectId ?? null };
}

/**
 * Keeps the main process's view of the open document current, and answers its
 * save requests (quit, reload, update) with the same save as Ctrl+S.
 */
export function useDocumentStateReport(notify: (message: string, tone?: 'info' | 'error') => void): void {
  useEffect(() => reportDocumentStateChanges(notify), [notify]);
  useEffect(() => linkDesktopViewModel.onSaveRequest(async () => {
    const outcome = await saveDocumentWithRecovery();
    return outcome.status === 'saved' ? { status: 'saved' as const } : outcome;
  }), []);
}

/**
 * Before the open document is replaced (open, new, restore an archive): the same
 * 保存 / 不保存 / 取消 question as quitting. Null means stay. Otherwise call the
 * returned function once the document was replaced: after 不保存 it removes the
 * replaced document's recovery copy.
 */
export async function confirmReplaceDocument(reason: 'open' | 'new' | 'restore-archive'): Promise<(() => Promise<void>) | null> {
  const state = useDocumentStore.getState();
  await linkDesktopViewModel.setDocumentState(stateReport(state));
  const decision = await linkDesktopViewModel.resolveUnsavedChanges(reason);
  if (decision === 'cancelled') return null;
  const project = state.project;
  if (decision !== 'discarded' || !project) return () => Promise.resolve();
  return async () => { await linkDesktopViewModel.discardRecoveryCopy({ version: 1, projectPath: state.path, projectId: project.projectId }); };
}

/** Save, Save As and 恢复到上次保存 for the toolbar and the shortcuts, each reporting its outcome. */
export function useDocumentCommands(notify: (message: string, tone?: 'info' | 'error') => void): { save: () => Promise<void>; saveAs: () => Promise<void>; revert: () => Promise<void> } {
  const run = useCallback(async (mode: 'save' | 'save-as'): Promise<void> => {
    if (!useDocumentStore.getState().project) return;
    const outcome = await saveDocumentWithRecovery(mode);
    if (outcome.status === 'saved') notify(mode === 'save' ? '工程已保存' : `已另存为：${outcome.path}`);
    else if (outcome.status === 'failed') notify(outcome.message, 'error');
  }, [notify]);
  const save = useCallback(() => run('save'), [run]);
  const saveAs = useCallback(() => run('save-as'), [run]);
  const revert = useCallback(async (): Promise<void> => {
    try { if (await revertToSaved() === 'reverted') notify('已恢复到上次保存'); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  }, [notify]);
  return { save, saveAs, revert };
}
