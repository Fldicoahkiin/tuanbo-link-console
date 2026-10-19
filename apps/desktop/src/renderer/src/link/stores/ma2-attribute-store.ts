import { create } from 'zustand';
import { classifyMa2Attributes, mergeMa2AttributesCommand } from '@tb/core/link';
import { ma2EffectLibrarySchema, type Ma2ReadProgress } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { ma2MaterialConnection, useMa2MaterialReadStore } from './ma2-material-read-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export const useMa2AttributeStore = create<{ busy: boolean; progress: Ma2ReadProgress | null; activeId: string | null; message: string }>(() => ({ busy: false, progress: null, activeId: null, message: '' }));

export async function readMa2Attributes(targets?: number[], autoClassify = false): Promise<void> {
  if (useMa2AttributeStore.getState().busy || useMa2MaterialReadStore.getState().busy) throw new Error('正在读取控台，请等待或取消当前读取');
  const before = useDocumentStore.getState(); const cache = before.project?.ma2MaterialLibrary;
  if (!before.project || !cache?.library || cache.library.sourceUnverified) throw new Error('请先读取并核对控台素材目录');
  const selected = [...new Set(targets ?? cache.library.sequences.map(sequence => sequence.sequence))];
  if (!selected.length) throw new Error('没有可读取属性的序列');
  const progressId = crypto.randomUUID();
  useMa2AttributeStore.setState({ busy: true, activeId: progressId, message: '正在读取实际灯具属性', progress: { id: progressId, phase: 'connecting', completed: 0, total: selected.length + 2, detail: `准备读取 ${selected.length} 个序列的灯具属性` } });
  let unsubscribe: (() => void) | undefined;
  try {
    const source = await ma2MaterialConnection();
    const endpoint = source.network ? `${source.network.host}:${source.network.port}` : '本机 onPC';
    if (endpoint !== cache.source) throw new Error('当前连接不是素材来源控台，请重新读取目录');
    const path = await linkDesktopViewModel.saveProject(before.path, before.project);
    if (!path) throw new Error('请先保存工程');
    if (useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换');
    before.markSaved(path, before.revision, before.documentId);
    unsubscribe = useDocumentStore.subscribe(state => {
      if (state.documentId !== before.documentId) void window.tbLink.cancelMa2Read(progressId).catch((error: unknown) => useMa2AttributeStore.setState({ message: String(error) }));
    });
    const { show, generation, version } = cache.library.directory;
    // Detail reads are atomic. Do not replace the full-library recovery journal with a subset.
    const result = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...source, details: 'attributes', progressId, targets: selected, expectedSource: { show, generation, version } }, progress => useMa2AttributeStore.setState({ progress })));
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || !current.project) throw new Error('工程已切换，读取结果未写入其他工程');
    current.executeForDocument(before.documentId, mergeMa2AttributesCommand(endpoint, result, selected, autoClassify));
    const after = useDocumentStore.getState();
    if (!after.project) throw new Error('工程已关闭');
    const saved = await linkDesktopViewModel.saveProject(path, after.project);
    if (!saved) throw new Error('属性已读取，但工程尚未保存');
    after.markSaved(saved, after.revision, before.documentId);
    const review = result.cueAttributes?.filter(value => value.content?.state !== 'complete' || classifyMa2Attributes(value).roles.includes('unresolved')).length ?? 0;
    const errors = after.project.ma2MaterialLibrary?.library?.errors.filter(value => selected.includes(value.sequence)) ?? [];
    const accepted = result.cueAttributes?.filter(value => !errors.some(error => error.sequence === value.sequence)).length ?? 0;
    useMa2AttributeStore.setState({ message: `${accepted} 个 Cue 属性完整${autoClassify ? '并已分类' : ''}${review ? `；${review} 个 Cue 读取不完整` : ''}${errors.length ? `；${errors.length} 个序列需补读，旧结果和分类已保留：${errors.map(entry => `${entry.sequence} ${entry.message}`).join('；')}` : ''}` });
  } catch (error) { useMa2AttributeStore.setState({ message: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { unsubscribe?.(); useMa2AttributeStore.setState({ busy: false, activeId: null, progress: null }); }
}
