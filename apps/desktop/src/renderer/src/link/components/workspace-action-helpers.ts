import type { LinkAction } from '@tb/schema';
import type { LinkCommand } from '@tb/core/link';
import { assertDocumentSession } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { linkDesktopViewModel, linkFileViewModel } from '../view-models/link-desktop-view-model';
import { detectMediaKind } from './media-utils';
import type { ObsResource } from './ResourceLibrary';

export async function importWorkspaceMedia(input: {
  projectPath: string;
  files: File[];
  folderId: string | null;
  documentId: number;
  execute: (command: LinkCommand) => void;
  addAsset: (asset: Awaited<ReturnType<typeof linkDesktopViewModel.importMediaAsset>> & { folderId: string | null }) => LinkCommand;
  onImported: (assetId: string, assetName: string) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): Promise<void> {
  for (const file of input.files) {
    try {
      assertDocumentSession(input.documentId);
      input.notify(`正在导入并读取素材信息：${file.name}`);
      const metadata = { kind: detectMediaKind(file) };
      const asset = await linkDesktopViewModel.importMediaAsset({
        projectPath: input.projectPath,
        sourcePath: linkFileViewModel.getPathForFile(file),
        name: file.name,
        kind: metadata.kind,
      });
      assertDocumentSession(input.documentId);
      if (asset.kind === 'video') {
        if (!asset.durationMs) throw new Error('读不到视频时长，无法提取原声');
        const directory = input.projectPath.slice(0, Math.max(input.projectPath.lastIndexOf('/'), input.projectPath.lastIndexOf('\\')) + 1);
        try {
          await linkDesktopViewModel.importReferenceAudio({ projectPath: input.projectPath, sourcePath: directory + asset.relativePath, durationMs: asset.durationMs });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('素材不包含音频轨道')) throw error;
        }
      }
      const document = assertDocumentSession(input.documentId);
      // A newly imported video becomes draggable only after its sound is ready.
      // Preparation does not hold a document command or expose a half-ready clip.
      input.execute(input.addAsset({ ...asset, folderId: input.folderId }));
      if (document.project && useIntegrationStore.getState().obs.status === 'connected' && useRuntimeStore.getState().state === 'idle') {
        await linkDesktopViewModel.prepareObsMediaScenes(input.projectPath, { ...document.project, rundown: [], mediaAssets: [asset] }, useDisplayPreferences.getState().preciseSeeking);
        assertDocumentSession(input.documentId);
        const inventory = await linkDesktopViewModel.readObsInventory();
        assertDocumentSession(input.documentId);
        useIntegrationStore.getState().setInventory(inventory);
      } else input.notify(`${asset.name} 已导入。停止播放并连接 OBS 后，点“同步素材场景”完成准备。`);
      input.onImported(asset.id, asset.name);
    } catch (error) {
      input.notify(`${file.name}：${toMessage(error)}`, 'error');
    }
  }
}

/** A library scene becomes a camera: one scene switch. */
export function actionsFromObsResource(resource: ObsResource): LinkAction[] {
  return [{ id: crypto.randomUUID(), label: `切换场景 · ${resource.name}`, kind: 'obs.setProgramScene', sceneName: resource.name }];
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
