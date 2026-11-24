import { readMa2Method } from './ma2-mode-store';
import { connectSavedMa2, useLocalMa2Store } from './ma2-connection-store';
import { ma2NetworkStatusSchema } from '@tb/schema';
import { create } from 'zustand';
import { isShowWait, saveMa2MaterialLibraryCommand, toUserErrorMessage } from '@tb/core/link';
import { ma2EffectLibrarySchema, type Ma2CatalogRequest, type Ma2EffectLibrary, type Ma2ReadProgress } from '@tb/schema';
import { ma2ReadCheckpoints } from './ma2-read-checkpoints';
import { useDocumentStore } from './document-store';
import { currentShowWait, useShowStateStore } from './show-state-store';
import { requireProjectLocation } from '../project-document';

export const useMa2MaterialReadStore = create<{ documentId: number | null; busy: boolean; waiting: boolean; activeId: string | null; progress: Ma2ReadProgress | null; error: string; message: string }>(() => ({ documentId: null, busy: false, waiting: false, activeId: null, progress: null, error: '', message: '' }));

type ReadJob = { documentId: number; source: string; result: Promise<void>; controller: AbortController };
let job: ReadJob | null = null;

export function cancelMaterialWait(): void {
  if (useMa2MaterialReadStore.getState().waiting) job?.controller.abort();
}

function waitUntilReadable(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { unsubscribe(); signal.removeEventListener('abort', finish); resolve(); };
    const unsubscribe = useShowStateStore.subscribe(() => { if (!currentShowWait('ma2.sync.read')) finish(); });
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted || !currentShowWait('ma2.sync.read')) finish();
  });
}

export function scanMa2Materials(source: Ma2CatalogRequest, retry = false): Promise<void> {
  const documentId = useDocumentStore.getState().documentId;
  const endpoint = JSON.stringify([source.network ?? null, source.dataDirectory]);
  if (job) return job.documentId === documentId && job.source === endpoint ? job.result : Promise.reject(new Error('正在读取其他工程或控台的素材'));
  const controller = new AbortController();
  const result = readWhenReady(source, retry, documentId, controller).finally(() => { job = null; });
  job = { documentId, source: endpoint, result, controller };
  return result;
}

async function readWhenReady(source: Ma2CatalogRequest, retry: boolean, documentId: number, controller: AbortController): Promise<void> {
  const changed = useDocumentStore.subscribe(state => { if (state.documentId !== documentId) controller.abort(); });
  const completed = new Set<number>();
  let immediateRetry = false;
  try {
    for (;;) {
      try { await readMaterialPass(source, retry, completed); return; }
      catch (cause) {
        if (!isShowWait(cause)) throw cause;
        const wait = currentShowWait('ma2.sync.read');
        if (!wait && immediateRetry) throw new Error('控台仍在等待节目停止，已保留读取结果。停下后可以补读剩余素材。');
        immediateRetry = !wait;
        useMa2MaterialReadStore.setState({ waiting: true, message: toUserErrorMessage(cause), error: '', progress: null });
        await waitUntilReadable(controller.signal);
        if (controller.signal.aborted) throw new Error('素材读取已取消');
      }
    }
  } catch (cause) {
    useMa2MaterialReadStore.setState({ error: controller.signal.aborted ? '' : toUserErrorMessage(cause), message: controller.signal.aborted ? '读取已取消' : '' });
    throw cause;
  } finally {
    changed();
    useMa2MaterialReadStore.setState({ busy: false, waiting: false, activeId: null, progress: null });
  }
}

