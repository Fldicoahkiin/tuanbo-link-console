import {
  linkActionSchema,
  linkCueSchema,
  mtcFrameRateSchema,
  outputCanvasSchema,
  parseLinkProject,
  p1StartTriggerSchema,
  p1MediaBindingSchema,
  p1PlaylistBindingSchema,
  referenceAudioSchema,
  linkMediaFolderSchema,
  linkMediaAssetSchema,
  referenceMediaClipSchema,
  visualLayerSchema,
  rundownItemSchema,
  type LinkAction,
  type LinkCue,
  type LinkMediaFolder,
  type LinkMediaAsset,
  type LinkProject,
  type MtcFrameRate,
  type OutputCanvas,
  type P1StartTrigger,
  type P1MediaBinding,
  type P1PlaylistBinding,
  type ReferenceAudio,
  type ReferenceMediaClip,
  type VisualLayer,
  type RundownItem
} from '@tb/schema';
import type { SmpteTimecode } from '@tb/schema';
import { timecodeToFrameNumber, timecodeToMilliseconds } from './mtc-timecode';
import { MANAGED_OBS_SCENE_NAME } from './managed-media-timeline';
import { resolveTimelineClipSpan } from './timeline-state';
import { parseP1TimeOrigin } from './ma2-time-origin';

export type LinkCommand = {
  readonly id: string;
  readonly label: string;
  /** Local lighting edits are safe against the immutable playback snapshot. */
  readonly scope?: 'lighting';
  execute(project: LinkProject): LinkProject;
  undo(before: LinkProject): LinkProject;
};

/** Prepare missing legacy layers before the editable history begins. */
export function needsProjectVisualLayers(project: LinkProject): boolean {
  return project.rundown.some((item) => !item.visualLayers.length || needsTimelineLayerAssignment(item));
}

export function initializeProjectVisualLayersCommand(): LinkCommand {
  const layers = new Map<string, VisualLayer[]>();
  return createCommand('初始化工程图层', (project) => {
    for (const item of project.rundown) {
      initializeDefaultItemLayers(item, layers);
      assignMissingTimelineLayers(item);
    }
  });
}

/** Newly added programmes and their defaults form one undoable operation. */
export function withInitialVisualLayers(command: LinkCommand): LinkCommand {
  const layers = new Map<string, VisualLayer[]>();
  return { ...command, execute(project) {
    const existing = new Set(project.rundown.map((item) => item.id));
    const next = command.execute(project);
    let initialized = false;
    for (const item of next.rundown) {
      if ((!existing.has(item.id) || needsTimelineLayerAssignment(item)) && !item.visualLayers.length) { initializeDefaultItemLayers(item, layers); initialized = true; }
      if (needsTimelineLayerAssignment(item)) { assignMissingTimelineLayers(item); initialized = true; }
    }
    return initialized ? parseLinkProject(next) : next;
  } };
}

function initializeDefaultItemLayers(item: RundownItem, cache: Map<string, VisualLayer[]>): void {
  if (item.visualLayers.length) return;
  let layers = cache.get(item.id);
  if (!layers) {
    layers = [{ id: crypto.randomUUID(), name: '图层 2', visible: true, locked: false }, { id: crypto.randomUUID(), name: '图层 1', visible: true, locked: false }];
    cache.set(item.id, layers);
  }
  item.visualLayers = structuredClone(layers);
  for (const clip of item.referenceMediaClips) clip.layerId = layers[1]!.id;
  for (const cue of item.cues) cue.layerId = cue.actions.some((action) => action.kind.startsWith('obs.')) ? layers[0]!.id : layers[1]!.id;
}

type TimestampProvider = () => string;

export type P1ImportedRundownItem = {
  title: string;
  importNotes?: string;
  referenceAudio: ReferenceAudio;
  p1Media: P1MediaBinding;
};

export type P1ProjectImportSnapshot = {
  sourceOrder?: string[];
  skippedItems?: import('@tb/schema').P1ImportIssue[];
  sourceSha256: string;
  playlists: P1PlaylistBinding[];
  items: P1ImportedRundownItem[];
};

export type P1ProjectExportSnapshot = {
  skippedItems?: import('@tb/schema').P1ImportIssue[];
  sourceSha256: string;
  playlists: P1PlaylistBinding[];
  itemBindings: Array<{ itemId: string; p1Media: P1MediaBinding }>;
};

export function renameProjectCommand(name: string, now?: TimestampProvider): LinkCommand {
  if (name.trim() === '') throw new Error('工程名称不能为空');
  return createCommand('重命名工程', (project) => {
    project.name = name.trim();
  }, now);
}

