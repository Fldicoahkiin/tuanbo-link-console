
import { useLightingCueAudition } from './useLightingCueAudition';
import { Ma2PendingChanges } from './Ma2PendingChanges';
import { lightingEditHandler } from './lighting-edit-handler';
import { useStoppedRuntimeRecovery } from './useStoppedRuntimeRecovery';
import { LightingEffectDock } from './LightingEffectDock';
import { useLightingLibrarySplit } from './LightingLibrarySplitter';
import { useLightingEffectStamp } from './useLightingEffectStamp';
import { LightingProgramList } from './LightingWorkbenchPanel';
import '../lighting-workbench.css';
import '../lighting-workbench-appearance.css';
import { useAudioEditor } from './useAudioEditor';
import { AudioInspector } from './AudioInspector';
import { createPortal } from 'react-dom';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useEditorProgram, useEditorTransport } from './useEditorTransport';
import { useEffect, useMemo, useState } from 'react';
import {
  addMediaFolderCommand,
  moveMediaAssetCommand,
  moveMediaFolderCommand,
  moveVisualLayerCommand,
  removeVisualLayerCommand,
  removeMediaAssetCommand,
  removeMediaFolderCommand,
  renameMediaAssetCommand,
  renameMediaFolderCommand,
  resolveTimelineState,
  millisecondsToFrameNumber,
  LightingTempoMap,
  lightingEventTime,
  timecodeToMilliseconds,
  updateVisualLayerCommand,
  type LinkCommand
} from '@tb/core/link';
import { Clock3, FileVideo2, MonitorPlay, SlidersHorizontal, X, FolderInput, RefreshCw } from 'lucide-react';
import { type LightingDocument, type LinkProject } from '@tb/schema';
import { LightingTimelineTools, type LightingTool } from './LightingTimelineTools';
import { useRuntimeStore } from '../stores/runtime-store';
import { LightingTimelineInspector } from './LightingTimelineInspector';
import { useTimelinePlaybackClock } from './useTimelinePlaybackClock';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { ClipInspector } from './ClipInspector';
import { CommonProperties } from './CommonProperties';

import { CueInspector } from './CueInspector';
import { CueRundownHeader } from './CueRundownHeader';
import { ReferenceTimeline } from './ReferenceTimeline';

import { ResourceLibrary, type ObsResource } from './ResourceLibrary';
import { useAssetAvailability } from './useAssetAvailability';
import { useWorkspaceLayout } from './useWorkspaceLayout';
import { ReferenceStage } from './ReferenceStage';
import { sceneOutputAt } from '../runtime/scene-output-timeline';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { useReferenceAudioUrl, useLightingDocument } from './useCueWorkspaceSetup';
import { editableTimelineDuration } from './timeline-geometry';
import { createWorkspaceActions } from './workspace-actions';
import type { DocumentActionProps } from './DocumentActions';

type Props = {
  workspace?: 'visual' | 'lighting';
  player: ProjectPlayer;
  sidebarHost: HTMLDivElement | null;
  toolbarHost: HTMLDivElement | null;
  coordinator: LinkRuntimeCoordinator | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  documentActions: DocumentActionProps;
};

function useTimelineReferenceAudio(audio: LinkProject['rundown'][number]['referenceAudio'], projectPath: string | null, url: string | null) {
  return useMemo(() => audio && projectPath && url
    ? { projectPath, url, sha256: audio.sha256, durationMs: audio.durationMs }
    : null, [audio, projectPath, url]);
}

