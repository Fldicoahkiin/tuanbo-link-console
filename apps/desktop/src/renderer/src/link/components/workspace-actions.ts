import {
  addCueCommand, addMediaAssetCommand, addReferenceMediaClipCommand,
  withContentVisualLayer, type LinkCommand,
  frameNumberToTimecode,
  millisecondsToFrameNumber,
  materialSceneNames,
  quantizeTimelineRange,
  removeCueCommand,
  removeReferenceMediaClipCommand,
  replaceCueCommand,
  replaceReferenceMediaClipCommand,
  splitReferenceMediaClipCommand,
  timecodeToMilliseconds
} from '@tb/core/link';
import {
  DEFAULT_REFERENCE_CANVAS_TRANSFORM,
  type LinkAction,
  type LinkCue,
  type LinkProject,
  type ReferenceCanvasTransform,
  type ReferenceMediaClip,
  type SceneItemTransform
} from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { formatMilliseconds } from './media-utils';
import type { ObsResource } from './ResourceLibrary';
import { actionsFromObsResource, importWorkspaceMedia, resolveVisualLayer } from './workspace-action-helpers';

export type WorkspaceActionsInput = {
  project: LinkProject;
  projectPath: string | null;
  documentId: number;
  item: LinkProject['rundown'][number] | null;
  cue: LinkCue | null;
  playheadMs: number;
  coordinator: LinkRuntimeCoordinator | null;
  execute: ReturnType<typeof useDocumentStore.getState>['execute'];
  notify: (message: string, tone?: 'info' | 'error') => void;
  setSelectedCueId: (id: string | null) => void;
  setSelectedClipId: (id: string | null) => void;
  setSelectedAssetId: (id: string | null) => void;
  setSelectedObsResource: (resource: ObsResource | null) => void;
};

export function createWorkspaceActions(input: WorkspaceActionsInput) {
  const mediaActions = createMediaActions(input);
  return {
    ...mediaActions,
    ...createClipActions(input),
    ...createCueActions(input, mediaActions.addAssetClip),
    ...createIntegrationActions(input)
  };
}

function createMediaActions(input: WorkspaceActionsInput) {
  const importMedia = async (files: File[], folderId: string | null): Promise<void> => {
    if (!input.projectPath) {
      input.notify('请先保存工程，再导入本地素材。', 'error');
      return;
    }
    await importWorkspaceMedia({
      projectPath: input.projectPath,
      files,
      folderId,
      documentId: input.documentId,
      execute: input.execute,
      addAsset: addMediaAssetCommand,
      onImported: (assetId, assetName) => {
        input.setSelectedAssetId(assetId);
        input.notify(`已导入参考素材：${assetName}`);
      },
      notify: input.notify
    });
  };
  const addAssetClip = (assetId: string, startMs: number, layerId?: string | null): boolean => {
    if (!input.item) {
      input.notify('请先选择当前节目。', 'error');
      return false;
    }
    const item = input.item;
    return runMutation(input, () => {
      const asset = requireAsset(input, assetId);
      const targetLayer = layerId
        ? resolveVisualLayer(item.visualLayers, layerId, 'bottom')
        : createContentLayer(item);
      if (layerId) assertLayerUnlocked(input, targetLayer.id);
      const requestedDurationMs = asset.durationMs ?? 5_000;
      const quantizedStartMs = timecodeToMilliseconds(timecodeAt(input, startMs), input.project.timebase.frameRate);
      const maximumEndMs = asset.durationMs === undefined ? undefined : quantizedStartMs + asset.durationMs;
      const range = quantizeTimelineRange(startMs, requestedDurationMs, input.project.timebase.frameRate, maximumEndMs);
      const next: ReferenceMediaClip = {
        id: crypto.randomUUID(),
        assetId,
        label: asset.name,
        startTimecode: range.startTimecode,
        sourceOffsetMs: 0,
        durationMs: range.durationMs,
        layerId: targetLayer.id,
        canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM
      };
      executeContent(input, addReferenceMediaClipCommand(item.id, next), targetLayer, layerId === null);
      input.setSelectedClipId(next.id);
      input.setSelectedAssetId(asset.id);
      input.setSelectedCueId(null);
    });
  };
  return { importMedia, addAssetClip };
}