export function setObsOutputModeCommand(mode: 'managed' | 'scenes'): LinkCommand {
  return createCommand('修改 OBS 输出方式', (project) => { project.obsOutputMode = mode; });
}

export function setItemPlaybackCommand(itemId: string, playback: NonNullable<RundownItem['playback']>): LinkCommand {
  return createCommand('修改歌曲播放属性', (project) => {
    const item = requireItem(project, itemId);
    const duration = item.referenceAudio?.durationMs;
    const end = playback.endMs || duration;
    if (end !== undefined && (playback.startMs >= end || (duration !== undefined && end > duration))) throw new Error('裁剪范围必须在音频时长内，结束时间必须大于开始时间');
    if (playback.shortcut && project.rundown.some((entry) => entry.id !== itemId && entry.playback?.shortcut.toLowerCase() === playback.shortcut.toLowerCase())) throw new Error('快捷键已被其他歌曲使用');
    item.playback = playback;
  });
}

export function setProjectFrameRateCommand(frameRate: MtcFrameRate, now?: TimestampProvider): LinkCommand {
  const parsed = mtcFrameRateSchema.parse(frameRate);
  return createCommand('修改工程帧率', (project) => {
    project.timebase.frameRate = parsed;
  }, now);
}

export function setProjectOutputCanvasCommand(outputCanvas: OutputCanvas, now?: TimestampProvider): LinkCommand {
  const parsed = outputCanvasSchema.parse(outputCanvas);
  return createCommand('修改输出画布', (project) => {
    project.outputCanvas = parsed;
  }, now);
}

export function addRundownItemCommand(item: RundownItem, index?: number, now?: TimestampProvider): LinkCommand {
  const parsed = rundownItemSchema.parse(item);
  return createCommand('添加节目', (project) => {
    const target = index ?? project.rundown.length;
    assertInsertIndex(target, project.rundown.length, '节目');
    project.rundown.splice(target, 0, structuredClone(parsed));
  }, now);
}

export function updateRundownItemCommand(
  itemId: string,
  update: Pick<RundownItem, 'title' | 'enabled' | 'notes'>,
  now?: TimestampProvider
): LinkCommand {
  return createCommand('修改节目', (project) => {
    const item = requireItem(project, itemId);
    if (update.title.trim() === '') throw new Error('节目标题不能为空');
    item.title = update.title.trim();
    item.enabled = update.enabled;
    item.notes = update.notes;
  }, now);
}

export function setRundownItemP1StartTriggerCommand(
  itemId: string,
  trigger: P1StartTrigger | null,
  now?: TimestampProvider
): LinkCommand {
  const parsed = trigger === null ? null : p1StartTriggerSchema.parse(trigger);
  return createCommand('配置 P1 播放触发', (project) => {
    const item = requireItem(project, itemId);
    if (parsed === null) delete item.p1StartTrigger;
    else item.p1StartTrigger = structuredClone(parsed);
  }, now);
}

