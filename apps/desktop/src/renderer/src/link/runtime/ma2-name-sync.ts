import { confirmMa2RenameCommand, isShowWait, ma2RenameKey, pendingMa2Renames, toConsoleLabel, toUserErrorMessage, type LinkCommand } from '@tb/core/link';
import { ma2CatalogSchema, ma2RenameResultSchema, type LinkProject, type Ma2Catalog, type Ma2CatalogRequest, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore, type NameSync } from '../stores/ma2-sync-store';
import { currentShowWait } from '../stores/show-state-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { archiveBeforeSync } from './ma2-sync-archive';
import { reportCoordinatorError } from './runtime-action-log';

/** What one pass over the renamed console objects needs. */
export type NameSyncPass = {
  connection: Ma2CatalogRequest;
  /** The project of the renamed objects' document, or null once another document is open. */
  project: () => LinkProject | null;
  current: () => boolean;
  catalog: (request: Ma2CatalogRequest) => Promise<Ma2Catalog>;
  rename: (request: Ma2RenameRequest) => Promise<Ma2RenameResult>;
  archive: () => Promise<void>;
  confirm: (command: LinkCommand) => void;
  writing: (message: string) => void;
};
/** `moved`: names recorded under the console's previous Show name or address, sent once the session check has moved the project there. */
export type NameSyncOutcome = { kind: 'confirmed'; sent: number; moved: number } | { kind: 'interrupted' };

export const MOVED_RENAMES = '控台换了 Show 名或地址，改名等核对完再发到控台';

/** Writes each renamed console object and confirms it by its read-back; a failure throws. */
export async function syncMa2Names(pass: NameSyncPass): Promise<NameSyncOutcome> {
  const renames = pendingMa2Renames(pass.project());
  if (!renames.length) return { kind: 'confirmed', sent: 0, moved: 0 };
  const catalog = ma2CatalogSchema.parse(await pass.catalog({ ...pass.connection, targets: [] }));
  if (!pass.current()) return { kind: 'interrupted' };
  const { directory } = catalog;
  const endpoint = pass.connection.network ? `${pass.connection.network.host}:${pass.connection.network.port}` : '本机 onPC';
  let archived = false;
  let sent = 0;
  let moved = 0;
  for (const change of renames) {
    if (!pass.current()) return { kind: 'interrupted' };
    if (change.endpoint !== endpoint || change.show !== directory.show) { moved += 1; continue; }
    const stillPending = (): boolean => pendingMa2Renames(pass.project()).some(value => ma2RenameKey(value) === ma2RenameKey(change) && value.name === change.name && value.confirmedName === change.confirmedName);
    if (!stillPending()) continue;
    if (!archived) { await pass.archive(); archived = true; }
    if (!pass.current()) return { kind: 'interrupted' };
    if (!stillPending()) continue;
    pass.writing(`正在同步名称：${change.name}`);
    const result = ma2RenameResultSchema.parse(await pass.rename({ ...pass.connection, change, generation: directory.generation }));
    if (result.name !== toConsoleLabel(change.name) || result.sequence !== change.sequence || result.kind !== change.kind || Number(result.cue) !== Number(change.cue) || result.show !== change.show || result.generation !== directory.generation) throw new Error('控台上的名称和要改的名称不一致，同步没有确认');
    if (!pass.project()) throw new Error('名称已写入控台，但工程已切换，请重新读取控台确认');
    pass.confirm(confirmMa2RenameCommand(change));
    sent += 1;
  }
  return { kind: 'confirmed', sent, moved };
}

function setNames(patch: Partial<NameSync>): void {
  useMa2SyncStore.setState(state => ({ names: { ...state.names, ...patch } }));
}

/**
 * One pass over the renamed objects of a document, with the store state and failure policy every
 * sync shares: the show (showGate's `ma2.sync.write`: only while the program moves, prepares or stops) and a lost
 * connection are waits; a failure stops until the next edit or
 * 刷新同步, because a rename is never retried on its own (project rule: no automatic retries).
 */