function createClipActions(input: WorkspaceActionsInput) {
  const moveClip = (clipId: string, milliseconds: number, layerId?: string | null): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      assertClipUnlocked(input, clip);
      const next = { ...clip, startTimecode: timecodeAt(input, milliseconds) };
      const targetLayer = layerId === null ? createContentLayer(item) : resolveVisualLayer(item.visualLayers, layerId ?? clip.layerId, 'bottom');
      if (layerId !== null) assertLayerUnlocked(input, targetLayer.id);
      next.layerId = targetLayer.id;
      executeContent(input, replaceReferenceMediaClipCommand(item.id, next), targetLayer, layerId === null);
    });
  };
  const trimClip = (clipId: string, startMs: number, durationMs: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      const currentStartMs = timecodeToMilliseconds(clip.startTimecode, input.project.timebase.frameRate);
      const asset = assertClipUnlocked(input, clip);
      const maximumEndMs = asset.durationMs === undefined ? undefined : currentStartMs + asset.durationMs - (clip.sourceOffsetMs ?? 0);
      const range = quantizeTimelineRange(startMs, durationMs, input.project.timebase.frameRate, maximumEndMs);
      const sourceOffsetMs = Math.max(0, (clip.sourceOffsetMs ?? 0) + range.startMs - currentStartMs);
      input.execute(replaceReferenceMediaClipCommand(item.id, {
        ...clip,
        startTimecode: range.startTimecode,
        sourceOffsetMs: Math.round(sourceOffsetMs),
        durationMs: range.durationMs
      }));
    });
  };
  const splitClip = (clipId: string, milliseconds: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const target = requireClip(item, clipId);
      assertClipUnlocked(input, target);
      const rightClipId = crypto.randomUUID();
      input.execute(splitReferenceMediaClipCommand(item.id, clipId, timecodeAt(input, milliseconds), rightClipId));
      input.setSelectedClipId(rightClipId);
      input.setSelectedCueId(null);
    });
  };
  const duplicateClip = (clipId: string, startMs: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      assertClipUnlocked(input, clip);
      const copy = { ...structuredClone(clip), id: crypto.randomUUID(), startTimecode: timecodeAt(input, startMs) };
      input.execute(addReferenceMediaClipCommand(item.id, copy));
      input.setSelectedClipId(copy.id);
      input.setSelectedCueId(null);
    });
  };
  const transformClip = (clipId: string, canvasTransform: ReferenceCanvasTransform): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      assertClipUnlocked(input, clip);
      input.execute(replaceReferenceMediaClipCommand(item.id, { ...clip, canvasTransform }));
    });
  };
  const setClipEmbeddedAudioEnabled = (clipId: string, embeddedAudioEnabled: boolean): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      assertClipUnlocked(input, clip);
      input.execute(replaceReferenceMediaClipCommand(item.id, { ...clip, embeddedAudioEnabled }));
    });
  };
  const removeClip = (clipId: string): void => {
    if (!input.item) return;
    const item = input.item;
    if (runMutation(input, () => {
      const clip = requireClip(item, clipId);
      assertClipUnlocked(input, clip);
      input.execute(removeReferenceMediaClipCommand(item.id, clipId));
    })) input.setSelectedClipId(null);
  };
  return { moveClip, trimClip, splitClip, duplicateClip, transformClip, setClipEmbeddedAudioEnabled, removeClip };
}

