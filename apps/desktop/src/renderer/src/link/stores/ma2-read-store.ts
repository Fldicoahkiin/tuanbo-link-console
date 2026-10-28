import { create } from 'zustand';
import { importMa2ProgramsCommand, ma2SongPairs, reconcileMa2ReadState, saveMa2ReadStateCommand } from '@tb/core/link';
import { ma2CatalogSchema, type Ma2CatalogRequest, type Ma2ReadProgress, type Ma2ReadState } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { readMa2Programs, type Ma2ImportFailure } from '../view-models/read-ma2-programs';
import { requireProjectLocation } from '../project-document';

export const useMa2ReadStore = create<{ busy: boolean; progress: Ma2ReadProgress | null; activeId: string | null; message: string; openWorkspace: boolean; browserOpen: boolean }>(() => ({ busy: false, progress: null, activeId: null, message: '', openWorkspace: false, browserOpen: false }));

export function updateMa2ReadState(patch: Partial<Ma2ReadState>): void {
  const document = useDocumentStore.getState();
  if (!document.project?.ma2ReadState) return;
  document.execute(saveMa2ReadStateCommand({ ...document.project.ma2ReadState, ...patch }));
}

/** Component unmount is not a cancellation. The document owns results, this store owns the job. */
export async function scanMa2(source: Ma2CatalogRequest, retry = false): Promise<void> {
  if (useMa2ReadStore.getState().busy) return;
  useMa2ReadStore.setState({ busy: true, message: '正在准备读取' });
  try { await runScan(source, retry); }
  catch (error) { useMa2ReadStore.setState({ message: `读取未完成：${error instanceof Error ? error.message : String(error)}` }); throw error; }
  finally { useMa2ReadStore.setState({ busy: false, activeId: null, progress: null }); }
}

async function runScan(source: Ma2CatalogRequest, retry: boolean): Promise<void> {
  const opened = useDocumentStore.getState();
  if (!opened.project) throw new Error('请先创建或打开联动工程');
  // Read checkpoints are kept beside the project file; the edits themselves stay in memory.
  if (!await requireProjectLocation('读取控台')) throw new Error('没有选工程保存位置，这次没有开始读取');
  const before = useDocumentStore.getState();
  if (before.documentId !== opened.documentId) throw new Error('选择保存位置时工程已切换');
  if (!before.project || !before.path) throw new Error('工程尚无保存位置');
  const cached = before.project.ma2ReadState;
  const sourceName = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
  const targets = retry && cached ? cached.catalog.directory.entries.filter(entry => {
    const read = cached.catalog.entries.find(value => value.target === entry.target);
    return !read || Boolean(read.error) || !read.preview;
  }).map(entry => entry.target) : undefined;
  if (targets && !targets.length && !cached?.catalog.sourceUnverified) { useMa2ReadStore.setState({ message: '没有要补读的内容，可以直接使用工程里保存的结果' }); return; }
  if (retry && cached?.source !== sourceName) throw new Error('控台换了，请重新读取目录');
  const progressId = crypto.randomUUID();
  useMa2ReadStore.setState({ busy: true, progress: null, activeId: progressId, message: '正在读取控台，切换页面不会中断' });
  const unsubscribe = useDocumentStore.subscribe(state => {
    if (state.documentId !== before.documentId) void window.tbLink.cancelMa2Read(progressId).catch(error => useMa2ReadStore.setState({ message: String(error) }));
  });
  try {
    const read = ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ ...source, progressId, projectPath: before.path, projectId: before.project.projectId, ...(targets && cached ? { targets, expectedSource: { show: cached.catalog.directory.show, generation: cached.catalog.directory.generation, version: cached.catalog.directory.version } } : {}) }, progress => {
      useMa2ReadStore.setState({ progress });
      const checkpoint = progress.checkpoint;
      const current = useDocumentStore.getState();
      if (!checkpoint?.entry || current.documentId !== before.documentId || !current.project) return;
      const old = current.project.ma2ReadState;
      const same = old?.source === sourceName && old.catalog.directory.show === checkpoint.directory.show && old.catalog.directory.generation === checkpoint.directory.generation;
      const entries = same ? old.catalog.entries.filter(entry => entry.target !== checkpoint.entry!.target && checkpoint.directory.entries.some(value => value.target === entry.target)) : [];
      const catalog = { directory: checkpoint.directory, readAt: checkpoint.readAt, entries: [...entries, checkpoint.entry], incomplete: '读取中，已读完的条目已保存，中断后可以接着读', sourceUnverified: false };
      current.executeForDocument(before.documentId, saveMa2ReadStateCommand(reconcileMa2ReadState(current.project, sourceName, catalog), progressId));
    }));
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || !current.project) throw new Error('工程已切换，读取结果没有写进别的工程');
    if (retry && cached && (cached.catalog.directory.show !== read.directory.show || cached.catalog.directory.generation !== read.directory.generation)) throw new Error('控台或 Show 换了，之前读取的结果仍保留，请重新读取目录');
    const catalog = targets && cached ? { ...read, entries: read.directory.entries.flatMap(entry => {
      const value = read.entries.find(value => value.target === entry.target) ?? cached.catalog.entries.find(value => value.target === entry.target);
      return value ? [value] : [];
    }) } : read;
    const state = reconcileMa2ReadState(current.project, sourceName, catalog);
    const message = state.message;
    current.executeForDocument(before.documentId, saveMa2ReadStateCommand(state, progressId));
    useMa2ReadStore.setState({ message });
  } catch (error) { useMa2ReadStore.setState({ message: `读取未完成：${error instanceof Error ? error.message : String(error)}` }); throw error; }
  finally { unsubscribe(); useMa2ReadStore.setState({ busy: false, activeId: null, progress: null }); }
}

