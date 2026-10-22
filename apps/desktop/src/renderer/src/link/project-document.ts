import type { LinkProjectFile } from '@tb/core/link';
import { useDocumentStore } from './stores/document-store';
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
  saveTail = result;
  return result;
}

async function writeDocument(mode: 'save' | 'save-as'): Promise<SaveOutcome> {
  const state = useDocumentStore.getState();
  if (!state.project) return { status: 'failed', message: '工程保存失败：尚未打开工程' };
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
  if (useDocumentStore.getState().documentId !== documentId) return failed(new Error('保存期间已切换到其他工程，当前工程未保存'), true);
  useDocumentStore.getState().markSaved(saved, stateId, documentId);
  return { status: 'saved', path: saved };
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
  if (!path) throw new Error(`工程未保存：请先保存工程，再${action}`);
  return path;
}

/** Shows an opened file; a recovery copy with unsaved edits is offered first. */
export async function showOpenedProject(file: LinkProjectFile): Promise<string> {
  const restored = await linkDesktopViewModel.resolveRecoveryCopy({ version: 1, projectPath: file.path, projectId: file.project.projectId });
  useDocumentStore.getState().setProject(restored ?? file.project, file.path, { restored: restored !== null, upgraded: file.upgraded });
  const upgraded = useDocumentStore.getState().upgradeBackupPending;
  return [restored ? '已恢复未保存的改动' : '', upgraded ? '工程已按当前版本格式载入，尚未写回；第一次保存时会在原位置保留原文件 .bak' : ''].filter(Boolean).join('；');
}

/** At startup, before reopening the last file: an unnamed project's unsaved edits, if the operator restores them. */
export async function restoreUnnamedProject(): Promise<string | null> {
  const restored = await linkDesktopViewModel.resolveRecoveryCopy({ version: 1, projectPath: null });
  if (!restored) return null;
  useDocumentStore.getState().setProject(restored, null, { restored: true });
  return restored.name;
}