function createCueActions(input: WorkspaceActionsInput, addAssetClip: (assetId: string, startMs: number, layerId?: string | null) => boolean) {
  const addCue = (): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const cueName = `Cue ${item.cues.length + 1}`;
      const layer = createContentLayer(item);
      const next = { ...createCue(input, input.playheadMs, [], layer.id), name: cueName };
      executeContent(input, addCueCommand(item.id, next), layer);
      input.setSelectedCueId(next.id);
      input.setSelectedClipId(null);
    });
  };
  const addObsResource = (resource: ObsResource, milliseconds = input.playheadMs, layerId?: string | null): boolean => {
    if (!input.item) {
      input.notify('请先选择当前节目。', 'error');
      return false;
    }
    const material = resource.kind === 'scene'
      ? input.project.mediaAssets.find((asset) => materialSceneNames(input.project.projectId, asset).sceneName === resource.sceneName)
      : undefined;
    if (material) return addAssetClip(material.id, milliseconds, layerId);
    const item = input.item;
    return runMutation(input, () => {
      const targetLayer = layerId
        ? resolveVisualLayer(item.visualLayers, layerId, 'top')
        : createContentLayer(item);
      if (layerId) assertLayerUnlocked(input, targetLayer.id);
      const actions = actionsFromObsResource(resource);
      const hasVisualSource = actions.some((action) => action.kind === 'obs.setProgramScene' || action.kind === 'obs.setSceneItemEnabled' && action.enabled);
      const next = {
        ...createCue(input, milliseconds, actions, targetLayer.id),
        ...(hasVisualSource ? { durationMs: 5_000 } : {})
      };
      executeContent(input, addCueCommand(item.id, next), targetLayer, layerId === null);
      input.setSelectedCueId(next.id);
      input.setSelectedClipId(null);
      input.setSelectedObsResource(resource);
      input.notify(`已在 ${formatMilliseconds(milliseconds)} 创建：${actions[0]?.label ?? resource.name}`);
    });
  };
  const trimCue = (cueId: string, startMs: number, durationMs: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const target = requireCue(item, cueId);
      assertLayerUnlocked(input, target.layerId);
      const range = quantizeTimelineRange(startMs, durationMs, input.project.timebase.frameRate);
      input.execute(replaceCueCommand(item.id, { ...target, timecode: range.startTimecode, durationMs: range.durationMs }));
    });
  };
  const moveCue = (cueId: string, milliseconds: number, layerId?: string | null): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const target = requireCue(item, cueId);
      assertLayerUnlocked(input, target.layerId);
      const targetLayer = layerId === null ? createContentLayer(item) : resolveVisualLayer(item.visualLayers, layerId ?? target.layerId, 'top');
      if (layerId !== null) assertLayerUnlocked(input, targetLayer.id);
      executeContent(input, replaceCueCommand(item.id, {
        ...target,
        layerId: targetLayer.id,
        timecode: timecodeAt(input, milliseconds)
      }), targetLayer, layerId === null);
    });
  };
  const transformObs = (cueId: string, transform: SceneItemTransform): void => {
    runMutation(input, () => {
      const target = input.item ? requireCue(input.item, cueId) : null;
      if (!target) throw new Error(`Cue 不存在：${cueId}`);
      assertLayerUnlocked(input, target.layerId);
      applyObsTransform(input, target, transform);
    });
  };
  const removeCue = (cueId: string): void => {
    if (!input.item) return;
    const item = input.item;
    if (runMutation(input, () => {
      const target = requireCue(item, cueId);
      assertLayerUnlocked(input, target.layerId);
      input.execute(removeCueCommand(item.id, cueId));
    })) input.setSelectedCueId(null);
  };
  const duplicateCue = (cueId: string, milliseconds: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const source = requireCue(item, cueId);
      assertLayerUnlocked(input, source.layerId);
      const next: LinkCue = { ...structuredClone(source), id: crypto.randomUUID(), timecode: timecodeAt(input, milliseconds), actions: source.actions.map((action) => ({ ...structuredClone(action), id: crypto.randomUUID() })) };
      input.execute(addCueCommand(item.id, next));
      input.setSelectedCueId(next.id);
      input.setSelectedClipId(null);
    });
  };
  return { addCue, addObsResource, trimCue, moveCue, transformObs, removeCue, duplicateCue };
}

function createIntegrationActions(input: WorkspaceActionsInput) {
  const refreshObs = async (): Promise<void> => {
    try {
      const next = await linkDesktopViewModel.readObsInventory();
      useIntegrationStore.getState().setInventory(next);
      input.notify(`OBS 资源已刷新：${next.scenes.length} 个场景，${next.inputs.length} 个输入。`);
    } catch (error) {
      input.notify(toMessage(error), 'error');
    }
  };
  const testAction = async (action: LinkAction): Promise<void> => {
    if (!input.coordinator) return;
    try {
      await input.coordinator.testAction(action);
      input.notify(`单步测试成功：${action.label}`);
    } catch (error) {
      input.notify(toMessage(error), 'error');
    }
  };
  return { refreshObs, testAction };
}

