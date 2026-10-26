import { create } from 'zustand';
import { classifyMa2Attributes, mergeMa2AttributesCommand } from '@tb/core/link';
import { ma2EffectLibrarySchema, type Ma2ReadProgress } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { ma2MaterialConnection, useMa2MaterialReadStore } from './ma2-material-read-store';

/** `failed`: the last read or console operation ended with the error in `message`. */
export const useMa2AttributeStore = create<{ busy: boolean; progress: Ma2ReadProgress | null; activeId: string | null; message: string; failed: boolean }>(() => ({ busy: false, progress: null, activeId: null, message: '', failed: false }));

export async function readMa2Attributes(targets?: number[], autoClassify = false): Promise<void> {
  if (useMa2AttributeStore.getState().busy || useMa2MaterialReadStore.getState().busy) throw new Error('正在读取控台，请等待或取消当前读取');
  const before = useDocumentStore.getState(); const cache = before.project?.ma2MaterialLibrary;
  if (!before.project || !cache?.library || cache.library.sourceUnverified) throw new Error('请先读取控台素材目录');
  const selected = [...new Set(targets ?? cache.library.sequences.map(sequence => sequence.sequence))];
  if (!selected.length) throw new Error('没有可读取属性的序列');
  const progressId = crypto.randomUUID();
  useMa2AttributeStore.setState({ busy: true, activeId: progressId, failed: false, message: '正在读取实际灯具属性', progress: { id: progressId, phase: 'connecting', completed: 0, total: selected.length + 2, detail: `准备读取 ${selected.length} 个序列的灯具属性` } });
  let unsubscribe: (() => void) | undefined;
  try {
    const source = await ma2MaterialConnection();
    const endpoint = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
    if (endpoint !== cache.source) throw new Error('当前连接的不是素材所在的控台，请重新读取目录');
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换');
    unsubscribe = useDocumentStore.subscribe(state => {
      if (state.documentId !== before.documentId) void window.tbLink.cancelMa2Read(progressId).catch((error: unknown) => useMa2AttributeStore.setState({ message: String(error) }));
    });
    const { show, generation, version } = cache.library.directory;
    // Detail reads are atomic. Do not replace the full-library recovery journal with a subset.
    const result = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...source, details: 'attributes', progressId, targets: selected, expectedSource: { show, generation, version } }, progress => useMa2AttributeStore.setState({ progress })));
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || !current.project) throw new Error('工程已切换，读取结果没有写进别的工程');
    current.executeForDocument(before.documentId, mergeMa2AttributesCommand(endpoint, result, selected, autoClassify));
    const after = useDocumentStore.getState();
    if (!after.project) throw new Error('工程已关闭');
    const review = result.cueAttributes?.filter(value => value.content?.state !== 'complete' || classifyMa2Attributes(value).roles.includes('unresolved')).length ?? 0;
    const errors = after.project.ma2MaterialLibrary?.library?.errors.filter(value => selected.includes(value.sequence)) ?? [];
    const accepted = result.cueAttributes?.filter(value => !errors.some(error => error.sequence === value.sequence)).length ?? 0;
    useMa2AttributeStore.setState({ message: `${accepted} 个 Cue 属性完整${autoClassify ? '并已分类' : ''}${review ? `；${review} 个 Cue 读取不完整` : ''}${errors.length ? `；${errors.length} 个序列需要补读（之前的结果和分类已保留）：${errors.map(entry => `${entry.sequence} ${entry.message}`).join('；')}` : ''}` });
  } catch (error) { useMa2AttributeStore.setState({ message: error instanceof Error ? error.message : String(error), failed: true }); throw error; }
  finally { unsubscribe?.(); useMa2AttributeStore.setState({ busy: false, activeId: null, progress: null }); }
}