export function CueWorkspace({ workspace = 'visual', player, sidebarHost, toolbarHost, coordinator, notify, documentActions }: Props): JSX.Element {
  const lightingWorkspace = workspace === 'lighting';
  const librarySplit = useLightingLibrarySplit();
  const lowPower = useDisplayPreferences((state) => state.lowPower);
  const project = useDocumentStore((state) => state.project);
  const projectPath = useDocumentStore((state) => state.path);
  const documentId = useDocumentStore((state) => state.documentId);
  const execute = useDocumentStore((state) => state.execute);
  const revision = useDocumentStore((state) => state.revision);
  const currentItemId = useEditorProgram(player, project?.playbackSource === 'internal', notify);
  const inventory = useIntegrationStore((state) => state.inventory);
  const obs = useIntegrationStore((state) => state.obs);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedObsResource, setSelectedObsResource] = useState<ObsResource | null>(null);
  const externalTransport = project?.playbackSource === 'internal';
  const { playheadMs, playing, setPlayheadMs, setPlaying, reset, audioRef, stop, stopForEdit } = useEditorTransport(player, currentItemId, externalTransport, notify);
  const [lightingSelection, setLightingSelection] = useState<{ trackId: string; clipId: string | null; eventId?: string; eventIds?: string[] } | null>(null);
  const runtimeState = useRuntimeStore((state) => state.state);
  useStoppedRuntimeRecovery(externalTransport, player, runtimeState, coordinator, notify);
  const [lightingTool, setLightingTool] = useState<LightingTool | null>(null);
  const [lightingPreview, setLightingPreview] = useState(false);
  const [pointDetails, setPointDetails] = useState(false);
  const [cueSelectionVersion, setCueSelectionVersion] = useState(0);
  const showCommonProperties = (): void => { audioEditor.select(null); setLightingSelection(null); setSelectedCueId(null); setSelectedClipId(null); setLightingTool(null); setPointDetails(false); };
  const openLightingTool = (tool: LightingTool): void => { if (tool === 'tempo') showCommonProperties(); else { setPointDetails(false); setLightingTool(tool); } };
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const assetAvailability = useAssetAvailability(projectPath, project, notify);
  const workspaceLayout = useWorkspaceLayout(notify);
  const runCommand = createCommandRunner(execute, notify);
  const item = project?.rundown.find((candidate) => candidate.id === currentItemId) ?? null;
  const lightingDocument = useLightingDocument(item);
  const audioEditor = useAudioEditor(item, projectPath, playing || runtimeState !== 'idle' && !(externalTransport && player.state.status === 'paused' && runtimeState === 'paused'), notify, stopForEdit);
  const selectAudio = (id?: string): void => { setLightingSelection(null); setSelectedCueId(null); setSelectedClipId(null); audioEditor.select(id ?? audioEditor.selectedId ?? audioEditor.segments[0]?.id ?? null); };
  const audition = useLightingCueAudition(lightingDocument, project?.projectId, item, notify);
  const effectStamp = useLightingEffectStamp(item?.id ?? null, lightingDocument, item?.referenceAudio?.durationMs ?? 0, notify);
  const changeLighting = lightingEditHandler({ itemId: item?.id ?? null, project, notify });
  useEffect(() => { reset(); setSelectedCueId(null); setSelectedClipId(null); setLightingSelection(null); setLightingPreview(false); setLightingTool(null); }, [currentItemId, reset]);
  const cue = item?.cues.find((candidate) => candidate.id === selectedCueId) ?? null;
  const clip = item?.referenceMediaClips.find((candidate) => candidate.id === selectedClipId) ?? null;
  const selectedAsset = project?.mediaAssets.find((asset) => asset.id === (clip?.assetId ?? selectedAssetId)) ?? null;
  useEffect(() => { if (selectedCueId && !item?.cues.some((candidate) => candidate.id === selectedCueId)) setSelectedCueId(null); if (selectedClipId && !item?.referenceMediaClips.some((candidate) => candidate.id === selectedClipId)) setSelectedClipId(null); }, [item, selectedClipId, selectedCueId]);
  useReferenceAudioUrl({ item, projectPath, setAudioUrl, notify });

  const durationMs = useWorkspaceDuration(project, item, lightingDocument);
  useTimelinePlaybackClock({ playing: playing && !audioUrl && !externalTransport, playheadMs, durationMs, frameRate: project?.timebase.frameRate ?? '30', itemId: item?.id ?? null, onPlayheadChange: setPlayheadMs, onPlayingChange: setPlaying });
  const timelineReferenceAudio = useTimelineReferenceAudio(item?.referenceAudio, projectPath, audioUrl);
  const timelineState = useMemo(() => project && item ? resolveTimelineState(project, item, playheadMs) : null, [item, playheadMs, project]);
  const scenePreviewOutput = useMemo(() => obs.status === 'connected' ? null : resolveScenePreviewOutput(project, item?.id ?? null, playheadMs), [obs.status, project, item?.id, playheadMs]);
  if (!project) return <div className="empty-panel full"><Clock3 /><h3>尚未打开工程</h3><p>新建或打开工程后即可添加素材与 OBS 目标。</p></div>;
  const { importMedia, addAssetClip, addObsResource, moveClip, trimClip, trimCue, splitClip, duplicateClip, duplicateCue, transformClip, transformObs, moveCue, removeClip, removeCue, setClipEmbeddedAudioEnabled, refreshObs, testAction } = createWorkspaceActions({ project, projectPath, documentId, item, cue, playheadMs, coordinator, execute, notify, setSelectedCueId, setSelectedClipId, setSelectedAssetId, setSelectedObsResource });

  return <div className={`cue-studio${lightingWorkspace ? ' lighting-workbench' : ''}${lowPower ? ' low-power-workspace' : ''}`} data-inspector={true}>
    {!lightingWorkspace && item && lightingTool && lightingTool !== 'tempo' ? <LightingTimelineTools key={item.id} tool={lightingTool} document={lightingDocument} programName={item.title} disabled={playing || runtimeState !== 'idle'} notify={notify} onChange={changeLighting} onClose={() => setLightingTool(null)} /> : null}
    {toolbarHost ? createPortal(<CueRundownHeader item={item} notify={notify} documentActions={documentActions} />, toolbarHost) : null}
    <Ma2PendingChanges playing={playing || runtimeState !== 'idle'} onStop={stop} />
    <div className={`cue-studio-grid${lightingSelection ? ' has-lighting-editor' : ''}`} style={workspaceLayout.style}>
      {sidebarHost && lightingWorkspace ? createPortal(<LightingProgramList currentItemId={currentItemId} disabled={playing || runtimeState !== 'idle'} notify={notify} />, sidebarHost) : null}
      {sidebarHost && !lightingWorkspace ? createPortal(<ResourceLibrary
        folders={project.mediaFolders} assets={project.mediaAssets}
        assetAvailability={assetAvailability}
        projectPath={projectPath}
        inventory={inventory}
        obsStatus={obs.status}
        selectedAssetId={selectedAsset?.id ?? selectedAssetId}
        selectedObsResourceId={selectedObsResource?.id ?? null}
        onImport={(files, folderId) => void importMedia(files, folderId)}
        onAddFolder={(name, parentId) => { runCommand(addMediaFolderCommand({ id: crypto.randomUUID(), name, parentId })); }}
        onRenameFolder={(folderId, name) => { runCommand(renameMediaFolderCommand(folderId, name)); }}
        onMoveFolder={(folderId, parentId) => { runCommand(moveMediaFolderCommand(folderId, parentId)); }}
        onRemoveFolder={(folderId) => { runCommand(removeMediaFolderCommand(folderId)); }}
        onSelectAsset={(assetId) => { setSelectedAssetId(assetId); setSelectedClipId(null); setSelectedObsResource(null); }}
        onAddAssetToTimeline={(assetId) => addAssetClip(assetId, playheadMs)}
        onRenameAsset={(assetId, name) => {
          try { execute(renameMediaAssetCommand(assetId, name)); } catch (error) { notify(toMessage(error), 'error'); }
        }}
        onMoveAsset={(assetId, folderId) => {
          try { execute(moveMediaAssetCommand(assetId, folderId)); } catch (error) { notify(toMessage(error), 'error'); }
        }}
        onRemoveAsset={(assetId) => {
          if (runCommand(removeMediaAssetCommand(assetId)) && selectedAssetId === assetId) setSelectedAssetId(null);
        }}
        onRefreshObs={() => void refreshObs()}
        onAddObsResource={addObsResource}
        onSelectObsResource={setSelectedObsResource}
      />, sidebarHost) : null}
      <main className="timeline-workbench" style={lightingWorkspace ? librarySplit.style : undefined}>
        {lightingWorkspace ? librarySplit.separator : null}
        <div className="editor-preview-row">
          {!lowPower && !lightingWorkspace ? <><ReferenceStage
            scenePreview={scenePreviewOutput?.scene ?? null}
            sceneMode={project.obsOutputMode === 'scenes'} activeMediaClipId={scenePreviewOutput?.mediaClipId ?? null}
            itemTitle={item?.title ?? null} timelineState={timelineState} outputCanvas={project.obsOutputMode === 'scenes' && inventory?.videoSettings
              ? { width: inventory.videoSettings.baseWidth, height: inventory.videoSettings.baseHeight } : project.outputCanvas}
            selectedAsset={selectedAsset} selectedClipId={selectedClipId} selectedCueId={selectedCueId}
            projectPath={projectPath} obsStatus={obs.status} obsSceneCount={inventory?.scenes.length ?? 0}
            obsInputCount={inventory?.inputs.length ?? 0} obsInventory={inventory}
            playheadMs={playheadMs} playing={playing} mutePreviewAudio={externalTransport}
            onSelectClip={(id) => { setSelectedClipId(id); setSelectedCueId(null); }}
            onSelectCue={(id) => { setSelectedCueId(id); setSelectedClipId(null); }}
            onSelectObsResource={setSelectedObsResource} onTransformClip={transformClip}
            onMoveClipToTop={(id) => { const entry = item?.referenceMediaClips.find((value) => value.id === id); if (entry && item?.visualLayers[0]) moveClip(id, timecodeToMilliseconds(entry.startTimecode, project.timebase.frameRate), item.visualLayers[0].id); }}
            onRemoveClip={removeClip} onTransformObs={transformObs}
            onMoveObsToTop={(id) => { const entry = item?.cues.find((value) => value.id === id); if (entry && item?.visualLayers[0]) moveCue(id, timecodeToMilliseconds(entry.timecode, project.timebase.frameRate), item.visualLayers[0].id); }}
            onRemoveObs={removeCue} onDropObsResource={addObsResource} />{<button className="workspace-splitter vertical" aria-label="调整属性面板宽度" onPointerDown={(event) => workspaceLayout.beginResize('inspector', event)} onKeyDown={event => workspaceLayout.resizeWithKeyboard('inspector', event)} />}</> : null}

      {lightingSelection && !lightingWorkspace ? <aside className="cue-inspector panel"><div className="panel-title"><span>灯光属性</span><button onClick={showCommonProperties}>常用设置</button></div><div className="lighting-inspector-host"><label><input type="checkbox" aria-label="选中 Cue 实时播放" checked={audition.enabled} onChange={event => audition.setEnabled(event.currentTarget.checked)} />选中 Cue 实时播放</label><p role="status">{audition.enabled ? audition.status : '已关闭选中即播放'}</p>{lightingSelection ? <LightingTimelineInspector onOpenTools={openLightingTool} onError={(message) => notify(message, 'error')} preview={lightingPreview} onPreviewChange={setLightingPreview} document={lightingDocument} trackId={lightingSelection.trackId} selectedClipId={lightingSelection.clipId} selectedEventId={lightingSelection.eventId ?? null} selectedEventIds={lightingSelection.eventIds ?? []} onSelect={(trackId, clipId) => setLightingSelection({ trackId, clipId })} onChange={changeLighting} /> : null}</div></aside> : lightingWorkspace ? null : <aside className="cue-inspector panel" key={`${cue?.id ?? clip?.id ?? 'empty'}:${cue || clip ? revision : currentItemId}`}>
        <div className="panel-title"><span>{cue ? '画面与动作' : clip ? '媒体属性' : audioEditor.selected ? '音频属性' : '属性'}</span>{cue || clip || audioEditor.selected ? <button onClick={showCommonProperties}>常用设置</button> : null}</div>
        {cue && item ? <CueInspector itemId={item.id} cue={cue} frameRate={project.timebase.frameRate} inventory={inventory} execute={execute} testAction={testAction} /> : clip && item && selectedAsset ? <ClipInspector
          clip={clip} asset={selectedAsset}
          itemId={item.id} notify={notify}
          onTransform={(transform) => transformClip(clip.id, transform)}
          onEmbeddedAudioEnabled={(embeddedAudioEnabled) => setClipEmbeddedAudioEnabled(clip.id, embeddedAudioEnabled)}
          onRemove={() => removeClip(clip.id)}
        /> : lightingWorkspace || audioEditor.selected ? <AudioInspector editor={audioEditor} playheadMs={playheadMs} /> : item ? <CommonProperties key={item.id} item={item} document={lightingDocument} disabled={playing || runtimeState !== 'idle'} onChange={changeLighting} notify={notify} /> : <div className="inspector-empty"><FileVideo2 /><h3>先选择节目</h3></div>}
      </aside>}
        </div>
        {!lowPower && !lightingWorkspace ? <button className="workspace-splitter horizontal" aria-label="调整时间线高度" onPointerDown={(event) => workspaceLayout.beginResize('timeline', event)} onKeyDown={event => workspaceLayout.resizeWithKeyboard('timeline', event)} /> : null}
        {item && timelineState ? <ReferenceTimeline onEffectDrop={lightingWorkspace ? effectStamp.stamp : undefined} lightingWorkspace={lightingWorkspace}
          audioEditor={audioEditor} onSelectAudio={selectAudio} externalTransport={externalTransport} transportAudioRef={audioRef} onStop={stop}
          lighting={{ onAuditionEvent: audition.select, onOpenTools: openLightingTool, detailOpen: lightingTool !== null, onError: (message) => notify(message, 'error'), preview: lightingPreview, onPreviewChange: setLightingPreview, document: lightingDocument, selectedClipId: lightingSelection?.clipId ?? null, selectedEventId: lightingSelection?.eventId ?? null, selectedEventIds: lightingSelection?.eventIds ?? [], onSelectEvent: (trackId, clipId, eventId, eventIds) => { setSelectedClipId(null); setSelectedCueId(null); setLightingSelection({ trackId, clipId, eventId, eventIds: eventIds ?? [eventId] }); if (lightingWorkspace && (!eventIds || eventIds.length <= 1)) { setPointDetails(true); setLightingTool(null); setCueSelectionVersion(value => value + 1); } }, onSelect: (trackId, clipId) => { setSelectedClipId(null); setSelectedCueId(null); setLightingSelection({ trackId, clipId }); }, onChange: changeLighting }}
          projectPath={projectPath}
          assets={project.mediaAssets}
          clips={item.referenceMediaClips}
          cues={item.cues}
          layers={item.visualLayers}
          timelineState={timelineState}
          frameRate={project.timebase.frameRate}
          durationMs={durationMs}
          playheadMs={playheadMs}
          playing={playing}
          referenceAudio={timelineReferenceAudio}
          selectedClipId={selectedClipId} selectedCueId={selectedCueId}
          onPlayheadChange={setPlayheadMs}
          onPlayingChange={setPlaying}
          onPlaybackError={(message) => notify(`参考播放失败：${message}`, 'error')}
          onSelectClip={(clipId) => { setLightingSelection(null); setSelectedClipId(clipId); setSelectedCueId(null); }}
          onSelectCue={(cueId) => {
            setLightingSelection(null);
            setSelectedCueId(cueId);
            setSelectedClipId(null);
          }}
          onDropAsset={addAssetClip}
          onDropObsResource={addObsResource}
          onMoveClip={moveClip}
          onTrimClip={trimClip}
          onTrimCue={trimCue}
          onSetClipEmbeddedAudioEnabled={setClipEmbeddedAudioEnabled}
          onSplitClip={splitClip}
          onDuplicateClip={duplicateClip} onDuplicateCue={duplicateCue}
          onMoveCue={moveCue}
          onMoveLayer={(layerId, targetIndex) => { runCommand(moveVisualLayerCommand(item.id, layerId, targetIndex)); }}
          onUpdateLayer={(layer) => { runCommand(updateVisualLayerCommand(item.id, layer)); }}
          onDeleteLayer={(layerId) => { runCommand(removeVisualLayerCommand(item.id, layerId)); }}
          onDeleteClip={removeClip}
          onDeleteCue={removeCue}
        /> : <div className="empty-panel studio-empty"><MonitorPlay /><h3>先选择当前节目</h3><p>随后可把本地素材或 OBS 目标拖入时间线。</p></div>}
        {lightingWorkspace && item ? <LightingEffectDock pointDetails={pointDetails} cueSelectionVersion={cueSelectionVersion} onLibrary={() => { setLightingTool(null); setPointDetails(false); }} externalPanel={lightingTool && lightingTool !== 'tempo' ? <LightingTimelineTools inline tool={lightingTool} document={lightingDocument} programName={item.title} disabled={playing || runtimeState !== 'idle'} notify={notify} onChange={changeLighting} onClose={() => setLightingTool(null)} /> : null} headerActions={<div className="lighting-header-actions"><label className="lighting-output-choice"><span><input type="checkbox" aria-label="选中 Cue 实时播放" checked={audition.enabled} onChange={event => audition.setEnabled(event.currentTarget.checked)} />选中 Cue 实时播放</span><small role="status">{audition.enabled ? audition.status : '已关闭选中即播放'}</small></label>{lightingSelection?.eventId ? <><span>已选灯光点 · 点击效果可替换</span><button title="点位详情" aria-label="点位详情" aria-current={pointDetails ? 'page' : undefined} onClick={() => { setLightingTool(null); setPointDetails(!pointDetails); }}><SlidersHorizontal /><span>点位详情</span></button><button title="取消选择" aria-label="取消选择" onClick={showCommonProperties}><X /><span>取消选择</span></button></> : null}<button aria-current={lightingTool === 'files' ? 'page' : undefined} title="导入 / 导出" aria-label="导入 / 导出" onClick={() => openLightingTool('files')} disabled={playing || runtimeState !== 'idle'}><FolderInput /><span>导入与导出</span></button><button aria-current={lightingTool === 'sync' ? 'page' : undefined} title="MA2 同步" aria-label="MA2 同步" onClick={() => openLightingTool('sync')} disabled={playing || runtimeState !== 'idle'}><RefreshCw /><span>MA2 同步</span></button></div>} eventId={lightingSelection?.eventId} ms={playheadMs} durationMs={timelineReferenceAudio?.durationMs ?? 0} onNew={showCommonProperties} document={lightingDocument} disabled={false} onStamp={id => effectStamp.stamp(id, externalTransport && playing && audioRef.current ? audioRef.current.currentTime * 1000 : playheadMs, lightingSelection?.eventId)} onChange={changeLighting} /> : null}
      </main>

    </div>
  </div>;
}