function timecodeAt(input: WorkspaceActionsInput, milliseconds: number): LinkCue['timecode'] {
  return frameNumberToTimecode(millisecondsToFrameNumber(milliseconds, input.project.timebase.frameRate), input.project.timebase.frameRate);
}

function createCue(input: WorkspaceActionsInput, milliseconds: number, actions: LinkAction[] = [], layerId?: string | null): LinkCue {
  return {
    id: crypto.randomUUID(),
    name: actions[0]?.label ?? `Cue ${(input.item?.cues.length ?? 0) + 1}`,
    timecode: timecodeAt(input, milliseconds),
    enabled: true,
    notes: '',
    actions,
    ...(layerId ? { layerId } : {})
  };
}

function runMutation(input: WorkspaceActionsInput, operation: () => void): boolean {
  try {
    operation();
    return true;
  } catch (error) {
    useDocumentStore.getState().clearError();
    input.notify(toMessage(error), 'error');
    return false;
  }
}

function assertLayerUnlocked(input: WorkspaceActionsInput, layerId: string | undefined): void {
  if (!layerId || !input.item) return;
  const layer = input.item.visualLayers.find((candidate) => candidate.id === layerId);
  if (!layer) throw new Error(`图层不存在：${layerId}`);
  if (layer.locked) throw new Error(`图层“${layer.name}”已锁定。`);
}

function createContentLayer(item: LinkProject['rundown'][number]): LinkProject['rundown'][number]['visualLayers'][number] {
  return { id: crypto.randomUUID(), name: `时间线 ${item.visualLayers.length + 1}`, visible: true, locked: false };
}

function executeContent(input: WorkspaceActionsInput, command: LinkCommand, layer: LinkProject['rundown'][number]['visualLayers'][number], bottom = false): void {
  const item = input.item;
  if (!item) throw new Error('请先选择当前节目。');
  input.execute(item.visualLayers.some((entry) => entry.id === layer.id) ? command
    : withContentVisualLayer(command, item.id, layer, bottom ? item.visualLayers.length : 0));
}

function requireAsset(input: WorkspaceActionsInput, assetId: string): LinkProject['mediaAssets'][number] {
  const asset = input.project.mediaAssets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`媒体素材不存在：${assetId}`);
  return asset;
}

function assertClipUnlocked(input: WorkspaceActionsInput, clip: ReferenceMediaClip): LinkProject['mediaAssets'][number] {
  const asset = requireAsset(input, clip.assetId);
  assertLayerUnlocked(input, clip.layerId);
  return asset;
}

function requireClip(item: LinkProject['rundown'][number], clipId: string): ReferenceMediaClip {
  const clip = item.referenceMediaClips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`参考素材片段不存在：${clipId}`);
  return clip;
}

function requireCue(item: LinkProject['rundown'][number], cueId: string): LinkCue {
  const cue = item.cues.find((candidate) => candidate.id === cueId);
  if (!cue) throw new Error(`Cue 不存在：${cueId}`);
  return cue;
}

function applyObsTransform(input: WorkspaceActionsInput, target: LinkCue, transform: SceneItemTransform): void {
  if (!input.item) return;
  const sceneItem = target.actions.find((action) => action.kind === 'obs.setSceneItemEnabled');
  if (!sceneItem) throw new Error('当前 OBS 片段不是可变换的场景来源');
  const matchesSource = (action: LinkAction): action is Extract<LinkAction, { kind: 'obs.setSceneItemTransform' }> => (
    action.kind === 'obs.setSceneItemTransform'
    && action.sceneName === sceneItem.sceneName
    && action.sourceName === sceneItem.sourceName
  );
  const hasTransform = target.actions.some(matchesSource);
  const actions = hasTransform
    ? target.actions.map((action) => matchesSource(action) ? { ...action, transform } : action)
    : [...target.actions, {
      id: crypto.randomUUID(),
      label: `画布变换 · ${sceneItem.sourceName}`,
      kind: 'obs.setSceneItemTransform' as const,
      sceneName: sceneItem.sceneName,
      sourceName: sceneItem.sourceName,
      transform
    }];
  input.execute(replaceCueCommand(input.item.id, { ...target, actions }));
}

function toMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const issues = (error as { issues?: Array<{ message?: unknown }> }).issues;
    const message = issues?.find((issue) => typeof issue.message === 'string')?.message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}