export function synchronizeP1ProjectCommand(
  snapshot: P1ProjectImportSnapshot,
  createId: () => string = () => crypto.randomUUID(),
  now?: TimestampProvider
): LinkCommand {
  const sourceSha256 = parseSha256(snapshot.sourceSha256);
  const playlists = snapshot.playlists.map((playlist) => p1PlaylistBindingSchema.parse(playlist));
  const importedItems = snapshot.items.map((item) => ({
    title: rundownItemSchema.shape.title.parse(item.title),
    importNotes: item.importNotes,
    referenceAudio: referenceAudioSchema.parse(item.referenceAudio),
    p1Media: p1MediaBindingSchema.parse(item.p1Media)
  }));
  return createCommand('从 P1 同步可用音频', (project) => {
    const existingBySourceKey = new Map(
      project.rundown
        .filter(item => item.p1Media || item.p1UnavailableSourceKey)
        .map((item) => [item.p1Media?.sourceKey ?? item.p1UnavailableSourceKey, item])
    );
    const importedKeys = new Set(importedItems.map((item) => item.p1Media.sourceKey));
    const matchedIds = new Set<string>();
    const synchronized = importedItems.map((imported) => {
      const exactAudioMatches = project.rundown.filter((item) => !item.p1Media
        && item.referenceAudio?.sha256 === imported.referenceAudio.sha256);
      const uniqueImportedAudio = importedItems.filter((item) => item.referenceAudio.sha256 === imported.referenceAudio.sha256).length === 1;
      const existing = existingBySourceKey.get(imported.p1Media.sourceKey)
        ?? (uniqueImportedAudio && exactAudioMatches.length === 1 ? exactAudioMatches[0] : undefined);
      const playback = {
        volume: imported.p1Media.muted ? 0 : imported.p1Media.volume,
        startMs: 0, endMs: 0,
        endAction: imported.p1Media.playEndAction === 'playNext' ? 'next' : imported.p1Media.playEndAction,
        shortcut: imported.p1Media.shortcut,
        ...existing?.playback,
        mtcOffsetMs: parseP1TimeOrigin(imported.p1Media.midiStartTime)
      };
      if (!existing) {
        return rundownItemSchema.parse({
          id: createId(),
          title: imported.title,
          enabled: true,
          notes: imported.importNotes ?? '',
          p1Media: imported.p1Media,
          playback,
          referenceAudio: imported.referenceAudio,
          referenceMediaClips: [],
          cues: []
        });
      }
      matchedIds.add(existing.id);
      return rundownItemSchema.parse({
        ...structuredClone(existing),
        p1UnavailableSourceKey: undefined,
        enabled: existing.p1UnavailableSourceKey ? true : existing.enabled,
        notes: imported.importNotes ?? (existing.p1UnavailableSourceKey ? '' : existing.notes),
        title: imported.title,
        p1Media: imported.p1Media,
        playback,
        referenceAudio: imported.referenceAudio
      });
    });
    const retained = project.rundown
      .filter((item) => !matchedIds.has(item.id) && !importedKeys.has(item.p1Media?.sourceKey ?? item.p1UnavailableSourceKey ?? ''))
      .map((item) => {
        const copy = structuredClone(item);
        const issue = snapshot.skippedItems?.find(issue => issue.sourceKey === (copy.p1Media?.sourceKey ?? copy.p1UnavailableSourceKey));
        if (issue) { copy.enabled = false; copy.p1UnavailableSourceKey = issue.sourceKey; copy.notes = `P1 音频待修复：${issue.reason}`; }
        else delete copy.p1Media;
        return copy;
      });
    project.p1Sync = {
      ...(snapshot.skippedItems?.length ? { skippedItems: structuredClone(snapshot.skippedItems) } : {}),
      format: 'hirender-p1-audio-project',
      sourceSha256,
      importedAt: timestamp(now),
      playlists: structuredClone(playlists)
    };
    const unavailable = (snapshot.skippedItems ?? []).filter(issue => !existingBySourceKey.has(issue.sourceKey)).map(issue => rundownItemSchema.parse({
      id: createId(), title: issue.title, enabled: false, notes: `P1 音频待修复：${issue.reason}`, p1UnavailableSourceKey: issue.sourceKey,
      playlistId: issue.playlistId && (project.playlists === undefined || project.playlists.some(list => list.id === `p1:${issue.playlistId}`)) ? `p1:${issue.playlistId}` : undefined
    }));
    project.rundown = [...synchronized, ...retained, ...unavailable];
    if (snapshot.sourceOrder) {
      const order = new Map(snapshot.sourceOrder.map((key, index) => [key, index]));
      const position = (item: RundownItem): number => order.get(item.p1Media?.sourceKey ?? item.p1UnavailableSourceKey ?? '') ?? Number.MAX_SAFE_INTEGER;
      project.rundown.sort((left, right) => position(left) - position(right));
    }
  }, now);
}

export function applyP1ProjectExportCommand(
  snapshot: P1ProjectExportSnapshot,
  now?: TimestampProvider
): LinkCommand {
  const sourceSha256 = parseSha256(snapshot.sourceSha256);
  const playlists = snapshot.playlists.map((playlist) => p1PlaylistBindingSchema.parse(playlist));
  const bindings = new Map(snapshot.itemBindings.map(({ itemId, p1Media }) => [itemId, p1MediaBindingSchema.parse(p1Media)]));
  return createCommand('记录 P1 工程写回结果', (project) => {
    for (const item of project.rundown) {
      const unavailable = snapshot.skippedItems?.find(issue => (issue.previousSourceKey ?? issue.sourceKey) === (item.p1UnavailableSourceKey ?? item.p1Media?.sourceKey));
      if (unavailable) { item.p1UnavailableSourceKey = unavailable.sourceKey; item.enabled = false; }
      const binding = bindings.get(item.id);
      if (binding) {
        item.p1Media = structuredClone(binding);
        if (item.playback) item.playback.mtcOffsetMs = parseP1TimeOrigin(binding.midiStartTime);
      }
      else delete item.p1Media;
    }
    project.p1Sync = {
      ...(snapshot.skippedItems?.length ? { skippedItems: structuredClone(snapshot.skippedItems) } : {}),
      format: 'hirender-p1-audio-project',
      sourceSha256,
      importedAt: timestamp(now),
      playlists: structuredClone(playlists)
    };
  }, now);
}

