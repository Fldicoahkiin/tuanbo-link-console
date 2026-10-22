import { addMediaAssetCommand, addRundownItemCommand, programPlaylists } from '@tb/core/link';
import { rundownItemSchema } from '@tb/schema';
import { assertDocumentSession, useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel, linkFileViewModel } from '../view-models/link-desktop-view-model';
import { detectMediaKind, readMediaMetadata } from './media-utils';

export async function importProgramFiles(files: File[], playlistId: string, notify: (message: string, tone?: 'info' | 'error') => void): Promise<void> {
  const document = useDocumentStore.getState();
  if (!document.project || files.length === 0) return;
  let completed = 0;
  try {
    for (const file of files) {
      if (detectMediaKind(file) === 'image') throw new Error(`${file.name}：请拖入视频或音频`);
    }
    let path = document.path;
    if (!path) {
      path = await linkDesktopViewModel.saveProject(null, document.project);
      if (!path) return;
      assertDocumentSession(document.documentId).markSaved(path, document.stateId, document.documentId);
    }
    for (const file of files) {
      assertDocumentSession(document.documentId);
      const sourcePath = linkFileViewModel.getPathForFile(file);
      const kind = detectMediaKind(file);
      const asset = kind === 'video' ? await linkDesktopViewModel.importMediaAsset({ projectPath: path, sourcePath, name: file.name, kind }) : null;
      const durationMs = asset?.durationMs ?? (await readMediaMetadata(file)).durationMs;
      if (!durationMs) throw new Error(`${file.name}：无法读取媒体时长`);
      const referenceAudio = await linkDesktopViewModel.importReferenceAudio({ projectPath: path, sourcePath, durationMs });
      const layerId = crypto.randomUUID();
      const item = rundownItemSchema.parse({ id: crypto.randomUUID(), title: file.name, referenceAudio,
        ...(programPlaylists(document.project).some(list => list.id === playlistId) ? { playlistId } : {}),
        visualLayers: [{ id: layerId, name: '画面 1' }, { id: crypto.randomUUID(), name: '画面 2' }],
        referenceMediaClips: asset ? [{ id: crypto.randomUUID(), assetId: asset.id, label: file.name, layerId, startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, sourceOffsetMs: 0, durationMs, embeddedAudioEnabled: false }] : [] });
      const addItem = addRundownItemCommand(item);
      const addAsset = asset ? addMediaAssetCommand({ ...asset, folderId: null }) : null;
      assertDocumentSession(document.documentId).executeForDocument(document.documentId, addAsset
        ? { ...addItem, execute: project => addItem.execute(addAsset.execute(project)) }
        : addItem);
      completed++;
    }
    notify(`已添加 ${completed} 个节目。`);
  } catch (error) { notify(`已添加 ${completed} 个节目；后续导入停止：${error instanceof Error ? error.message : String(error)}`, 'error'); }
}
