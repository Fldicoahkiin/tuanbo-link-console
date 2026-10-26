import type { LinkAction, VisualLayer } from '@tb/schema';
import { MANAGED_OBS_SCENE_NAME, type LinkCommand } from '@tb/core/link';
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

export function resolveVisualLayer(layers: VisualLayer[], requestedId: string | undefined, fallback: 'top' | 'bottom'): VisualLayer {
  const requested = requestedId ? layers.find((layer) => layer.id === requestedId) : undefined;
  const layer = requested ?? (fallback === 'top' ? layers[0] : layers.at(-1));
  if (!layer) throw new Error('当前节目没有可用的视觉图层');
  return layer;
}

export function actionsFromObsResource(resource: ObsResource): LinkAction[] {
  const id = crypto.randomUUID();
  if (resource.kind === 'scene') return [{ id, label: `切换场景 · ${resource.name}`, kind: 'obs.setProgramScene', sceneName: resource.name }];
  if (resource.kind === 'sceneItem') {
    if (!resource.sceneName || !resource.sourceName) throw new Error('OBS 场景来源缺少场景名或来源名');
    const showAction: LinkAction = { id, label: `显示来源 · ${resource.name}`, kind: 'obs.setSceneItemEnabled', sceneName: MANAGED_OBS_SCENE_NAME, sourceName: resource.sourceName, enabled: true };
    if (!resource.transform) return [showAction];
    const transform = {
      positionX: (resource.canvasWidth ?? 1080) / 2,
      positionY: (resource.canvasHeight ?? 1920) / 2,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
      alignment: 0
    };
    return [showAction, { id: crypto.randomUUID(), label: `画布变换 · ${resource.name}`, kind: 'obs.setSceneItemTransform', sceneName: MANAGED_OBS_SCENE_NAME, sourceName: resource.sourceName, transform }];
  }
  if (resource.kind === 'filter') {
    if (!resource.sourceName) throw new Error('OBS 滤镜缺少来源名称');
    return [{ id, label: `启用滤镜 · ${resource.name}`, kind: 'obs.setSourceFilterEnabled', sourceName: resource.sourceName, filterName: resource.name, enabled: true }];
  }
  if (resource.kind === 'transition') return [{ id, label: `设置转场 · ${resource.name}`, kind: 'obs.setTransition', transitionName: resource.name, durationMs: 300 }];
  if (resource.group === 'OBS 媒体') return [{ id, label: `重播媒体 · ${resource.name}`, kind: 'obs.mediaAction', inputName: resource.name, action: 'restart' }];
  return [{ id, label: `取消静音 · ${resource.name}`, kind: 'obs.setInputMute', inputName: resource.name, muted: false }];
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
