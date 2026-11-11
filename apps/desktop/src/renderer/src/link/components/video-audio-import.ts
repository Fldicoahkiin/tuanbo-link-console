import { audioTracks, editedSongDurationMs, editReferenceAudioCommand, type LinkCommand } from '@tb/core/link';
import { referenceAudioSourceSchema, type LinkMediaAsset, type ReferenceMediaClip } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { WorkspaceActionsInput } from './workspace-actions';

const pending = new Set<number>();

/** Video and its independent sound enter history together, after extraction succeeds. */
export async function importVideoAudio(input: WorkspaceActionsInput, asset: LinkMediaAsset, clip: ReferenceMediaClip, startMs: number, command: LinkCommand): Promise<void> {
  if (pending.has(input.documentId)) { input.notify('正在提取视频原声，请完成后再添加下一个视频'); return; }
  pending.add(input.documentId);
  const before = useDocumentStore.getState();
  const statusTimer = setTimeout(() => {
    if (useDocumentStore.getState().documentId === before.documentId) input.notify('正在准备视频原声…');
  }, 250);
  try {
    if (!input.item || !input.projectPath || !asset.durationMs) throw new Error('请先保存工程，并等视频时长读取完成');
    if (useRuntimeStore.getState().state !== 'idle') throw new Error('请停止播放后添加视频和音频');
    const directory = input.projectPath.slice(0, Math.max(input.projectPath.lastIndexOf('/'), input.projectPath.lastIndexOf('\\')) + 1);
    let source: Awaited<ReturnType<typeof linkDesktopViewModel.importReferenceAudio>>;
    try {
      source = await linkDesktopViewModel.importReferenceAudio({ projectPath: input.projectPath, sourcePath: directory + asset.relativePath, durationMs: asset.durationMs });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('素材不包含音频轨道')) throw error;
      const current = useDocumentStore.getState();
      if (current.documentId !== before.documentId || current.revision !== before.revision || useRuntimeStore.getState().state !== 'idle') throw new Error('工程或播放状态变了，请重新拖入视频');
      current.executeForDocument(input.documentId, command);
      input.setSelectedClipId(clip.id); input.setSelectedAssetId(asset.id); input.setSelectedCueId(null);
      input.notify('已添加视频；这个视频没有声音，所以没有生成原声音轨');
      return;
    }
    const afterImport = useDocumentStore.getState();
    if (afterImport.documentId !== before.documentId || afterImport.revision !== before.revision) throw new Error('提取原声时工程被修改了，视频没有加入，请重新拖入');
    if (useRuntimeStore.getState().state !== 'idle') throw new Error('已经开始播放，视频没有加入，请停止后重新拖入');
    const tracks = input.item.referenceAudio ? audioTracks(input.item.referenceAudio, input.item.title) : [];
    tracks.push({ id: crypto.randomUUID(), title: `${asset.name} · 原声`, source: referenceAudioSourceSchema.parse(source), segments: [{ id: crypto.randomUUID(), startMs: Math.round(startMs), sourceOffsetMs: 0, durationMs: Math.floor(Math.min(clip.durationMs ?? source.durationMs, source.durationMs)) }] });
    // The song keeps any silence after its music (editedSongDurationMs), or ends with the longer of the two tracks.
    const songMs = input.item.referenceAudio ? editedSongDurationMs(input.item.referenceAudio, tracks) : undefined;
    const mixed = await linkDesktopViewModel.renderAudioSegments({ projectPath: input.projectPath, source, segments: tracks.at(-1)!.segments, tracks,
      ...(songMs === undefined ? {} : { durationMs: songMs }) });
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || current.revision !== before.revision) throw new Error('提取原声时工程被修改了，视频没有加入，请重新拖入');
    if (useRuntimeStore.getState().state !== 'idle') throw new Error('已经开始播放，视频没有加入，请停止后重新拖入');
    const audioCommand = editReferenceAudioCommand(input.item.id, mixed, '添加视频与独立原声音轨');
    current.executeForDocument(input.documentId, { ...command, label: audioCommand.label, execute: project => audioCommand.execute(command.execute(project)) });
    input.setSelectedClipId(clip.id); input.setSelectedAssetId(asset.id); input.setSelectedCueId(null);
  } catch (error) { input.notify(`添加视频原声失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
  finally { clearTimeout(statusTimer); pending.delete(input.documentId); }
}
