import { create } from 'zustand';
import { confirmMa2PairingCommand, importMa2ProgramsCommand, reconcileMa2ReadState, saveMa2ReadStateCommand } from '@tb/core/link';
import { ma2CatalogSchema, type Ma2CatalogRequest, type Ma2ReadProgress, type Ma2ReadState } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { readMa2Programs } from '../view-models/read-ma2-programs';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export const useMa2ReadStore = create<{ busy: boolean; progress: Ma2ReadProgress | null; activeId: string | null; message: string; openWorkspace: boolean; browserOpen: boolean }>(() => ({ busy: false, progress: null, activeId: null, message: '', openWorkspace: false, browserOpen: false }));

export function updateMa2ReadState(patch: Partial<Ma2ReadState>): void {
  const document = useDocumentStore.getState();
  if (!document.project?.ma2ReadState) return;
  document.execute(saveMa2ReadStateCommand({ ...document.project.ma2ReadState, ...patch }));
}

async function persist(documentId: number): Promise<void> {
  const current = useDocumentStore.getState();
  if (current.documentId !== documentId || !current.project || !current.path) return;
  const path = await linkDesktopViewModel.saveProject(current.path, current.project);
  if (!path) throw new Error('控台缓存已加入工程，但保存未完成');
  useDocumentStore.getState().markSaved(path, current.stateId, documentId);
}

/** Component unmount is not a cancellation. The document owns results, this store owns the job. */
export async function scanMa2(source: Ma2CatalogRequest, retry = false): Promise<void> {
  if (useMa2ReadStore.getState().busy) return;
  useMa2ReadStore.setState({ busy: true, message: '正在保存工程并准备读取' });
  try { await runScan(source, retry); }
  catch (error) { useMa2ReadStore.setState({ message: `读取未完成：${error instanceof Error ? error.message : String(error)}` }); throw error; }
  finally { useMa2ReadStore.setState({ busy: false, activeId: null, progress: null }); }
}

async function runScan(source: Ma2CatalogRequest, retry: boolean): Promise<void> {
  let before = useDocumentStore.getState();
  if (!before.project) throw new Error('请先创建或打开联动工程');
  {
    const savedPath = await linkDesktopViewModel.saveProject(before.path, before.project);
    if (!savedPath) throw new Error('请先保存联动工程，再读取控台；本次尚未开始扫描');
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('保存期间工程已切换');
    useDocumentStore.getState().markSaved(savedPath, before.stateId, before.documentId);
    before = useDocumentStore.getState();
  }
  if (!before.project || !before.path) throw new Error('工程保存未完成');
  const cached = before.project.ma2ReadState;
  const sourceName = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
  const targets = retry && cached ? cached.catalog.directory.entries.filter(entry => {
    const read = cached.catalog.entries.find(value => value.target === entry.target);
    return !read || Boolean(read.error) || !read.preview;
  }).map(entry => entry.target) : undefined;
  if (targets && !targets.length && !cached?.catalog.sourceUnverified) { useMa2ReadStore.setState({ message: '没有未完成的读取项，可直接使用工程缓存' }); return; }
  if (retry && cached?.source !== sourceName) throw new Error('来源控台已改变，请读取新目录');
  const progressId = crypto.randomUUID();
  useMa2ReadStore.setState({ busy: true, progress: null, activeId: progressId, message: '正在读取控台，切换页面后继续' });
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
      const catalog = { directory: checkpoint.directory, readAt: checkpoint.readAt, entries: [...entries, checkpoint.entry], incomplete: '读取中，已完成条目已保存恢复检查点', sourceUnverified: false };
      current.executeForDocument(before.documentId, saveMa2ReadStateCommand(reconcileMa2ReadState(current.project, sourceName, catalog), progressId));
    }));
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || !current.project) throw new Error('工程已切换，读取结果未写入其他工程');
    if (retry && cached && (cached.catalog.directory.show !== read.directory.show || cached.catalog.directory.generation !== read.directory.generation)) throw new Error('Show 或控台会话已改变，保留旧缓存，请读取新目录');
    const catalog = targets && cached ? { ...read, entries: read.directory.entries.flatMap(entry => {
      const value = read.entries.find(value => value.target === entry.target) ?? cached.catalog.entries.find(value => value.target === entry.target);
      return value ? [value] : [];
    }) } : read;
    const state = reconcileMa2ReadState(current.project, sourceName, catalog);
    const message = state.message;
    current.executeForDocument(before.documentId, saveMa2ReadStateCommand(state, progressId));
    await persist(before.documentId);
    useMa2ReadStore.setState({ message });
  } catch (error) { useMa2ReadStore.setState({ message: `读取未完成：${error instanceof Error ? error.message : String(error)}` }); throw error; }
  finally { unsubscribe(); useMa2ReadStore.setState({ busy: false, activeId: null, progress: null }); }
}

export async function importCachedMa2(target?: number): Promise<void> {
  const before = useDocumentStore.getState();
  const project = before.project; const state = project?.ma2ReadState;
  if (!project || !state) return;
  if (useMa2ReadStore.getState().busy) throw new Error('读取尚在进行，完成或取消后可关联已读条目');
  if (state.catalog.sourceUnverified || state.catalog.incomplete && state.catalog.sourceUnverified === undefined) throw new Error('目录来源尚未核对，已读内容可查看；请核对来源后关联');
  const pairs = Object.entries(state.pairs).filter(([number, id]) => id && state.pairings?.[number]?.status !== 'stale' && (target === undefined || Number(number) === target) && !project.rundown.some(item => item.lighting?.ma2Bindings?.some(binding => binding.timecode === Number(number))));
  const result = await readMa2Programs(project, pairs, number => {
    const entry = state.catalog.entries.find(value => value.target === number);
    if (state.detachedBindings?.some(value => value.itemId === pairs.find(([key]) => Number(key) === number)?.[1] && value.binding.timecode === number)) throw new Error('此歌曲有已归档的本地修改，请先恢复归档关联');
    if (!entry?.preview || entry.error) throw new Error(entry?.error ?? entry?.conversionError ?? '此条尚未取得转换预览，请只补读未完成项');
    // Validate inside the per-entry read operation so one bad cached pairing is
    // recorded with its Timecode instead of rolling back all usable selections.
    const itemId = state.pairs[number];
    if (!itemId) throw new Error(`Timecode ${number} 尚未选择对应歌曲`);
    confirmMa2PairingCommand(number, itemId).execute(project);
    return Promise.resolve(entry.preview);
  }, () => { if (useDocumentStore.getState().project !== project || useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已变化，请重新应用缓存'); }, () => undefined);
  const message = `${result.selections.length} 条已关联 · ${result.selections.filter(value => value.preview.unconverted.length).length} 条原生保留 · ${result.failures.length} 条需处理`;
  const handled = new Set(pairs.map(([number]) => Number(number)));
  const cacheCommand = saveMa2ReadStateCommand({ ...state, failures: [...state.failures.filter(failure => !handled.has(failure.target)), ...result.failures], message });
  const importCommand = result.selections.length ? importMa2ProgramsCommand(result.selections) : null;
  before.executeForDocument(before.documentId, { ...cacheCommand, label: '关联缓存中的控台时间线', execute: value => {
    let next = cacheCommand.execute(importCommand ? importCommand.execute(value) : value);
    for (const selection of result.selections) next = confirmMa2PairingCommand(selection.preview.target, selection.itemId).execute(next);
    return next;
  } });
  await persist(before.documentId);
}
