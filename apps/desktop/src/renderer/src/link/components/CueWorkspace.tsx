import { stopMa2Audition } from '../stores/ma2-audition-store';
import { LightingOutputControl } from './LightingOutputControl';
import { PlayerStatusDetails } from './PlayerStatusDetails';

import { useLightingCueAudition } from './useLightingCueAudition';
import { Ma2PendingChanges } from './Ma2PendingChanges';
import { lightingEditHandler } from './lighting-edit-handler';
import { useStoppedRuntimeRecovery } from './useStoppedRuntimeRecovery';
import { LightingEffectDock } from './LightingEffectDock';
import { useLightingLibrarySplit } from './LightingLibrarySplitter';
import { useLightingEffectStamp } from './useLightingEffectStamp';
import { useSongWaveformSource } from './ReferenceWaveform';
import '../lighting-workbench.css';
import '../lighting-workbench-appearance.css';
import { useAudioEditor } from './useAudioEditor';
import { AudioInspector } from './AudioInspector';
import { createPortal } from 'react-dom';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useEditorProgram, useEditorTransport } from './useEditorTransport';
import { useEffect, useMemo, useState } from 'react';
import { Button, Switch } from '../ui';
import './inspector.css';
import {
  addMediaFolderCommand,
  placeEmptyLightingCue,
  moveMediaAssetCommand,
  moveMediaFolderCommand,
  moveVisualLayerCommand,
  removeVisualLayerCommand,
  removeMediaAssetCommand,
  removeMediaFolderCommand,
  renameMediaAssetCommand,
  renameMediaFolderCommand,
  TimelineStateIndex,
  clipOfMaterialSource,
  LightingTempoMap,
  lightingEventTime,
  programTimeOrigin,
  timecodeToMilliseconds,
  updateVisualLayerCommand,
  type LinkCommand
} from '@tb/core/link';
import { Clock3, FileVideo2, MonitorPlay, FolderInput } from 'lucide-react';
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
import { useContentEditRules } from './ContentTracks';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { useReferenceAudioUrl, useLightingDocument } from './useCueWorkspaceSetup';
import { editableTimelineDuration } from './timeline-geometry';
import { useWorkspaceActions } from './workspace-actions';
import type { DocumentActionProps } from './DocumentActions';
import { PendingPictureNotice } from './PendingPictureNotice';
import { useSceneOutput } from './useSceneOutput';
import { ownKeys } from '../keys/key-owner';
import { useTimelineSegment } from './editor-playhead';

type Props = {
  workspace?: 'visual' | 'lighting';
  player: ProjectPlayer;
  /** The project the player plays from: LinkApp keeps it as it was when playback started, until 停止. */
  playbackProject: LinkProject | null;
  sidebarHost: HTMLDivElement | null;
  toolbarHost: HTMLDivElement | null;
  /** The sidebar place for the lighting workbench's console sync controls. */
  syncHost: HTMLDivElement | null;
  coordinator: LinkRuntimeCoordinator | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  documentActions: DocumentActionProps;
};

