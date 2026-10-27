import { readMa2Method } from './ma2-mode-store';
import { connectDiscoveredMa2, useLocalMa2Store } from './ma2-connection-store';
import { ma2NetworkStatusSchema } from '@tb/schema';
import { create } from 'zustand';
import { saveMa2MaterialLibraryCommand, toUserErrorMessage } from '@tb/core/link';
import { ma2EffectLibrarySchema, type Ma2CatalogRequest, type Ma2EffectLibrary, type Ma2ReadProgress } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { requireProjectLocation } from '../project-document';

export const useMa2MaterialReadStore = create<{ documentId: number | null; busy: boolean; activeId: string | null; progress: Ma2ReadProgress | null; error: string; message: string }>(() => ({ documentId: null, busy: false, activeId: null, progress: null, error: '', message: '' }));

export async function scanMa2Materials(source: Ma2CatalogRequest, retry = false): Promise<void> {
  if (useMa2MaterialReadStore.getState().busy) return;
  const before = useDocumentStore.getState();
  if (!before.project) throw new Error('请先打开联动工程');
  useMa2MaterialReadStore.setState({ documentId: before.documentId, busy: true, error: '', message: '', progress: null });
  let unsubscribe: (() => void) | undefined;
  try {
    // Read checkpoints are kept beside the project file; the library itself stays in memory.
    const path = await requireProjectLocation('读取控台素材');
    if (!path) throw new Error('没有选工程保存位置，这次没有读取素材');
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换');
    const sourceName = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
    const saved = before.project.ma2MaterialLibrary;
    const cached = saved?.library ? { source: saved.source, library: saved.library } : undefined;
    if (retry && cached?.source !== sourceName) throw new Error('控台换了，请重新读取目录');
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
        partial = { directory, readAt, sequences: same ? cached.library.sequences.filter(sequence => directory.entries.some(entry => entry.target === sequence.sequence)) : [], fixtureUsage: [], errors: [], fixtureDetails: 'unavailable', sourceUnverified: true, incomplete: '读取中，已读完的序列已保存，中断后可以接着读' };
      }
      if (!partial || !update.sequences?.length && !update.libraryError) return;
      const sequences = update.sequences ?? [];
      const failed = update.libraryError;
      partial = { ...partial, sequences: [...partial.sequences.filter(sequence => !sequences.some(entry => entry.sequence === sequence.sequence) && sequence.sequence !== failed?.sequence), ...sequences], errors: [...partial.errors.filter(error => error.sequence !== failed?.sequence && !sequences.some(entry => entry.sequence === error.sequence)), ...failed ? [failed] : []] };
      current.executeForDocument(before.documentId, saveMa2MaterialLibraryCommand(sourceName, partial, progressId));
    }));
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换，素材没有写进别的工程');
    const library = targets && cached ? { ...result, sequences: [...cached.library.sequences.filter(sequence => !targets.includes(sequence.sequence) && result.directory.entries.some(entry => entry.target === sequence.sequence)), ...result.sequences] } : result;
    useDocumentStore.getState().executeForDocument(before.documentId, saveMa2MaterialLibraryCommand(sourceName, library, progressId));
    useMa2MaterialReadStore.setState({ message: library.sourceUnverified || library.incomplete ? `读取未完成：${library.incomplete || '来源还没确认'}；已读取 ${library.sequences.length} 个序列` : `读取完成 · ${library.sequences.length} 个序列 · ${library.sequences.reduce((count, sequence) => count + sequence.cues.length, 0)} 个 Cue · ${library.errors.length} 项失败` });
  } catch (error) { useMa2MaterialReadStore.setState({ error: toUserErrorMessage(error) }); throw error; }
  finally { unsubscribe?.(); useMa2MaterialReadStore.setState({ busy: false, activeId: null, progress: null }); }
}

export async function ma2MaterialConnection(): Promise<Ma2CatalogRequest> {
  const method = readMa2Method();
  if (method === 'midi') throw new Error('当前是“仅 MIDI”模式，不读取控台灯光库');
  const local = useLocalMa2Store.getState();
  if (method === 'local' || (!method && local.status === 'ready')) {
    if (local.status !== 'ready') throw new Error('请先在设备设置里连接本机 onPC');
    return { dataDirectory: local.directory };
  }
  const network = ma2NetworkStatusSchema.parse(await connectDiscoveredMa2());
  if (network.state !== 'connected' || !network.settings) throw new Error('请先在设备设置里连接 MA2 控台');
  const { host, port, monitorPort, username } = network.settings;
  return { dataDirectory: '', network: { host, port, monitorPort, username } };
}