export function removeRundownItemCommand(itemId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('删除节目', (project) => {
    const index = project.rundown.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error(`节目不存在：${itemId}`);
    project.rundown.splice(index, 1);
  }, now);
}

export function moveRundownItemCommand(itemId: string, targetIndex: number, now?: TimestampProvider): LinkCommand {
  return createCommand('移动节目', (project) => {
    const sourceIndex = project.rundown.findIndex((item) => item.id === itemId);
    if (sourceIndex < 0) throw new Error(`节目不存在：${itemId}`);
    assertExistingIndex(targetIndex, project.rundown.length, '节目');
    const removed = project.rundown.splice(sourceIndex, 1)[0];
    if (!removed) throw new Error(`节目不存在：${itemId}`);
    project.rundown.splice(targetIndex, 0, removed);
  }, now);
}

export function duplicateRundownItemCommand(
  itemId: string,
  createId: () => string = () => crypto.randomUUID(),
  now?: TimestampProvider
): LinkCommand {
  return createCommand('复制节目', (project) => {
    const sourceIndex = project.rundown.findIndex((item) => item.id === itemId);
    if (sourceIndex < 0) throw new Error(`节目不存在：${itemId}`);
    const source = project.rundown[sourceIndex];
    if (!source) throw new Error(`节目不存在：${itemId}`);
    const copy = structuredClone(source);
    copy.id = createId();
    copy.title = `${copy.title} 副本`;
    for (const cue of copy.cues) {
      cue.id = createId();
      for (const action of cue.actions) action.id = createId();
    }
    if (copy.p1StartTrigger) copy.p1StartTrigger.id = createId();
    delete copy.p1Media;
    for (const clip of copy.referenceMediaClips) clip.id = createId();
    project.rundown.splice(sourceIndex + 1, 0, copy);
  }, now);
}

function parseSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('P1 工程 SHA-256 格式无效');
  return value;
}

function timestamp(now?: TimestampProvider): string {
  return (now ?? (() => new Date().toISOString()))();
}

export function addMediaAssetCommand(asset: LinkMediaAsset, now?: TimestampProvider): LinkCommand {
  const parsed = linkMediaAssetSchema.parse(asset);
  return createCommand('添加媒体素材', (project) => {
    const existing = project.mediaAssets.find((candidate) => candidate.sha256 === parsed.sha256);
    if (existing) throw new Error(`素材已存在：${existing.name}`);
    project.mediaAssets.push(structuredClone(parsed));
  }, now);
}

export function addMediaFolderCommand(folder: LinkMediaFolder, now?: TimestampProvider): LinkCommand {
  const parsed = linkMediaFolderSchema.parse(folder);
  return createCommand('新建资源文件夹', (project) => {
    if (parsed.parentId !== null) requireMediaFolder(project, parsed.parentId);
    assertFolderNameAvailable(project, parsed.name, parsed.parentId);
    project.mediaFolders.push(structuredClone(parsed));
  }, now);
}

export function renameMediaFolderCommand(folderId: string, name: string, now?: TimestampProvider): LinkCommand {
  return createCommand('重命名资源文件夹', (project) => {
    const folder = requireMediaFolder(project, folderId);
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('文件夹名称不能为空');
    assertFolderNameAvailable(project, trimmed, folder.parentId, folder.id);
    folder.name = trimmed;
  }, now);
}

export function moveMediaFolderCommand(folderId: string, parentId: string | null, now?: TimestampProvider): LinkCommand {
  return createCommand('移动资源文件夹', (project) => {
    const folder = requireMediaFolder(project, folderId);
    if (parentId === folderId) throw new Error('文件夹不能移入自身');
    if (parentId !== null) requireMediaFolder(project, parentId);
    assertFolderNameAvailable(project, folder.name, parentId, folder.id);
    folder.parentId = parentId;
  }, now);
}

export function removeMediaFolderCommand(folderId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('删除资源文件夹', (project) => {
    const index = project.mediaFolders.findIndex((folder) => folder.id === folderId);
    if (index < 0) throw new Error(`资源文件夹不存在：${folderId}`);
    if (project.mediaFolders.some((folder) => folder.parentId === folderId)) {
      throw new Error('文件夹中仍包含子文件夹');
    }
    if (project.mediaAssets.some((asset) => asset.folderId === folderId)) {
      throw new Error('文件夹中仍包含媒体素材');
    }
    project.mediaFolders.splice(index, 1);
  }, now);
}

export function renameMediaAssetCommand(assetId: string, name: string, now?: TimestampProvider): LinkCommand {
  return createCommand('重命名媒体素材', (project) => {
    const asset = requireMediaAsset(project, assetId);
    if (name.trim() === '') throw new Error('素材名称不能为空');
    asset.name = name.trim();
  }, now);
}

