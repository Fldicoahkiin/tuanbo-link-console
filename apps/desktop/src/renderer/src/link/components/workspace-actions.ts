import { useMemo } from 'react';
import {
  addMediaAssetCommand,
  frameNumberToTimecode,
  lockedLayerMessage,
  millisecondsToFrameNumber,
  materialSceneNames,
  moveContentCommand,
  placeContentCommand,
  quantizeTimelineRange,
  removeContentCommand,
  replaceReferenceMediaClipCommand,
  splitContentCommand,
  timecodeToMilliseconds,
  trimContentCommand,
  type ContentRef,
  type ContentTrackTarget
} from '@tb/core/link';
import {
  DEFAULT_REFERENCE_CANVAS_TRANSFORM,
  type LinkAction, type LinkCue, type LinkProject,
  type ReferenceCanvasTransform,
  type ReferenceMediaClip
} from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { formatMilliseconds } from './media-utils';
import type { ObsResource } from './ResourceLibrary';
import { actionsFromObsResource, importWorkspaceMedia } from './workspace-action-helpers';
import { importVideoAudio } from './video-audio-import';

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

/**
 * The editor's actions, the same functions until what they act on changes (0.5.9 E3): the playhead is read when an
 * action runs, so the page does not draw again as it moves and the timeline's props stay the same between edits.
 */
export function useWorkspaceActions(input: Omit<WorkspaceActionsInput, 'project' | 'playheadMs'> & { project: LinkProject | null; playhead: { read(): number } }): ReturnType<typeof createWorkspaceActions> | null {
  const { project, projectPath, documentId, item, cue, playhead, coordinator, execute, notify, setSelectedCueId, setSelectedClipId, setSelectedAssetId, setSelectedObsResource } = input;
  return useMemo(() => project ? createWorkspaceActions({ project, projectPath, documentId, item, cue, get playheadMs() { return playhead.read(); },
    coordinator, execute, notify, setSelectedCueId, setSelectedClipId, setSelectedAssetId, setSelectedObsResource }) : null,
  [project, projectPath, documentId, item, cue, playhead, coordinator, execute, notify, setSelectedCueId, setSelectedClipId, setSelectedAssetId, setSelectedObsResource]);
}

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
        canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM
      };
      const target = trackTarget(layerId, 'top');
      if (asset.kind === 'video') {
        const video = { ...next, embeddedAudioEnabled: false };
        const command = placeContentCommand(item.id, { clip: video }, target, '添加视频');
        // A locked or missing track is reported now, not after the sound is extracted.
        command.execute(input.project);
        void importVideoAudio(input, asset, video, range.startMs, command);
        return;
      }
      input.execute(placeContentCommand(item.id, { clip: next }, target, '添加素材'));
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
      input.execute(moveContentCommand(item.id, { kind: 'clip', id: clipId }, milliseconds, trackTarget(layerId, { track: clip.layerId })));
    });
  };
  /** 置顶: on the top track where it is free there, else on a new top track. */
  const moveClipToTop = (clipId: string): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => input.execute(moveContentCommand(item.id, { kind: 'clip', id: clipId },
      timecodeToMilliseconds(requireClip(item, clipId).startTimecode, input.project.timebase.frameRate), 'top')));
  };
  /** Trim a clip or camera; it stops at its neighbours and the ends of its source. */
  const trim = (ref: ContentRef, startMs: number, durationMs: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => input.execute(trimContentCommand(item.id, ref, startMs, startMs + durationMs)));
  };
  /** `group`: one of several splits made by one key press (Ctrl+Shift+B): undone together, and the selection stays. */
  const splitClip = (clipId: string, milliseconds: number, group?: string): void => split({ kind: 'clip', id: clipId }, milliseconds, group);
  const split = (ref: ContentRef, milliseconds: number, group?: string): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const rightId = crypto.randomUUID();
      const command = splitContentCommand(item.id, ref, milliseconds, rightId);
      input.execute(group === undefined ? command : { ...command, historyGroup: group });
      if (group !== undefined) return;
      input.setSelectedClipId(ref.kind === 'clip' ? rightId : null);
      input.setSelectedCueId(ref.kind === 'cue' ? rightId : null);
    });
  };
  const duplicateClip = (clipId: string, startMs: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      const copy = { ...structuredClone(clip), id: crypto.randomUUID(), startTimecode: timecodeAt(input, startMs) };
      input.execute(placeContentCommand(item.id, { clip: copy }, trackTarget(undefined, { track: clip.layerId }), '复制素材片段'));
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
      // An edit in the editor is the look on air from now on: it goes to OBS when the material is prepared (E16).
      input.execute(replaceReferenceMediaClipCommand(item.id, { ...clip, canvasTransform, obsTransform: 'project' }));
    });
  };
  /** A clip adjusted before 0.5.9 sends that adjustment to OBS from now on. */
  const sendClipLookToObs = (clipId: string): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = requireClip(item, clipId);
      assertClipUnlocked(input, clip);
      input.execute(replaceReferenceMediaClipCommand(item.id, { ...clip, obsTransform: 'project' }));
    });
  };
  /** The clip shows as OBS has it: the editor's own adjustment is dropped, and nothing about the look goes to OBS. */
  const keepObsClipLook = (clipId: string): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const clip = { ...requireClip(item, clipId) };
      delete clip.obsTransform;
      assertClipUnlocked(input, clip);
      input.execute(replaceReferenceMediaClipCommand(item.id, { ...clip, canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM }));
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
    if (runMutation(input, () => input.execute(removeContentCommand(item.id, [{ kind: 'clip', id: clipId }])))) input.setSelectedClipId(null);
  };
  return { moveClip, moveClipToTop, trim, splitClip, splitCue: (cueId: string, milliseconds: number) => split({ kind: 'cue', id: cueId }, milliseconds), duplicateClip, transformClip, sendClipLookToObs, keepObsClipLook, setClipEmbeddedAudioEnabled, removeClip };
}