async function readMaterialPass(source: Ma2CatalogRequest, retry: boolean, completed: Set<number>): Promise<void> {
  const before = useDocumentStore.getState();
  if (!before.project) throw new Error('请先打开联动工程');
  useMa2MaterialReadStore.setState({ documentId: before.documentId, busy: true, waiting: false, error: '', message: '', progress: null });
  let unsubscribe: (() => void) | undefined;
  let flush: (() => void) | undefined;
  try {
    // Read checkpoints are kept beside the project file; the library itself stays in memory.
    const path = await requireProjectLocation('读取控台素材');
    if (!path) throw new Error('没有选工程保存位置，这次没有读取素材');
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换');
    const sourceName = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
    const saved = before.project.ma2MaterialLibrary;
    const cached = saved?.library ? { source: saved.source, library: saved.library } : undefined;
    if (retry && cached?.source !== sourceName) throw new Error('控台换了，请重新读取目录');
    const targets = (retry || completed.size > 0) && cached ? cached.library.directory.entries.filter(entry =>
      !completed.has(entry.target) && (!retry || !cached.library.sequences.some(sequence => sequence.sequence === entry.target) || cached.library.errors.some(error => error.sequence === entry.target))
    ).map(entry => entry.target) : undefined;
    const progressId = crypto.randomUUID();
    useMa2MaterialReadStore.setState({ activeId: progressId });
    unsubscribe = useDocumentStore.subscribe(state => {
      if (state.documentId !== before.documentId) void window.tbLink.cancelMa2Read(progressId).catch(error => useMa2MaterialReadStore.setState({ error: toUserErrorMessage(error) }));
    });
    let partial: Ma2EffectLibrary | null = null;
    const publications = ma2ReadCheckpoints(() => {
      if (partial && useDocumentStore.getState().documentId === before.documentId) {
        useDocumentStore.getState().executeForDocument(before.documentId, saveMa2MaterialLibraryCommand(sourceName, partial, progressId));
      }
    });
    flush = publications.flush;
    const result = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...source, progressId, projectPath: path, projectId: before.project.projectId, ...(targets && cached ? { targets, expectedSource: { show: cached.library.directory.show, generation: cached.library.directory.generation, version: cached.library.directory.version } } : {}) }, update => {
      const current = useDocumentStore.getState();
      if (current.documentId !== before.documentId) return;
      useMa2MaterialReadStore.setState({ progress: update });
      if (update.checkpoint) {
        const { directory, readAt } = update.checkpoint;
        const same = cached?.source === sourceName && cached.library.directory.show === directory.show && cached.library.directory.generation === directory.generation;
        partial = { directory, readAt, sequences: same ? cached.library.sequences.filter(sequence => directory.entries.some(entry => entry.target === sequence.sequence)) : [], fixtureUsage: [], errors: [], fixtureDetails: 'unavailable', sourceUnverified: true, incomplete: '读取中，已读完的序列已保存，中断后可以接着读' };
      }
      if (!partial || !update.sequences?.length && !update.libraryError) return;
      const sequences = update.sequences ?? [];
      // Network directory reads checkpoint complete metadata. Local fixture details only arrive in the final result.
      if (source.network) for (const sequence of sequences) completed.add(sequence.sequence);
      const failed = update.libraryError;
      partial = { ...partial, sequences: [...partial.sequences.filter(sequence => !sequences.some(entry => entry.sequence === sequence.sequence) && sequence.sequence !== failed?.sequence), ...sequences], errors: [...partial.errors.filter(error => error.sequence !== failed?.sequence && !sequences.some(entry => entry.sequence === error.sequence)), ...failed ? [failed] : []] };
      publications.changed();
    }));
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换，素材没有写进别的工程');
    const library = targets && cached ? { ...result, sequences: [...cached.library.sequences.filter(sequence => !targets.includes(sequence.sequence) && result.directory.entries.some(entry => entry.target === sequence.sequence)), ...result.sequences] } : result;
    useDocumentStore.getState().executeForDocument(before.documentId, saveMa2MaterialLibraryCommand(sourceName, library, progressId));
    useMa2MaterialReadStore.setState({ message: library.sourceUnverified || library.incomplete ? `读取未完成：${library.incomplete || '来源还没确认'}；已读取 ${library.sequences.length} 个序列` : `读取完成 · ${library.sequences.length} 个序列 · ${library.sequences.reduce((count, sequence) => count + sequence.cues.length, 0)} 个 Cue · ${library.errors.length} 项失败` });
  } catch (error) { flush?.(); throw error; }
  finally { unsubscribe?.(); useMa2MaterialReadStore.setState({ activeId: null }); }
}

export async function ma2MaterialConnection(connectedOnly = false): Promise<Ma2CatalogRequest> {
  const method = readMa2Method();
  if (method === 'midi') throw new Error('当前是“仅 MIDI”模式，不读取控台灯光库');
  const local = useLocalMa2Store.getState();
  if (method === 'local' || (!method && local.status === 'ready')) {
    if (local.status !== 'ready') throw new Error('请先在设备设置里连接本机 onPC');
    return { dataDirectory: local.directory };
  }
  const network = ma2NetworkStatusSchema.parse(await (connectedOnly ? window.tbLink.getMa2NetworkStatus() : connectSavedMa2()));
  if (network.state !== 'connected' || !network.settings) throw new Error('请先在设备设置里连接 MA2 控台');
  const { host, port, monitorPort, username } = network.settings;
  return { dataDirectory: '', network: { host, port, monitorPort, username } };
}
