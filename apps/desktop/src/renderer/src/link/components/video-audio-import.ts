import { addReferenceMediaClipCommand, withContentVisualLayer, audioTracks, editReferenceAudioCommand, type LinkCommand } from '@tb/core/link';
import { referenceAudioSourceSchema, type LinkMediaAsset, type ReferenceMediaClip, type VisualLayer } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { WorkspaceActionsInput } from './workspace-actions';

const pending = new Set<number>();

export function addVideoWithAudio(input: WorkspaceActionsInput, asset: LinkMediaAsset, clip: ReferenceMediaClip, startMs: number, layer: VisualLayer, bottom: boolean): void {
  if (!input.item) return;
  const command = addReferenceMediaClipCommand(input.item.id, { ...clip, embeddedAudioEnabled: false });
  void importVideoAudio(input, asset, clip, startMs, input.item.visualLayers.some(entry => entry.id === layer.id) ? command : withContentVisualLayer(command, input.item.id, layer, bottom ? input.item.visualLayers.length : 0));
}

/** Video and its independent sound enter history together, after extraction succeeds. */
export async function importVideoAudio(input: WorkspaceActionsInput, asset: LinkMediaAsset, clip: ReferenceMediaClip, startMs: number, command: LinkCommand): Promise<void> {
  if (pending.has(input.documentId)) { input.notify('正在提取视频原声，请完成后再添加下一个视频'); return; }
  pending.add(input.documentId);
  const before = useDocumentStore.getState();
  try {
    if (!input.item || !input.projectPath || !asset.durationMs) throw new Error('请先保存工程并确认视频时长');
    if (useRuntimeStore.getState().state !== 'idle') throw new Error('请停止播放后添加视频和音频');
    input.notify('正在提取视频原声并生成独立音轨…');
    try {
      await linkDesktopViewModel.ensureMediaAudioUrl({ projectPath: input.projectPath, relativePath: asset.relativePath, sha256: asset.sha256, kind: asset.kind });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('素材不包含音频轨道')) throw error;
      const current = useDocumentStore.getState();
      if (current.documentId !== before.documentId || current.revision !== before.revision || useRuntimeStore.getState().state !== 'idle') throw new Error('工程或播放状态已改变，请重新拖入视频');
      current.executeForDocument(input.documentId, command);
      input.setSelectedClipId(clip.id); input.setSelectedAssetId(asset.id); input.setSelectedCueId(null);
      input.notify('已添加视频；此素材没有音轨，未生成原声音频');
      return;
    }
    const directory = input.projectPath.slice(0, Math.max(input.projectPath.lastIndexOf('/'), input.projectPath.lastIndexOf('\\')) + 1);
    const source = await linkDesktopViewModel.importReferenceAudio({ projectPath: input.projectPath, sourcePath: directory + asset.relativePath, durationMs: asset.durationMs });
    const tracks = input.item.referenceAudio ? audioTracks(input.item.referenceAudio, input.item.title) : [];
    tracks.push({ id: crypto.randomUUID(), title: `${asset.name} · 原声`, source: referenceAudioSourceSchema.parse(source), segments: [{ id: crypto.randomUUID(), startMs, sourceOffsetMs: 0, durationMs: Math.min(clip.durationMs ?? source.durationMs, source.durationMs) }] });
    const mixed = await linkDesktopViewModel.renderAudioSegments({ projectPath: input.projectPath, source, segments: tracks.at(-1)!.segments, tracks });
    const current = useDocumentStore.getState();
    if (current.documentId !== before.documentId || current.revision !== before.revision) throw new Error('提取期间工程已修改，视频尚未加入，请重新拖入');
    if (useRuntimeStore.getState().state !== 'idle') throw new Error('已开始播放，视频尚未加入，请停止后重新拖入');
    const audioCommand = editReferenceAudioCommand(input.item.id, mixed, '添加视频与独立原声音轨');
    current.executeForDocument(input.documentId, { ...command, label: audioCommand.label, execute: project => audioCommand.execute(command.execute(project)) });
    input.setSelectedClipId(clip.id); input.setSelectedAssetId(asset.id); input.setSelectedCueId(null);
    input.notify('已添加视频和独立原声音轨，可分别移动、裁剪和删除');
  } catch (error) { input.notify(`添加视频原声失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
  finally { pending.delete(input.documentId); }
}