function createCueActions(input: WorkspaceActionsInput, addAssetClip: (assetId: string, startMs: number, layerId?: string | null) => boolean) {
  const addCue = (): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const next = { ...createCue(input, input.playheadMs, []), name: `Cue ${item.cues.length + 1}` };
      input.execute(placeContentCommand(item.id, { cue: next }, 'top', '添加 Cue'));
      input.setSelectedCueId(next.id);
      input.setSelectedClipId(null);
    });
  };
  const addObsResource = (resource: ObsResource, milliseconds = input.playheadMs, layerId?: string | null): boolean => {
    if (!input.item) {
      input.notify('请先选择当前节目。', 'error');
      return false;
    }
    const material = input.project.mediaAssets.find((asset) => materialSceneNames(input.project.projectId, asset).sceneName === resource.name);
    if (material) return addAssetClip(material.id, milliseconds, layerId);
    const item = input.item;
    return runMutation(input, () => {
      const actions = actionsFromObsResource(resource);
      const next = createCue(input, milliseconds, actions);
      input.execute(placeContentCommand(item.id, { cue: next }, trackTarget(layerId, 'top'), '添加机位'));
      input.setSelectedCueId(next.id);
      input.setSelectedClipId(null);
      input.setSelectedObsResource(resource);
      input.notify(`已在 ${formatMilliseconds(milliseconds)} 创建：${actions[0]?.label ?? resource.name}`);
    });
  };
  const moveCue = (cueId: string, milliseconds: number, layerId?: string | null): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const target = requireCue(item, cueId);
      input.execute(moveContentCommand(item.id, { kind: 'cue', id: cueId }, milliseconds, trackTarget(layerId, { track: target.layerId })));
    });
  };
  const removeCue = (cueId: string): void => {
    if (!input.item) return;
    const item = input.item;
    if (runMutation(input, () => input.execute(removeContentCommand(item.id, [{ kind: 'cue', id: cueId }])))) input.setSelectedCueId(null);
  };
  const duplicateCue = (cueId: string, milliseconds: number): void => {
    if (!input.item) return;
    const item = input.item;
    runMutation(input, () => {
      const source = requireCue(item, cueId);
      const next: LinkCue = { ...structuredClone(source), id: crypto.randomUUID(), timecode: timecodeAt(input, milliseconds), actions: source.actions.map((action) => ({ ...structuredClone(action), id: crypto.randomUUID() })) };
      input.execute(placeContentCommand(item.id, { cue: next }, trackTarget(undefined, { track: source.layerId }), '复制 Cue'));
      input.setSelectedCueId(next.id);
      input.setSelectedClipId(null);
    });
  };
  return { addCue, addObsResource, moveCue, removeCue, duplicateCue };
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
      input.notify(`测试成功：${action.label}`);
    } catch (error) {
      input.notify(toMessage(error), 'error');
    }
  };
  return { refreshObs, testAction };
}

function timecodeAt(input: WorkspaceActionsInput, milliseconds: number): LinkCue['timecode'] {
  return frameNumberToTimecode(millisecondsToFrameNumber(milliseconds, input.project.timebase.frameRate), input.project.timebase.frameRate);
}

function createCue(input: WorkspaceActionsInput, milliseconds: number, actions: LinkAction[] = []): LinkCue {
  return {
    id: crypto.randomUUID(),
    name: actions[0]?.label ?? `Cue ${(input.item?.cues.length ?? 0) + 1}`,
    timecode: timecodeAt(input, milliseconds),
    enabled: true,
    notes: '',
    actions
  };
}

/** Timeline drops pass a track id, null for the new-track zone below the
 * tracks, or nothing to keep `fallback` (a track id, or the top track). */
function trackTarget(layerId: string | null | undefined, fallback: { track: string | undefined } | 'top'): ContentTrackTarget {
  if (layerId === null) return { newTrack: 'bottom' };
  const track = layerId ?? (fallback === 'top' ? undefined : fallback.track);
  return track === undefined ? 'top' : { track };
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
  if (layer.locked) throw new Error(lockedLayerMessage(layer));
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

function toMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const issues = (error as { issues?: Array<{ message?: unknown }> }).issues;
    const message = issues?.find((issue) => typeof issue.message === 'string')?.message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}