function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function resolveScenePreviewOutput(project: LinkProject | null, itemId: string | null, playheadMs: number) {
  if (!project || !itemId || project.obsOutputMode !== 'scenes') return null;
  const output = sceneOutputAt(project, itemId, millisecondsToFrameNumber(playheadMs, project.timebase.frameRate));
  const cue = output.cues[0]?.cue;
  const action = cue?.actions.find((entry) => entry.kind === 'obs.setProgramScene');
  return { scene: cue && action?.kind === 'obs.setProgramScene' ? { cueId: cue.id, sceneName: action.sceneName } : null,
    mediaClipId: output.media[0]?.clipId ?? null };
}

function createCommandRunner(
  execute: ReturnType<typeof useDocumentStore.getState>['execute'],
  notify: Props['notify']
): (command: LinkCommand) => boolean {
  return (command) => {
    try {
      execute(command);
      return true;
    } catch (error) {
      notify(toMessage(error), 'error');
      return false;
    }
  };
}




function useWorkspaceDuration(project: LinkProject | null, item: import('@tb/schema').RundownItem | null, lightingDocument: LightingDocument): number {
  return useMemo(() => {
    if (!project || !item) return 60_000;
    const map = new LightingTempoMap(lightingDocument.tempos);
    return editableTimelineDuration({
      referenceAudioDurationMs: item.referenceAudio?.durationMs ?? 0,
      media: item.referenceMediaClips.map((candidate) => ({ startMs: timecodeToMilliseconds(candidate.startTimecode, project.timebase.frameRate), durationMs: candidate.durationMs, sourceOffsetMs: candidate.sourceOffsetMs ?? 0 })),
      cues: [...lightingDocument.markers.map((marker) => ({ startMs: marker.endMs ?? marker.startMs, durationMs: 0 })), ...item.cues.map((candidate) => ({ startMs: timecodeToMilliseconds(candidate.timecode, project.timebase.frameRate), durationMs: candidate.durationMs ?? 0 })), ...lightingDocument.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.events.map((event) => { const end = lightingEventTime(clip, event.kind === 'note' ? { ...event, at: event.at + event.duration } : event, map); return { startMs: end, durationMs: 0 }; })))]
    });
  }, [item, project, lightingDocument]);
}