export async function runMa2NameSync(connection: Ma2CatalogRequest, documentId: number, current: () => boolean): Promise<void> {
  const project = (): LinkProject | null => { const state = useDocumentStore.getState(); return state.documentId === documentId ? state.project : null; };
  setNames({ state: 'syncing', message: '正在核对要同步的名称' });
  try {
    const outcome = await syncMa2Names({
      connection, project, current: () => current() && project() !== null && currentShowWait('ma2.sync.write') === null,
      catalog: request => window.tbLink.readMa2Catalog(request), rename: request => window.tbLink.renameMa2Object(request),
      archive: async () => { const value = project(); if (!value) throw new Error('工程已切换，名称同步已取消'); await archiveBeforeSync(documentId, value); },
      confirm: command => { const state = useDocumentStore.getState(); state.executeForDocument(documentId, command); state.markConsoleSynced(documentId); },
      writing: message => setNames({ writing: true, message })
    });
    const outstanding = pendingMa2Renames(project()).length;
    if (outcome.kind === 'interrupted') { setNames({ state: 'pending', writing: false, nextCheckAt: 0, message: currentShowWait('ma2.sync.write') ?? '同步状态有变化，稍后接着同步名称' }); return; }
    setNames({ state: outstanding ? 'pending' : 'verified', writing: false, blockedRevision: undefined, nextCheckAt: outcome.moved ? Date.now() + 1000 : 0,
      message: outcome.moved ? MOVED_RENAMES : outstanding ? '上一个名称已确认，继续同步后面的改名' : '名称已写入控台并回读确认' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    let disconnected = false;
    if (connection.network) {
      try { disconnected = (await window.tbLink.getMa2NetworkStatus()).state !== 'connected'; }
      catch (statusError) { reportCoordinatorError(`读取连接状态失败：${String(statusError)}`, reason => setNames({ message: reason })); }
    }
    // The main process refuses with showGate's own text when the window's mirror of the show was one change late.
    const showWait = currentShowWait('ma2.sync.write') ?? (isShowWait(cause) ? toUserErrorMessage(cause) : null);
    if (disconnected || showWait !== null) {
      setNames({ state: 'pending', writing: false, nextCheckAt: Date.now() + 1000, message: disconnected ? `等待连接恢复后继续同步名称：${message}` : showWait ?? '' });
      return;
    }
    setNames({ state: 'blocked', writing: false, blockedRevision: useDocumentStore.getState().revision,
      message: `名称同步失败，没有自动重试：${message}。新名称保留在工程里，处理好后点“刷新同步”` });
    reportCoordinatorError(message, reason => setNames({ message: reason }));
  }
}

/** The document a name sync belongs to; it throws once another document is open or this one cannot be synced. */
function namesDocument(documentId: number): () => ReturnType<typeof useDocumentStore.getState> {
  const current = (): ReturnType<typeof useDocumentStore.getState> => {
    const state = useDocumentStore.getState();
    if (state.documentId !== documentId) throw new Error('工程已切换，名称同步已取消');
    if (!state.project || !state.path) throw new Error('新名称已改到工程里，请先保存工程再同步');
    return state;
  };
  if (!current().project?.ma2MaterialLibrary?.library) throw new Error('新名称已改到工程里，请先读取控台素材再同步');
  return current;
}

async function writeNames(documentId: number, current: () => unknown): Promise<void> {
  const connection = await ma2MaterialConnection();
  current();
  if (useMa2SyncStore.getState().names.state === 'syncing') return;
  await runMa2NameSync(connection, documentId, () => useDocumentStore.getState().documentId === documentId);
}

export const MA2_NAMES_PAUSED = '实时同步已暂停，新名称先留在工程里；打开实时同步或点“同步名称”后写到控台';

/**
 * After a console object is renamed. On the network console the real-time pass writes the name with
 * the songs; while real-time sync is paused the name waits in the project like every other edit. The
 * local onPC has no real-time pass, so the name is written now.
 */
export async function requestMa2NameSync(documentId: number): Promise<void> {
  const current = namesDocument(documentId);
  if (useMa2SyncStore.getState().names.state === 'syncing') return;
  if (readMa2Method() === 'network') {
    const paused = !useMa2RealtimePreference.getState().enabled;
    setNames({ state: 'pending', blockedRevision: undefined, nextCheckAt: 0, message: paused ? MA2_NAMES_PAUSED : '等待把新名称写到控台' });
    return;
  }
  await writeNames(documentId, current);
}

/** 同步名称: the operator asks for the renamed objects to be written now, also while real-time sync is paused. */
export async function writeMa2NamesNow(documentId: number): Promise<void> {
  const current = namesDocument(documentId);
  if (useMa2SyncStore.getState().names.state === 'syncing') return;
  await writeNames(documentId, current);
}
