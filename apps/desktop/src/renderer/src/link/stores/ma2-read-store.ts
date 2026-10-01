import { create } from 'zustand';
import { importMa2ProgramsCommand, matchMa2Programs, saveMa2ReadStateCommand } from '@tb/core/link';
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
  useDocumentStore.getState().markSaved(path, current.revision, documentId);
}

/** Component unmount is not a cancellation. The document owns results, this store owns the job. */
export async function scanMa2(source: Ma2CatalogRequest, retry = false): Promise<void> {
  if (useMa2ReadStore.getState().busy) return;
  const before = useDocumentStore.getState();
  if (!before.project) throw new Error('请先创建或打开联动工程');
  const cached = before.project.ma2ReadState;
  const sourceName = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
  const targets = retry && cached ? cached.catalog.directory.entries.filter(entry => {
    const read = cached.catalog.entries.find(value => value.target === entry.target);
    return !read || Boolean(read.error) || !read.preview;
  }).map(entry => entry.target) : undefined;
  if (targets && !targets.length) return;
  if (retry && cached?.source !== sourceName) throw new Error('来源控台已改变，请读取新目录');
  const progressId = crypto.randomUUID();
  useMa2ReadStore.setState({ busy: true, progress: null, activeId: progressId, message: '正在读取控台，切换页面后继续' });
  const unsubscribe = useDocumentStore.subscribe(state => {
    if (state.documentId !== before.documentId) void window.tbLink.cancelMa2Read(progressId).catch(error => useMa2ReadStore.setState({ message: String(error) }));
  });
  try {
    const read = ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ ...source, progressId, ...(targets ? { targets } : {}) }, progress => useMa2ReadStore.setState({ progress })));
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || !current.project) throw new Error('工程已切换，读取结果未写入其他工程');
    if (retry && cached && (cached.catalog.directory.show !== read.directory.show || cached.catalog.directory.generation !== read.directory.generation)) throw new Error('Show 或控台会话已改变，保留旧缓存，请读取新目录');
    const catalog = targets && cached ? { ...read, entries: read.directory.entries.flatMap(entry => {
      const value = read.entries.find(value => value.target === entry.target) ?? cached.catalog.entries.find(value => value.target === entry.target);
      return value ? [value] : [];
    }) } : read;
    const pairs = matchMa2Programs(current.project, catalog).pairs;
    const previous = current.project.ma2ReadState;
    const confirmed = previous?.source === sourceName && previous.catalog.directory.show === catalog.directory.show ? Object.fromEntries(Object.entries(previous.pairs).filter(([target, id]) => catalog.directory.entries.some(entry => entry.target === Number(target)) && current.project?.rundown.some(item => item.id === id))) : {};
    const message = `${catalog.entries.filter(entry => !entry.error).length} 条已读取 · ${catalog.entries.filter(entry => entry.error).length} 条读取异常${catalog.incomplete ? ' · 尚未完成' : ''}`;
    current.executeForDocument(before.documentId, saveMa2ReadStateCommand({ source: sourceName, catalog, pairs: { ...pairs, ...confirmed }, failures: retry && cached ? cached.failures : [], selectedTarget: previous?.selectedTarget ?? null, query: previous?.query ?? '', filter: previous?.filter ?? 'all', message }));
    await persist(before.documentId);
    useMa2ReadStore.setState({ message });
  } catch (error) { useMa2ReadStore.setState({ message: `读取未完成：${error instanceof Error ? error.message : String(error)}` }); throw error; }
  finally { unsubscribe(); useMa2ReadStore.setState({ busy: false, activeId: null, progress: null }); }
}

export async function importCachedMa2(target?: number): Promise<void> {
  const before = useDocumentStore.getState();
  const project = before.project; const state = project?.ma2ReadState;
  if (!project || !state) return;
  const pairs = Object.entries(state.pairs).filter(([number, id]) => id && (target === undefined || Number(number) === target) && !project.rundown.some(item => item.lighting?.ma2Bindings?.some(binding => binding.timecode === Number(number))));
  const result = await readMa2Programs(project, pairs, number => {
    const entry = state.catalog.entries.find(value => value.target === number);
    if (!entry?.preview || entry.error) throw new Error(entry?.error ?? entry?.conversionError ?? '此条尚未取得转换预览，请只补读未完成项');
    return Promise.resolve(entry.preview);
  }, () => { if (useDocumentStore.getState().project !== project || useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已变化，请重新应用缓存'); }, () => undefined);
  const message = `${result.selections.length} 条已关联 · ${result.selections.filter(value => value.preview.unconverted.length).length} 条原生保留 · ${result.failures.length} 条需处理`;
  const handled = new Set(pairs.map(([number]) => Number(number)));
  const cacheCommand = saveMa2ReadStateCommand({ ...state, failures: [...state.failures.filter(failure => !handled.has(failure.target)), ...result.failures], message });
  const importCommand = result.selections.length ? importMa2ProgramsCommand(result.selections) : null;
  before.executeForDocument(before.documentId, { ...cacheCommand, label: '关联缓存中的控台时间线', execute: value => cacheCommand.execute(importCommand ? importCommand.execute(value) : value) });
  await persist(before.documentId);
}