export function moveMediaAssetCommand(assetId: string, folderId: string | null, now?: TimestampProvider): LinkCommand {
  return createCommand('移动媒体素材', (project) => {
    const asset = requireMediaAsset(project, assetId);
    if (folderId !== null) requireMediaFolder(project, folderId);
    asset.folderId = folderId;
  }, now);
}

export function removeMediaAssetCommand(assetId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('删除媒体素材', (project) => {
    const index = project.mediaAssets.findIndex((asset) => asset.id === assetId);
    if (index < 0) throw new Error(`媒体素材不存在：${assetId}`);
    const referencedBy = project.rundown.find((item) => item.referenceMediaClips.some((clip) => clip.assetId === assetId));
    if (referencedBy) throw new Error(`素材仍被节目“${referencedBy.title}”的参考时间线使用`);
    project.mediaAssets.splice(index, 1);
  }, now);
}

export function setReferenceAudioCommand(
  itemId: string,
  referenceAudio: ReferenceAudio | null,
  now?: TimestampProvider
): LinkCommand {
  return createCommand('设置参考音频', (project) => {
    const item = requireItem(project, itemId);
    if (referenceAudio === null) {
      for (const clip of item.referenceMediaClips) if (clip.assetId === item.referenceAudio?.sourceMediaAssetId) clip.embeddedAudioEnabled = false;
      delete item.referenceAudio;
      return;
    }
    item.referenceAudio = structuredClone(referenceAudio);
  }, now);
}

export function editReferenceAudioCommand(itemId: string, audio: ReferenceAudio, label: string): LinkCommand {
  return createCommand(label, (project) => {
    const item = requireItem(project, itemId);
    // Once a legacy video's sound becomes independently editable, deleting its
    // audio track must not reactivate the video's former embedded sound.
    if (audio.timeline?.tracks) for (const clip of item.referenceMediaClips) if (clip.assetId === item.referenceAudio?.sourceMediaAssetId) clip.embeddedAudioEnabled = false;
    item.referenceAudio = referenceAudioSchema.parse(audio);
    if (item.playback && (item.playback.startMs >= audio.durationMs || item.playback.endMs > audio.durationMs)) {
      item.playback = { ...item.playback, startMs: Math.min(item.playback.startMs, audio.durationMs - 1), endMs: Math.min(item.playback.endMs, audio.durationMs) };
    }
  });
}

export function initializeVisualLayersCommand(
  itemId: string,
  obsLayer: VisualLayer,
  mediaLayer: VisualLayer,
  now?: TimestampProvider
): LinkCommand {
  const parsedObsLayer = visualLayerSchema.parse(obsLayer);
  const parsedMediaLayer = visualLayerSchema.parse(mediaLayer);
  if (parsedObsLayer.id === parsedMediaLayer.id) throw new Error('默认视觉图层 ID 不能重复');
  return createCommand('初始化视觉图层', (project) => {
    const item = requireItem(project, itemId);
    if (item.visualLayers.length > 0) return;
    item.visualLayers = [structuredClone(parsedObsLayer), structuredClone(parsedMediaLayer)];
    for (const clip of item.referenceMediaClips) {
      clip.layerId = parsedMediaLayer.id;
    }
    for (const cue of item.cues) {
      cue.layerId = cue.actions.some((action) => action.kind.startsWith('obs.')) ? parsedObsLayer.id : parsedMediaLayer.id;
    }
  }, now);
}

export function normalizeTimelineLayersCommand(itemId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('整理时间线图层', (project) => {
    assignMissingTimelineLayers(requireItem(project, itemId));
  }, now);
}

function needsTimelineLayerAssignment(item: RundownItem): boolean {
  return item.referenceMediaClips.some((clip) => !clip.layerId) || item.cues.some((cue) => !cue.layerId);
}

