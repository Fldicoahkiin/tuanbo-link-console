import { create } from 'zustand';
import { saveMa2MaterialLibraryCommand, toUserErrorMessage } from '@tb/core/link';
import { ma2EffectLibrarySchema, type Ma2CatalogRequest, type Ma2EffectLibrary, type Ma2ReadProgress } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export const useMa2MaterialReadStore = create<{ documentId: number | null; busy: boolean; activeId: string | null; progress: Ma2ReadProgress | null; error: string }>(() => ({ documentId: null, busy: false, activeId: null, progress: null, error: '' }));

export async function scanMa2Materials(source: Ma2CatalogRequest, retry = false): Promise<void> {
  if (useMa2MaterialReadStore.getState().busy) return;
  const before = useDocumentStore.getState();
  if (!before.project) throw new Error('请先打开联动工程');
  useMa2MaterialReadStore.setState({ documentId: before.documentId, busy: true, error: '', progress: null });
  let unsubscribe: (() => void) | undefined;
  try {
    const path = await linkDesktopViewModel.saveProject(before.path, before.project);
    if (!path) throw new Error('请先保存工程，再读取素材；本次尚未扫描');
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换');
    before.markSaved(path, before.revision, before.documentId);
    const sourceName = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
    const cached = before.project.ma2MaterialLibrary;
    if (retry && cached?.source !== sourceName) throw new Error('来源控台改变，请读取新目录');
    const targets = retry && cached ? cached.library.directory.entries.filter(entry => !cached.library.sequences.some(sequence => sequence.sequence === entry.target) || cached.library.errors.some(error => error.sequence === entry.target)).map(entry => entry.target) : undefined;
    const progressId = crypto.randomUUID();
    useMa2MaterialReadStore.setState({ activeId: progressId });
    unsubscribe = useDocumentStore.subscribe(state => {
      if (state.documentId !== before.documentId) void window.tbLink.cancelMa2Read(progressId).catch(error => useMa2MaterialReadStore.setState({ error: toUserErrorMessage(error) }));
    });
    let partial: Ma2EffectLibrary | null = null;
    const result = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...source, progressId, projectPath: path, projectId: before.project.projectId, ...(targets && cached ? { targets, expectedSource: { show: cached.library.directory.show, generation: cached.library.directory.generation, version: cached.library.directory.version } } : {}) }, update => {
      const current = useDocumentStore.getState();
      if (current.documentId !== before.documentId) return;
      useMa2MaterialReadStore.setState({ progress: update });
      if (update.checkpoint) {
        const { directory, readAt } = update.checkpoint;
        const same = cached?.source === sourceName && cached.library.directory.show === directory.show && cached.library.directory.generation === directory.generation;
        partial = { directory, readAt, sequences: same ? cached.library.sequences.filter(sequence => directory.entries.some(entry => entry.target === sequence.sequence)) : [], fixtureUsage: [], errors: [], fixtureDetails: 'unavailable', sourceUnverified: true, incomplete: '读取中，已完成序列已保存恢复检查点' };
      }
      if (!partial || !update.sequences?.length && !update.libraryError) return;
      const sequences = update.sequences ?? [];
      const failed = update.libraryError;
      partial = { ...partial, sequences: [...partial.sequences.filter(sequence => !sequences.some(entry => entry.sequence === sequence.sequence) && sequence.sequence !== failed?.sequence), ...sequences], errors: [...partial.errors.filter(error => error.sequence !== failed?.sequence && !sequences.some(entry => entry.sequence === error.sequence)), ...failed ? [failed] : []] };
      current.executeForDocument(before.documentId, saveMa2MaterialLibraryCommand(sourceName, partial, progressId));
    }));
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换，素材没有写入其他工程');
    const library = targets && cached ? { ...result, sequences: [...cached.library.sequences.filter(sequence => !targets.includes(sequence.sequence) && result.directory.entries.some(entry => entry.target === sequence.sequence)), ...result.sequences] } : result;
    useDocumentStore.getState().executeForDocument(before.documentId, saveMa2MaterialLibraryCommand(sourceName, library, progressId));
    const current = useDocumentStore.getState();
    if (!current.project) throw new Error('工程已关闭');
    const savedPath = await linkDesktopViewModel.saveProject(path, current.project);
    if (!savedPath) throw new Error('素材已读取，工程保存未完成；恢复检查点保留');
    useDocumentStore.getState().markSaved(savedPath, current.revision, before.documentId);
  } catch (error) { useMa2MaterialReadStore.setState({ error: toUserErrorMessage(error) }); throw error; }
  finally { unsubscribe?.(); useMa2MaterialReadStore.setState({ busy: false, activeId: null, progress: null }); }
}