export function CueWorkspace({ workspace = 'visual', syncHost, player, playbackProject, sidebarHost, toolbarHost, coordinator, notify, documentActions }: Props): JSX.Element {
  const lightingWorkspace = workspace === 'lighting';
  const librarySplit = useLightingLibrarySplit();
  // Low power only unloads the video editor's preview; the lighting workbench keeps its full timeline layout.
  const lowPower = useDisplayPreferences((state) => state.lowPower) && !lightingWorkspace;
  const project = useDocumentStore((state) => state.project);
  const projectPath = useDocumentStore((state) => state.path);
  const documentId = useDocumentStore((state) => state.documentId);
  const execute = useDocumentStore((state) => state.execute);
  const currentItemId = useEditorProgram(player, project?.playbackSource === 'internal', notify);
  const item = project?.rundown.find((candidate) => candidate.id === currentItemId) ?? null;
  const audioUrl = useReferenceAudioUrl({ item, projectPath, notify });
  const inventory = useIntegrationStore((state) => state.inventory);
  const obs = useIntegrationStore((state) => state.obs);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedObsResource, setSelectedObsResource] = useState<ObsResource | null>(null);
  const externalTransport = project?.playbackSource === 'internal';
  const { playhead, playing, preparing, setPlayheadMs, setPlaying, reset, clock, stop, stopForEdit } = useEditorTransport(player, currentItemId, externalTransport, notify, lightingWorkspace ? null : coordinator, !item?.referenceAudio || Boolean(audioUrl));
  const [lightingSelection, setLightingSelection] = useState<{ trackId: string; clipId: string | null; eventId?: string; eventIds?: string[] } | null>(null);
  const runtimeState = useRuntimeStore((state) => state.state);
  useStoppedRuntimeRecovery(externalTransport, player, runtimeState, coordinator, notify);
  const [lightingTool, setLightingTool] = useState<LightingTool | null>(null);
  const [lightingPreview, setLightingPreview] = useState(false);
  const [pointDetails, setPointDetails] = useState(false); const { open: analysisOpen, setOpen: setAnalysisOpen, host: analysisHost, setHost: setAnalysisHost, show: openMusic } = useMusicPanel(lightingWorkspace, Boolean(selectedCueId || selectedClipId), () => setLightingTool(null), () => { setLightingSelection(null); setSelectedCueId(null); setSelectedClipId(null); audioEditor.select(null); });
  const [cueSelectionVersion, setCueSelectionVersion] = useState(0);
  const showCommonProperties = (): void => { setAnalysisOpen(false); audioEditor.select(null); setLightingSelection(null); setSelectedCueId(null); setSelectedClipId(null); setLightingTool(null); setPointDetails(false); };
  const openLightingTool = (tool: LightingTool): void => { if (tool === 'tempo') showCommonProperties(); else { setPointDetails(false); setLightingTool(tool); } };
  const assetAvailability = useAssetAvailability(projectPath, project, notify);
  const workspaceLayout = useWorkspaceLayout(notify);
  const runCommand = createCommandRunner(execute, notify);
  const lightingDocument = useLightingDocument(item);
  const audioEditor = useAudioEditor(item, projectPath, playing || runtimeState !== 'idle' && !(externalTransport && player.state.status === 'paused' && runtimeState === 'paused'), notify, stopForEdit);
  const selectAudio = (id?: string): void => { setAnalysisOpen(false); setLightingSelection(null); setSelectedCueId(null); setSelectedClipId(null); audioEditor.select(id ?? audioEditor.selectedId ?? audioEditor.segments[0]?.id ?? null); };
  const audition = useLightingCueAudition(lightingDocument, project?.projectId, item, notify);
  const effectStamp = useLightingEffectStamp(item?.id ?? null, lightingDocument, item?.referenceAudio?.durationMs ?? 0, notify);
  const changeLighting = lightingEditHandler({ itemId: item?.id ?? null, project, notify });
  const selectCreatedCue = (document: LightingDocument, id: string): void => { const selection = cueSelection(document, id); if (!selection) return; showCommonProperties(); setLightingSelection(selection); setPointDetails(true); };
  useEffect(() => { setAnalysisOpen(false); reset(); setSelectedCueId(null); setSelectedClipId(null); setLightingSelection(null); setLightingPreview(false); setLightingTool(null); }, [currentItemId, documentId, item?.referenceAudio?.relativePath, item?.referenceAudio?.sha256, reset, setAnalysisOpen]);
  const cue = item?.cues.find((candidate) => candidate.id === selectedCueId) ?? null;
  const clip = item?.referenceMediaClips.find((candidate) => candidate.id === selectedClipId) ?? null;
  const selectedAsset = project?.mediaAssets.find((asset) => asset.id === (clip?.assetId ?? selectedAssetId)) ?? null;
  useEffect(() => { if (selectedCueId && !item?.cues.some((candidate) => candidate.id === selectedCueId)) setSelectedCueId(null); if (selectedClipId && !item?.referenceMediaClips.some((candidate) => candidate.id === selectedClipId)) setSelectedClipId(null); }, [item, selectedClipId, selectedCueId]);

  const durationMs = useWorkspaceDuration(project, item, lightingDocument);
  useTimelinePlaybackClock({ playing: playing && !item?.referenceAudio && !externalTransport, playhead, durationMs, frameRate: project?.timebase.frameRate ?? '30', itemId: item?.id ?? null, onPlayheadChange: setPlayheadMs, onPlayingChange: setPlaying });
  const timelineReferenceAudio = useSongWaveformSource(item?.referenceAudio, projectPath, audioUrl);
  const timelineIndex = useMemo(() => project && item ? new TimelineStateIndex(project, item) : null, [item, project]);
  // Worked out again only when the playhead crosses a clip's or camera's start or end, not every frame (0.5.9 E2).
  const timelineState = useTimelineSegment(playhead, timelineIndex);
  const sceneOutput = useSceneOutput(project, lightingWorkspace ? null : item?.id ?? null, playhead, obs.status === 'connected', player, playbackProject);
  const scenePreviewOutput = sceneOutput.preview;
  const workspaceActions = useWorkspaceActions({ project, projectPath, documentId, item, cue, playhead, coordinator, execute, notify, setSelectedCueId, setSelectedClipId, setSelectedAssetId, setSelectedObsResource }), editRules = useContentEditRules(project, item);
  if (!project || !workspaceActions) return <div className="empty-panel full"><Clock3 /><h3>还没打开工程</h3><p>新建或打开工程后，就可以添加素材和 OBS 场景、来源。</p></div>;
  const { importMedia, addAssetClip, addObsResource, moveClip, moveClipToTop, trim, splitClip, duplicateClip, pasteClip, duplicateCue, transformClip, sendClipLookToObs, keepObsClipLook, moveCue, removeClip, removeCue, setClipEmbeddedAudioEnabled, refreshObs, testAction } = workspaceActions;

  return <div className={`cue-studio${lightingWorkspace ? ' lighting-workbench' : ''}${lowPower ? ' low-power-workspace' : ''}`} data-inspector={true}>
    {!lightingWorkspace && item && lightingTool && lightingTool !== 'tempo' ? <LightingTimelineTools key={item.id} tool={lightingTool} document={lightingDocument} programName={item.title} disabled={playing || runtimeState !== 'idle'} notify={notify} onChange={changeLighting} onClose={() => setLightingTool(null)} /> : null}
    {toolbarHost ? createPortal(<CueRundownHeader item={item} notify={notify} documentActions={documentActions} />, toolbarHost) : null}
    {lightingWorkspace && syncHost ? createPortal(<Ma2PendingChanges notify={notify} />, syncHost) : null}
    <div className={`cue-studio-grid${lightingSelection ? ' has-lighting-editor' : ''}`} style={workspaceLayout.style}>
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
        onAddAssetToTimeline={(assetId) => addAssetClip(assetId, playhead.read())}
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
            activeMediaClipIds={scenePreviewOutput?.mediaClipIds ?? null}
            itemTitle={item?.title ?? null} timelineState={timelineState} outputCanvas={inventory?.videoSettings
              ? { width: inventory.videoSettings.baseWidth, height: inventory.videoSettings.baseHeight } : project.outputCanvas}
            selectedAsset={selectedAsset} selectedClipId={selectedClipId} selectedCueId={selectedCueId}
            projectPath={projectPath} obsStatus={obs.status} obsSceneCount={inventory?.scenes.length ?? 0}
            obsInputCount={inventory?.inputs.length ?? 0} obsInventory={inventory}
            playhead={playhead} playing={playing} mutePreviewAudio={externalTransport}
            onSelectClip={(id) => { setSelectedClipId(id); setSelectedCueId(null); }}
            onSelectCue={(id) => { setSelectedCueId(id); setSelectedClipId(null); }}
            onSelectObsResource={setSelectedObsResource} onTransformClip={transformClip}
            materialClipOf={item ? (sourceName, at) => clipOfMaterialSource(project, item.id, sourceName, selectedClipId, at) : undefined} onMoveClipToTop={moveClipToTop}
            onRemoveClip={removeClip} onDropObsResource={addObsResource} />{<button className="workspace-splitter vertical" aria-label="调整属性面板宽度" {...ownKeys('ArrowLeft', 'ArrowRight')} onPointerDown={(event) => workspaceLayout.beginResize('inspector', event)} onKeyDown={event => workspaceLayout.resizeWithKeyboard('inspector', event)} />}</> : null}

      {lightingSelection && !lightingWorkspace ? <aside className="cue-inspector panel"><div className="panel-title"><span>灯光属性</span><Button variant="ghost" size="sm" onClick={showCommonProperties}>常用设置</Button></div><div className="lighting-inspector-host"><Switch className="lighting-audition-switch" label="选中 Cue 实时播放" aria-label="选中 Cue 实时播放" help={audition.enabled ? audition.status : '已关闭选中即播放'} checked={audition.enabled} onChange={event => audition.setEnabled(event.currentTarget.checked)} />{lightingSelection ? <LightingTimelineInspector onOpenTools={openLightingTool} onError={(message) => notify(message, 'error')} preview={lightingPreview} onPreviewChange={setLightingPreview} document={lightingDocument} trackId={lightingSelection.trackId} selectedClipId={lightingSelection.clipId} selectedEventId={lightingSelection.eventId ?? null} selectedEventIds={lightingSelection.eventIds ?? []} onSelect={(trackId, clipId) => setLightingSelection({ trackId, clipId })} onChange={changeLighting} /> : null}</div></aside> : lightingWorkspace ? null : <aside className="cue-inspector panel" key={cue ? `cue:${cue.id}` : clip ? `clip:${clip.id}` : `empty:${currentItemId}`}>
        <div className="panel-title"><span>{cue ? '画面与动作' : clip ? '媒体属性' : analysisOpen ? '音乐识别' : audioEditor.selected ? '音频属性' : '属性'}</span>{cue || clip || analysisOpen || audioEditor.selected ?<Button variant="ghost" size="sm" onClick={showCommonProperties}>常用设置</Button> : null}</div>
        {cue && item ? <CueInspector itemId={item.id} cue={cue} frameRate={project.timebase.frameRate} inventory={inventory} execute={execute} testAction={testAction} /> : clip && item && selectedAsset ? <ClipInspector
          clip={clip} asset={selectedAsset}
          itemId={item.id} notify={notify}
          onTransform={(transform) => transformClip(clip.id, transform)} onSendLookToObs={() => sendClipLookToObs(clip.id)} onUseObsLook={() => keepObsClipLook(clip.id)}
          onEmbeddedAudioEnabled={(embeddedAudioEnabled) => setClipEmbeddedAudioEnabled(clip.id, embeddedAudioEnabled)}
          onRemove={() => removeClip(clip.id)}
        /> : analysisOpen ? <div className="music-analysis-host" ref={setAnalysisHost} /> : audioEditor.selected ? <AudioInspector editor={audioEditor} playhead={playhead} onRecognise={openMusic} /> : item ? <CommonProperties key={item.id} item={item} document={lightingDocument} disabled={playing || runtimeState !== 'idle'} onChange={changeLighting} notify={notify} /> : <div className="inspector-empty"><FileVideo2 /><h3>先选择节目</h3></div>}
      </aside>}
        </div>
        {!lowPower && !lightingWorkspace ? <button className="workspace-splitter horizontal" aria-label="调整时间线高度" {...ownKeys('ArrowUp', 'ArrowDown')} onPointerDown={(event) => workspaceLayout.beginResize('timeline', event)} onKeyDown={event => workspaceLayout.resizeWithKeyboard('timeline', event)} /> : null}
        {item && timelineState && editRules ? <ReferenceTimeline analysisPanel={{ host: analysisHost, open: analysisOpen, onOpen: openMusic, onClose: () => setAnalysisOpen(false) }} outputControl={lightingWorkspace ? <>{project ? <LightingOutputControl project={project} item={item} /> : null}{externalTransport && (player.state.notice || player.state.error || player.state.fault) ? <PlayerStatusDetails error={player.state.error} errorTitle={player.state.errorTitle} notice={player.state.notice} fault={player.state.fault ?? null} engine={player.engine} /> : null}</> : undefined} transportStatus={lightingWorkspace ? undefined : <PendingPictureNotice notice={sceneOutput.marks.notice} />} onEffectDrop={lightingWorkspace ? effectStamp.stamp : undefined} onConsoleCueDrop={lightingWorkspace ? effectStamp.stampConsoleCue : undefined} lightingWorkspace={lightingWorkspace}
          audioEditor={audioEditor} onSelectAudio={selectAudio} externalTransport={externalTransport} transportClock={clock} onStop={()=>{stop();void stopMa2Audition().catch((error:unknown)=>notify(error instanceof Error?error.message:String(error),'error'));}} onDeselect={() => { audioEditor.select(null); setLightingSelection(null); setSelectedCueId(null); setSelectedClipId(null); setPointDetails(false); }} onHint={(message, tone = 'info') => notify(message, tone)}
          lighting={{ onCreateCue: lightingWorkspace ? ms => { const id = crypto.randomUUID(); const next = placeEmptyLightingCue(lightingDocument, id, ms, item.referenceAudio?.durationMs ?? 0); if (!changeLighting(next, '添加空 Cue')) return; selectCreatedCue(next, id); } : undefined, onClearSelection: () => { setLightingSelection(null); setPointDetails(false); }, onAuditionEvent: audition.select, onOpenTools: openLightingTool, detailOpen: lightingTool !== null, onError: (message) => notify(message, 'error'), preview: lightingPreview, onPreviewChange: setLightingPreview, mtcOrigin: () => programTimeOrigin(item), document: lightingDocument, selectedClipId: lightingSelection?.clipId ?? null, selectedEventId: lightingSelection?.eventId ?? null, selectedEventIds: lightingSelection?.eventIds ?? [], onSelectEvent: (trackId, clipId, eventId, eventIds) => { setAnalysisOpen(false); setSelectedClipId(null); setSelectedCueId(null); setLightingSelection({ trackId, clipId, eventId, eventIds: eventIds ?? [eventId] }); if (lightingWorkspace && (!eventIds || eventIds.length <= 1)) { setPointDetails(true); setLightingTool(null); setCueSelectionVersion(value => value + 1); } }, onSelect: (trackId, clipId) => { setSelectedClipId(null); setSelectedCueId(null); setLightingSelection({ trackId, clipId }); }, onChange: changeLighting }}
          projectPath={projectPath}
          assets={project.mediaAssets}
          clips={item.referenceMediaClips}
          cues={item.cues}
          layers={item.visualLayers}
          timelineState={timelineState}
          airtime={sceneOutput.airtime} onAirtime={sceneOutput.marks.onAirtime} pending={sceneOutput.marks.pending.changed}
          editRules={editRules}
          frameRate={project.timebase.frameRate}
          durationMs={durationMs}
          playhead={playhead}
          playing={playing} preparing={preparing}
          referenceAudio={timelineReferenceAudio} musicItem={item}
          selectedClipId={selectedClipId} selectedCueId={selectedCueId}
          onPlayheadChange={setPlayheadMs}
          onPlayingChange={setPlaying}
          onPlaybackError={(message) => notify(`试听失败：${message}`, 'error')}
          onSelectClip={(clipId) => { setLightingSelection(null); setSelectedClipId(clipId); setSelectedCueId(null); }}
          onSelectCue={(cueId) => {
            setLightingSelection(null);
            setSelectedCueId(cueId);
            setSelectedClipId(null);
          }}
          onDropAsset={addAssetClip}
          onDropObsResource={addObsResource}
          onMoveClip={moveClip}
          onTrim={trim}
          onSetClipEmbeddedAudioEnabled={setClipEmbeddedAudioEnabled}
          onSplitClip={splitClip}
          onDuplicateClip={duplicateClip} onPasteClip={pasteClip} onDuplicateCue={duplicateCue}
          onMoveCue={moveCue}
          onMoveLayer={(layerId, targetIndex) => { runCommand(moveVisualLayerCommand(item.id, layerId, targetIndex)); }}
          onUpdateLayer={(layer) => { runCommand(updateVisualLayerCommand(item.id, layer)); }}
          onDeleteLayer={(layerId) => { runCommand(removeVisualLayerCommand(item.id, layerId)); }}
          onDeleteClip={removeClip}
          onDeleteCue={removeCue}
        /> : <div className="empty-panel studio-empty"><MonitorPlay /><h3>先选择当前节目</h3><p>然后把本地素材或 OBS 场景、来源拖到时间线上。</p></div>}
        {lightingWorkspace && item ? <LightingEffectDock itemId={item.id} onCreated={selectCreatedCue} onAuditionTemplate={audition.selectTemplate} auditionStatus={audition.enabled ? audition.status : '已关闭选中即播放'} sidebarHost={sidebarHost} key={item.id} pointDetails={pointDetails} cueSelectionVersion={cueSelectionVersion} onLibrary={() => { setAnalysisOpen(false); setLightingTool(null); setPointDetails(false); }} externalPanel={analysisOpen ? <div className="music-analysis-host" ref={setAnalysisHost} /> : lightingTool && lightingTool !== 'tempo' ? <LightingTimelineTools inline tool={lightingTool} document={lightingDocument} programName={item.title} disabled={playing || runtimeState !== 'idle'} notify={notify} onChange={changeLighting} onClose={() => setLightingTool(null)} /> : null} playbackSettings={<Switch className="lighting-audition-switch" label="时间线选中 Cue 试听" aria-label="选中 Cue 实时播放" help={audition.enabled ? audition.status : '已关闭选中即播放'} checked={audition.enabled} onChange={event => audition.setEnabled(event.currentTarget.checked)} />} headerActions={<Button variant="ghost" size="sm" icon={FolderInput} aria-pressed={lightingTool === 'files'} aria-label="导入 / 导出" onClick={() => openLightingTool('files')} disabled={playing || runtimeState !== 'idle'}>导入与导出</Button>} eventId={lightingSelection?.eventId} playhead={playhead} durationMs={timelineReferenceAudio?.durationMs ?? 0} onNew={showCommonProperties} document={lightingDocument} disabled={false} onStamp={id => effectStamp.stamp(id, externalTransport && playing && clock?.read().ready ? clock.read().positionMs : playhead.read())} onChange={changeLighting} notify={notify} /> : null}
      </main>

    </div>
  </div>;
}


function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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


function cueSelection(document: LightingDocument, id: string): { trackId: string; clipId: string; eventId: string } | null {
  for (const track of document.tracks) for (const clip of track.clips) {
    if (clip.events.some(event => event.id === id)) return { trackId: track.id, clipId: clip.id, eventId: id };
  }
  return null;
}

/**
 * The song's music panel (音乐识别, 0.5.9 E11): beside the library on the lighting workbench; in the editor in place of
 * the properties, until a part of the timeline is chosen. `show` opens it; in the editor it also clears the selection.
 */
function useMusicPanel(lightingWorkspace: boolean, partSelected: boolean, closeTools: () => void, clearEditorSelection: () => void) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { if (!lightingWorkspace && partSelected) setOpen(false); }, [lightingWorkspace, partSelected]);
  const show = (): void => { closeTools(); if (!lightingWorkspace) clearEditorSelection(); setOpen(true); };
  return { open, setOpen, host, setHost, show };
}