function assignMissingTimelineLayers(item: RundownItem): void {
  if (!item.visualLayers.length || !needsTimelineLayerAssignment(item)) return;
  const ids = new Set(item.visualLayers.map((layer) => layer.id));
  const addLayer = (entryId: string, name: string): string => {
    const base = `timeline-layer-${entryId}`;
    let id = base; let suffix = 2;
    while (ids.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
    ids.add(id);
    item.visualLayers.unshift({ id, name, visible: true, locked: false });
    return id;
  };
  for (const clip of item.referenceMediaClips) if (!clip.layerId) clip.layerId = addLayer(clip.id, clip.label);
  for (const cue of item.cues) if (!cue.layerId) cue.layerId = addLayer(cue.id, cue.name);
}

export function routeVisualObsCuesToManagedSceneCommand(
  itemId: string,
  now?: TimestampProvider
): LinkCommand {
  return createCommand('接入 OBS 受管输出', (project) => {
    const item = requireItem(project, itemId);
    for (const cue of item.cues) {
      if (!cue.layerId) continue;
      cue.actions = cue.actions.map((action) => {
        if (action.kind !== 'obs.setSceneItemEnabled' && action.kind !== 'obs.setSceneItemTransform' && action.kind !== 'obs.setSceneItemIndex') return action;
        return linkActionSchema.parse({ ...action, sceneName: MANAGED_OBS_SCENE_NAME });
      });
    }
  }, now);
}

export function addVisualLayerCommand(itemId: string, layer: VisualLayer, index = 0, now?: TimestampProvider): LinkCommand {
  const parsed = visualLayerSchema.parse(layer);
  return createCommand('添加视觉图层', (project) => {
    const item = requireItem(project, itemId);
    if (item.visualLayers.some((candidate) => candidate.id === parsed.id)) throw new Error(`视觉图层 ID 重复：${parsed.id}`);
    assertInsertIndex(index, item.visualLayers.length, '视觉图层');
    item.visualLayers.splice(index, 0, structuredClone(parsed));
  }, now);
}

/** Create a content lane and place its content in the same history entry. */
export function withContentVisualLayer(command: LinkCommand, itemId: string, layer: VisualLayer, index: number): LinkCommand {
  const addLayer = addVisualLayerCommand(itemId, layer, index);
  return { ...command, execute: (project) => command.execute(addLayer.execute(project)) };
}

export function moveVisualLayerCommand(itemId: string, layerId: string, targetIndex: number, now?: TimestampProvider): LinkCommand {
  return createCommand('调整视觉图层层序', (project) => {
    const item = requireItem(project, itemId);
    const sourceIndex = item.visualLayers.findIndex((layer) => layer.id === layerId);
    if (sourceIndex < 0) throw new Error(`视觉图层不存在：${layerId}`);
    assertExistingIndex(targetIndex, item.visualLayers.length, '视觉图层');
    const layer = item.visualLayers.splice(sourceIndex, 1)[0];
    if (!layer) throw new Error(`视觉图层不存在：${layerId}`);
    item.visualLayers.splice(targetIndex, 0, layer);
  }, now);
}

export function updateVisualLayerCommand(itemId: string, layer: VisualLayer, now?: TimestampProvider): LinkCommand {
  const parsed = visualLayerSchema.parse(layer);
  return createCommand('修改视觉图层', (project) => {
    const item = requireItem(project, itemId);
    const index = item.visualLayers.findIndex((candidate) => candidate.id === parsed.id);
    if (index < 0) throw new Error(`视觉图层不存在：${parsed.id}`);
    item.visualLayers[index] = structuredClone(parsed);
  }, now);
}

export function removeVisualLayerCommand(itemId: string, layerId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('删除视觉图层', (project) => {
    const item = requireItem(project, itemId);
    const index = item.visualLayers.findIndex((layer) => layer.id === layerId);
    if (index < 0) throw new Error(`视觉图层不存在：${layerId}`);
    if (item.referenceMediaClips.some((clip) => clip.layerId === layerId) || item.cues.some((cue) => cue.layerId === layerId)) {
      throw new Error('图层中仍有素材或 Cue，不能删除');
    }
    item.visualLayers.splice(index, 1);
  }, now);
}

export function addReferenceMediaClipCommand(
  itemId: string,
  clip: ReferenceMediaClip,
  index?: number,
  now?: TimestampProvider
): LinkCommand {
  const parsed = referenceMediaClipSchema.parse(clip);
  return createCommand('添加参考素材片段', (project) => {
    const item = requireItem(project, itemId);
    requireMediaAsset(project, parsed.assetId);
    const target = index ?? item.referenceMediaClips.length;
    assertInsertIndex(target, item.referenceMediaClips.length, '参考素材片段');
    item.referenceMediaClips.splice(target, 0, structuredClone(parsed));
  }, now);
}

export function replaceReferenceMediaClipCommand(
  itemId: string,
  clip: ReferenceMediaClip,
  now?: TimestampProvider
): LinkCommand {
  const parsed = referenceMediaClipSchema.parse(clip);
  return createCommand('修改参考素材片段', (project) => {
    const item = requireItem(project, itemId);
    requireMediaAsset(project, parsed.assetId);
    const index = item.referenceMediaClips.findIndex((candidate) => candidate.id === parsed.id);
    if (index < 0) throw new Error(`参考素材片段不存在：${parsed.id}`);
    item.referenceMediaClips[index] = structuredClone(parsed);
  }, now);
}

export function splitReferenceMediaClipCommand(
  itemId: string,
  clipId: string,
  splitTimecode: SmpteTimecode,
  rightClipId: string,
  now?: TimestampProvider
): LinkCommand {
  if (rightClipId === clipId) throw new Error('切割后的片段 ID 不能重复');
  return createCommand('切割参考素材片段', (project) => {
    const item = requireItem(project, itemId);
    const index = item.referenceMediaClips.findIndex((clip) => clip.id === clipId);
    if (index < 0) throw new Error(`参考素材片段不存在：${clipId}`);
    if (item.referenceMediaClips.some((clip) => clip.id === rightClipId)) throw new Error(`参考素材片段 ID 重复：${rightClipId}`);
    const source = item.referenceMediaClips[index];
    if (!source) throw new Error(`参考素材片段不存在：${clipId}`);
    const sourceSpan = resolveTimelineClipSpan(source, project.timebase.frameRate);
    const splitMs = timecodeToMilliseconds(splitTimecode, project.timebase.frameRate);
    const splitFrame = timecodeToFrameNumber(splitTimecode, project.timebase.frameRate);
    if (splitFrame <= sourceSpan.startFrame || splitFrame >= sourceSpan.endFrame) throw new Error('切割点必须位于素材片段内部');
    const leftDurationMs = Math.max(1, Math.min(source.durationMs - 1, Math.round(splitMs - sourceSpan.startMs)));
    const rightDurationMs = source.durationMs - leftDurationMs;
    const left = referenceMediaClipSchema.parse({ ...source, durationMs: leftDurationMs });
    const right = referenceMediaClipSchema.parse({
      ...source,
      id: rightClipId,
      startTimecode: splitTimecode,
      sourceOffsetMs: (source.sourceOffsetMs ?? 0) + leftDurationMs,
      durationMs: rightDurationMs
    });
    item.referenceMediaClips.splice(index, 1, left, right);
  }, now);
}

export function removeReferenceMediaClipCommand(
  itemId: string,
  clipId: string,
  now?: TimestampProvider
): LinkCommand {
  return createCommand('删除参考素材片段', (project) => {
    const item = requireItem(project, itemId);
    const index = item.referenceMediaClips.findIndex((clip) => clip.id === clipId);
    if (index < 0) throw new Error(`参考素材片段不存在：${clipId}`);
    item.referenceMediaClips.splice(index, 1);
  }, now);
}

export function addCueCommand(itemId: string, cue: LinkCue, index?: number, now?: TimestampProvider): LinkCommand {
  const parsed = linkCueSchema.parse(cue);
  return createCommand('添加 Cue', (project) => {
    const item = requireItem(project, itemId);
    const target = index ?? item.cues.length;
    assertInsertIndex(target, item.cues.length, 'Cue');
    item.cues.splice(target, 0, structuredClone(parsed));
  }, now);
}

export function replaceCueCommand(itemId: string, cue: LinkCue, now?: TimestampProvider): LinkCommand {
  const parsed = linkCueSchema.parse(cue);
  return createCommand('修改 Cue', (project) => {
    const item = requireItem(project, itemId);
    const index = item.cues.findIndex((candidate) => candidate.id === parsed.id);
    if (index < 0) throw new Error(`Cue 不存在：${parsed.id}`);
    item.cues[index] = structuredClone(parsed);
  }, now);
}

export function removeCueCommand(itemId: string, cueId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('删除 Cue', (project) => {
    const item = requireItem(project, itemId);
    const index = item.cues.findIndex((cue) => cue.id === cueId);
    if (index < 0) throw new Error(`Cue 不存在：${cueId}`);
    item.cues.splice(index, 1);
  }, now);
}

export function moveCueCommand(itemId: string, cueId: string, targetIndex: number, now?: TimestampProvider): LinkCommand {
  return createCommand('移动 Cue', (project) => {
    const item = requireItem(project, itemId);
    const sourceIndex = item.cues.findIndex((cue) => cue.id === cueId);
    if (sourceIndex < 0) throw new Error(`Cue 不存在：${cueId}`);
    assertExistingIndex(targetIndex, item.cues.length, 'Cue');
    const removed = item.cues.splice(sourceIndex, 1)[0];
    if (!removed) throw new Error(`Cue 不存在：${cueId}`);
    item.cues.splice(targetIndex, 0, removed);
  }, now);
}

export function addActionCommand(
  itemId: string,
  cueId: string,
  action: LinkAction,
  index?: number,
  now?: TimestampProvider
): LinkCommand {
  const parsed = linkActionSchema.parse(action);
  return createCommand('添加 Cue 动作', (project) => {
    const cue = requireCue(project, itemId, cueId);
    const target = index ?? cue.actions.length;
    assertInsertIndex(target, cue.actions.length, 'Cue 动作');
    cue.actions.splice(target, 0, structuredClone(parsed));
  }, now);
}

export function replaceActionCommand(
  itemId: string,
  cueId: string,
  action: LinkAction,
  now?: TimestampProvider
): LinkCommand {
  const parsed = linkActionSchema.parse(action);
  return createCommand('修改 Cue 动作', (project) => {
    const cue = requireCue(project, itemId, cueId);
    const index = cue.actions.findIndex((candidate) => candidate.id === parsed.id);
    if (index < 0) throw new Error(`Cue 动作不存在：${parsed.id}`);
    cue.actions[index] = structuredClone(parsed);
  }, now);
}

export function removeActionCommand(itemId: string, cueId: string, actionId: string, now?: TimestampProvider): LinkCommand {
  return createCommand('删除 Cue 动作', (project) => {
    const cue = requireCue(project, itemId, cueId);
    const index = cue.actions.findIndex((action) => action.id === actionId);
    if (index < 0) throw new Error(`Cue 动作不存在：${actionId}`);
    cue.actions.splice(index, 1);
  }, now);
}

export function moveActionCommand(
  itemId: string,
  cueId: string,
  actionId: string,
  targetIndex: number,
  now?: TimestampProvider
): LinkCommand {
  return createCommand('移动 Cue 动作', (project) => {
    const cue = requireCue(project, itemId, cueId);
    const sourceIndex = cue.actions.findIndex((action) => action.id === actionId);
    if (sourceIndex < 0) throw new Error(`Cue 动作不存在：${actionId}`);
    assertExistingIndex(targetIndex, cue.actions.length, 'Cue 动作');
    const removed = cue.actions.splice(sourceIndex, 1)[0];
    if (!removed) throw new Error(`Cue 动作不存在：${actionId}`);
    cue.actions.splice(targetIndex, 0, removed);
  }, now);
}

export function configureP1AutoFollowCommand(config: NonNullable<LinkProject['p1AutoFollow']>): LinkCommand {
  return createCommand('配置 P1 点击播放自动联动', (project) => { project.p1AutoFollow = structuredClone(config); });
}

export function setPlaybackSourceCommand(source: 'p1' | 'internal'): LinkCommand {
  return createCommand('切换播放主控', (project) => { project.playbackSource = source; if (source === 'internal' && project.p1AutoFollow) project.p1AutoFollow.enabled = false; });
}

export function setInternalVideoAudioCommand(enabled: boolean): LinkCommand {
  return createCommand('设置内部主控视频原声', (project) => { project.internalVideoAudio = enabled; });
}

function createCommand(
  label: string,
  mutate: (project: LinkProject) => void,
  now: TimestampProvider = () => new Date().toISOString()
): LinkCommand {
  return {
    id: crypto.randomUUID(),
    label,
    execute(project) {
      const next = structuredClone(project);
      mutate(next);
      next.updatedAt = now();
      return parseLinkProject(next);
    },
    undo(before) {
      return parseLinkProject(before);
    }
  };
}

function requireItem(project: LinkProject, itemId: string): RundownItem {
  const item = project.rundown.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`节目不存在：${itemId}`);
  return item;
}