/**
 * Puts the Cues of the console Timecode shows that start where a song starts on those songs' timelines
 * (2026-10-26: by the MTC start alone, nothing to confirm). With `target`, only that show. A show already
 * on a song, or one whose read is incomplete, is left as it is; why a show could not go in is kept with it.
 */
export async function importCachedMa2(target?: number): Promise<{ imported: string[]; failures: Ma2ImportFailure[] }> {
  const before = useDocumentStore.getState();
  const project = before.project; const state = project?.ma2ReadState;
  if (!project || !state) return { imported: [], failures: [] };
  if (useMa2ReadStore.getState().busy) throw new Error('还在读取中，读完或取消后才能把 Cue 放进歌曲');
  if (state.catalog.sourceUnverified || state.catalog.incomplete && state.catalog.sourceUnverified === undefined) throw new Error('控台目录还没确认，已读的内容可以查看；读完整后才能放进歌曲');
  const bound = (number: number): boolean => project.rundown.some(item => item.lighting?.ma2Bindings?.some(binding => binding.timecode === number));
  const pairs = Object.entries(ma2SongPairs(project).pairs).filter(([number]) => (target === undefined || Number(number) === target) && !bound(Number(number)));
  const result = await readMa2Programs(project, pairs, number => {
    const entry = state.catalog.entries.find(value => value.target === number);
    const pairedItem = pairs.find(([key]) => Number(key) === number)?.[1];
    if (state.detachedBindings?.some(value => value.itemId === pairedItem && value.binding.timecode === number)) throw new Error('这首歌有已归档的本地修改，请先“恢复归档关联”');
    if (!entry?.preview || entry.error) throw new Error(entry?.error ?? entry?.conversionError ?? '这一条还没读取完整，请用“只补读未完成项”');
    return Promise.resolve(entry.preview);
  }, () => { if (useDocumentStore.getState().project !== project || useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程变了，请重新应用读取结果'); }, () => undefined);
  const message = `${result.selections.length} 条已放进歌曲 · ${result.selections.filter(value => value.preview.unconverted.length).length} 条含控台原样动作 · ${result.failures.length} 条需处理`;
  const handled = new Set(pairs.map(([number]) => Number(number)));
  const cacheCommand = saveMa2ReadStateCommand({ ...state, failures: [...state.failures.filter(failure => !handled.has(failure.target)), ...result.failures], message });
  const importCommand = result.selections.length ? importMa2ProgramsCommand(result.selections) : null;
  if (useDocumentStore.getState().project !== project) throw new Error('工程变了，请重新放进歌曲');
  before.executeForDocument(before.documentId, { ...cacheCommand, label: '把对上的控台时间线放进歌曲', execute: value => cacheCommand.execute(importCommand ? importCommand.execute(value) : value) });
  return { imported: result.selections.map(selection => selection.itemId), failures: result.failures };
}