function requireMediaAsset(project: LinkProject, assetId: string): LinkMediaAsset {
  const asset = project.mediaAssets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`媒体素材不存在：${assetId}`);
  return asset;
}

function requireMediaFolder(project: LinkProject, folderId: string): LinkMediaFolder {
  const folder = project.mediaFolders.find((candidate) => candidate.id === folderId);
  if (!folder) throw new Error(`资源文件夹不存在：${folderId}`);
  return folder;
}

function assertFolderNameAvailable(
  project: LinkProject,
  name: string,
  parentId: string | null,
  ignoredFolderId?: string
): void {
  const duplicate = project.mediaFolders.find((folder) => (
    folder.id !== ignoredFolderId
    && folder.parentId === parentId
    && folder.name.localeCompare(name, 'zh-CN', { sensitivity: 'accent' }) === 0
  ));
  if (duplicate) throw new Error(`同一层级已存在文件夹“${name}”`);
}

function requireCue(project: LinkProject, itemId: string, cueId: string): LinkCue {
  const cue = requireItem(project, itemId).cues.find((candidate) => candidate.id === cueId);
  if (!cue) throw new Error(`Cue 不存在：${cueId}`);
  return cue;
}

function assertInsertIndex(index: number, length: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index > length) throw new Error(`${label}插入位置越界：${index}`);
}

function assertExistingIndex(index: number, length: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) throw new Error(`${label}目标位置越界：${index}`);
}
