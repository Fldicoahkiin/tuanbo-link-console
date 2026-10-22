import { useProgramSelection } from './useProgramSelection';
import { Button } from './Button';
import { importProgramFiles } from './import-program-files';
import { useSelectedProgram } from '../useSelectedProgram';
import { usePlayProgram } from './usePlayProgram';
import { ProjectPlaybackMonitor } from './ProjectPlaybackMonitor';
import { ProgramGrid } from './ProgramGrid';
import { SongPlaybackProperties } from './SongPlaybackProperties';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, Check, Copy,
  FileAudio, FilePlus2, FileSearch, FolderOpen,
  Search, List, LayoutGrid, Plus, X,
  SlidersHorizontal,
  Trash2,
  Music2,
  Film, Lightbulb
} from 'lucide-react';
import {
  addRundownItemCommand,
  playlistItems,
  programPlaylists,
  programPlaylistId,
  editProgramPlaylistCommand,
  allocateMediaTimecodeRanges,
  programTimeOrigin,
  duplicateRundownItemCommand,
  moveRundownItemCommand,
  removeRundownItemCommand,
  setReferenceAudioCommand,
  updateRundownItemCommand
} from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useIntegrationStore } from '../stores/integration-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { linkDesktopViewModel, linkFileViewModel } from '../view-models/link-desktop-view-model';
import { DocumentActions, type DocumentActionProps } from './DocumentActions';

import { ProjectWelcome } from './ProjectWelcome';
import { ProgramPlaylistPane } from './ProgramPlaylistPane';
import { type ProjectPlayer } from './ProjectPlayerControls';
import { formatDuration } from './media-utils';
import { MissingAssetsDialog } from './MissingAssetsDialog';

type Props = {
  toolbarHost: HTMLDivElement | null;
  playlistHost: HTMLDivElement | null;
  onCreate: () => void;
  onOpen: () => void;
  onImportSongs: () => void;
  player: ProjectPlayer;
  editingLocked: boolean;
  coordinator: LinkRuntimeCoordinator | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onOpenCueEditor: () => void;
  documentActions: DocumentActionProps;
};

export function ProjectWorkspace({ toolbarHost, playlistHost, onCreate, onOpen, onImportSongs, player, editingLocked, coordinator, notify, onOpenCueEditor, documentActions }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const projectPath = useDocumentStore((state) => state.path);
  const documentId = useDocumentStore((state) => state.documentId);
  const execute = useDocumentStore((state) => state.execute);
  const revision = useDocumentStore((state) => state.revision);
  const currentItemId = useRuntimeStore((state) => state.currentItemId);
  const [busy, setBusy] = useState(false);
  const [missingAssetsRequest, setMissingAssetsRequest] = useState(0);
  const importPending = useRef(false);
  const locked = editingLocked || busy;
  const internal = project?.playbackSource === 'internal';
  const fileInput = useRef<HTMLInputElement>(null);
  const [audioTargetId, setAudioTargetId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useSelectedProgram(notify);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('all');
  const playProgram = usePlayProgram(player, busy, setBusy, selectedPlaylistId, setSelectedItemId, notify);
  const [search, setSearch] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => { if (project && !['all', 'unassigned'].includes(selectedPlaylistId) && !programPlaylists(project).some((list) => list.id === selectedPlaylistId)) setSelectedPlaylistId('all'); }, [project, selectedPlaylistId]);
  useEffect(() => {
    setAudioTargetId(null);
    if (fileInput.current) fileInput.current.value = '';
  }, [documentId]);


  useEffect(() => { if (player.state.playlistId) setSelectedPlaylistId(player.state.playlistId); }, [player.state.playlistId]);
  useEffect(() => { if (internal && currentItemId) setSelectedItemId(currentItemId); }, [internal, currentItemId, setSelectedItemId]);
  const selectedItem = project?.rundown.find((item) => item.id === selectedItemId) ?? null; const selectedReferencePath = selectedItem?.referenceAudio?.relativePath ?? null;
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    if (!projectPath || !selectedReferencePath) return;
    void linkDesktopViewModel.resolveReferenceAudioUrl({
      projectPath,
      relativePath: selectedReferencePath
    }).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    }).catch((error: unknown) => {
      if (!cancelled) notify(error instanceof Error ? error.message : String(error), 'error');
    });
    return () => { cancelled = true; };
  }, [notify, projectPath, selectedReferencePath]);

  const filteredItems = useMemo(() => {
    if (!project) return [];
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return playlistItems(project, selectedPlaylistId).filter((item) => keyword === '' || item.title.toLocaleLowerCase('zh-CN').includes(keyword));
  }, [project, search, selectedPlaylistId]);

  if (!project) return <ProjectWelcome onCreate={onCreate} onOpen={onOpen} onImportSongs={onImportSongs} />;
  const addItem = (): void => {
    const item: RundownItem = {
      id: crypto.randomUUID(),
      ...(programPlaylists(project).some((list) => list.id === selectedPlaylistId) ? { playlistId: selectedPlaylistId } : {}),
      title: `节目 ${project.rundown.length + 1}`,
      enabled: true,
      notes: '',
      visualLayers: [{ id: crypto.randomUUID(), name: '图层 2', visible: true, locked: false }, { id: crypto.randomUUID(), name: '图层 1', visible: true, locked: false }],
      referenceMediaClips: [],
      cues: []
    };
    execute(addRundownItemCommand(item));
    setSelectedItemId(item.id);
  };

  const chooseReference = (itemId: string): void => {
    if (!projectPath) {
      notify('请先保存工程，再导入参考音频。', 'error');
      return;
    }
    setAudioTargetId(itemId);
    fileInput.current?.click();
  };
  const importReference = async (file: File): Promise<void> => {
    if (!audioTargetId || !projectPath) return;
    try {
      await importReferenceForDocument(file, audioTargetId, projectPath, documentId);
      notify('参考音频已按 SHA-256 导入工程。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setAudioTargetId(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };


  const selectCurrentItem = (item: RundownItem): void => {
    if (!item.enabled) return;
    coordinator?.selectItem(item.id);
    setSelectedItemId(item.id);
  };


  return (
    <div className="p1-project-workspace">
      <MissingAssetsDialog request={missingAssetsRequest} locked={locked} notify={notify} />
      {toolbarHost ? createPortal(<header className="p1-project-ribbon" title={projectPath ?? undefined}>
        <details className="project-file-menu"><summary aria-label="工程菜单" title="工程 · 打开或新建"><FolderOpen /></summary><div className="project-file-menu-items"><button disabled={locked} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onOpen(); }}><FolderOpen />打开工程</button><button disabled={locked} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreate(); }}><FilePlus2 />新建独立工程</button><button disabled={locked || !projectPath} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setMissingAssetsRequest((request) => request + 1); }}><FileSearch />找回缺失素材</button></div></details>
        <strong className="topbar-project-title" aria-label="当前工程">{project.name}</strong>
        <div className="toolbar-drag-space" />
        <fieldset className="p1-project-actions" disabled={locked}>
          <DocumentActions {...documentActions} />
        </fieldset>
      </header>, toolbarHost) : null}

      <input ref={fileInput} hidden type="file" accept="audio/*,video/mp4,.wav,.mp3,.flac,.m4a,.aac,.ogg,.mp4" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void importReference(file);
      }} />

      <ProjectPlaybackMonitor project={project} player={player} selectedItem={selectedItem} currentItemId={currentItemId} projectPath={projectPath} previewUrl={previewUrl} busy={busy} visible={toolbarHost !== null} />

      <ProjectLibrary
        onImportSongs={onImportSongs}
        onImportFiles={async files => {
          if (locked || importPending.current) return;
          importPending.current = true; setBusy(true);
          try { await importProgramFiles(files, selectedPlaylistId, notify); setSearch(''); }
          finally { importPending.current = false; setBusy(false); }
        }}
        onAddItem={addItem}
        playedItemIds={player.state.playedItemIds}
        playlistHost={playlistHost}
        notify={notify}
        locked={locked}
        metadataLocked={locked && (busy || !internal || player.state.status !== 'paused')}
        playItem={internal ? playProgram : undefined}
        project={project}
        revision={revision}
        filteredItems={filteredItems}
        selectedItem={selectedItem}
        selectedItemId={selectedItemId}
        selectedPlaylistId={selectedPlaylistId}
        search={search}
        currentItemId={currentItemId}
        onSelectPlaylist={(id) => { setSelectedPlaylistId(id); if (internal && player.state.status === 'stopped') player.controller?.setPlaylist(id); }}
        onSearch={setSearch}
        onChooseItem={(item) => setSelectedItemId(item.id)}
        onChooseReference={chooseReference}
        onOpenCueEditor={onOpenCueEditor}
        onSelectCurrentItem={selectCurrentItem}
      />
    </div>
  );
}

async function importReferenceForDocument(
  file: File,
  itemId: string,
  projectPath: string,
  documentId: number
): Promise<void> {
  const durationMs = await readAudioDuration(file);
  const reference = await linkDesktopViewModel.importReferenceAudio({
    projectPath,
    sourcePath: linkFileViewModel.getPathForFile(file),
    durationMs
  });
  useDocumentStore.getState().executeForDocument(documentId, setReferenceAudioCommand(itemId, reference));
}

type ProjectLibraryProps = Pick<Props, 'onImportSongs' | 'onOpenCueEditor'> & {
  onImportFiles: (files: File[]) => Promise<void>;
  onAddItem: () => void;
  playedItemIds: string[];
  playlistHost: HTMLDivElement | null;
  notify: Props['notify'];
  locked: boolean;
  metadataLocked: boolean;
  playItem?: ((item: RundownItem) => void) | undefined;
  project: LinkProject;
  revision: number;
  filteredItems: RundownItem[];
  selectedItem: RundownItem | null;
  selectedItemId: string | null;
  selectedPlaylistId: string;
  search: string;
  currentItemId: string | null;
  onSelectPlaylist: (playlistId: string) => void;
  onSearch: (search: string) => void;
  onChooseItem: (item: RundownItem) => void;
  onChooseReference: (itemId: string) => void;
  onSelectCurrentItem: (item: RundownItem) => void;
};

function ProjectLibrary(props: ProjectLibraryProps): JSX.Element {

  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [view, setView] = useState<'list' | 'cards'>('cards');
  const execute = useDocumentStore((state) => state.execute);
  const runtime = useRuntimeStore((state) => state.state);
  const doubleClickPlayback = useIntegrationStore((state) => state.profile?.internalPlayer?.doubleClickPlayback ?? false);
  const [context, setContext] = useState<{ item: RundownItem; x: number; y: number } | null>(null);
  const { project, revision, filteredItems, selectedItem, selectedItemId, selectedPlaylistId, search, currentItemId } = props;
  const { selected: visibleBatchIds, setSelectedIds: setBatchIds, deleteSelection } = useProgramSelection({ visibleIds: filteredItems.map(item => item.id), scope: JSON.stringify([project.projectId, search, selectedPlaylistId]), locked: props.locked, notify: props.notify });
  const commitText = (input: HTMLInputElement | HTMLTextAreaElement, field: 'title' | 'notes'): void => {
    if (!selectedItem || props.metadataLocked) return;
    const value = field === 'title' ? input.value.trim() : input.value;
    input.value = value;
    if (value === selectedItem[field]) return;
    try {
      execute(updateRundownItemCommand(selectedItem.id, { title: selectedItem.title, enabled: selectedItem.enabled, notes: selectedItem.notes, [field]: value }));
    } catch (error) {
      input.value = selectedItem[field];
      const message = error instanceof Error ? error.message : String(error);
      input.setCustomValidity(message);
      input.reportValidity();
      props.notify(message, 'error');
    }
  };
  useEffect(() => {
    if (!context) return;
    const close = (): void => setContext(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [context]);
  return <section className="p1-library-workbench" data-inspector={inspectorOpen}>
    {props.playlistHost ? createPortal(<ProgramPlaylistPane project={project} selectedId={selectedPlaylistId} locked={props.locked} onSelect={props.onSelectPlaylist} notify={props.notify} />, props.playlistHost) : null}

    <section className="p1-media-pane">
      <div className="p1-pane-title"><div className="program-library-heading"><strong>节目单 <small>{filteredItems.length} 个</small></strong><span>{selectedPlaylistId === 'all' ? '全部节目' : programPlaylists(project).find(list => list.id === selectedPlaylistId)?.name ?? '未分组'} · {props.playItem ? doubleClickPlayback ? '双击节目播放' : '单击节目播放' : '选择节目进行联动'}</span></div><label><Search /><input aria-label="搜索节目" placeholder="搜索节目…" value={search} onChange={(event) => props.onSearch(event.currentTarget.value)} /></label><div className="program-view-switch" role="group" aria-label="节目显示方式"><Button className="icon-button" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setView('list')}><List /></Button><Button className="icon-button" aria-label="卡片视图" aria-pressed={view === 'cards'} onClick={() => setView('cards')}><LayoutGrid /></Button></div><Button className="secondary-button" disabled={props.locked} onClick={props.onImportSongs}><FileAudio />导入歌曲 / P1</Button><Button className="secondary-button" disabled={props.locked} onClick={props.onAddItem}><Plus />新建节目</Button><Button className="icon-button" title="节目属性" aria-label="节目属性" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}><SlidersHorizontal /></Button></div>
      {view === 'list' ? <div className="program-list-columns" aria-hidden="true"><span>顺序</span><span>节目名称</span><span>状态</span><span>时长 / 内容</span><span>属性</span></div> : null}
      <ProgramGrid view={view} compact={inspectorOpen} itemIds={filteredItems.map(item => item.id)} locked={props.locked} onAddItem={props.onAddItem} onImportFiles={props.onImportFiles} selectedIds={visibleBatchIds} onSelectionChange={setBatchIds} onDeleteSelection={deleteSelection} onBlankClick={() => setInspectorOpen(false)}
        empty={<div className="p1-library-empty"><FileAudio /><strong>{search ? '没有找到匹配的节目' : '添加第一个节目'}</strong></div>}
        renderItem={visibleIndex => {
          const item = filteredItems[visibleIndex]!;
          const index = project.rundown.findIndex((candidate) => candidate.id === item.id);
          return <article className={`p1-media-card rundown-row ${item.id === selectedItemId ? 'is-selected' : ''} ${item.id === currentItemId ? 'is-current' : ''} ${item.enabled ? '' : 'is-disabled'}`} data-program-id={item.id} data-batch-selected={visibleBatchIds.includes(item.id)} data-runtime={item.id === currentItemId ? runtime : 'idle'} title={item.title} aria-label={`${item.title}，${props.playItem ? doubleClickPlayback ? '双击播放' : '单击播放' : '单击选中'}`} key={`${item.id}:${revision}`} tabIndex={0} draggable={false} onClick={() => props.playItem && !doubleClickPlayback ? props.playItem(item) : props.onChooseItem(item)} onDoubleClick={() => { if (doubleClickPlayback && props.playItem) props.playItem(item); else if (!props.playItem) props.onSelectCurrentItem(item); }} onContextMenu={(event) => { event.preventDefault(); if (props.locked) return; props.onChooseItem(item); setContext({ item, x: event.clientX, y: event.clientY }); }} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); (props.playItem ?? props.onSelectCurrentItem)(item); } }}>
            <div className="p1-card-top"><span><Music2 />{item.referenceAudio ? '音频节目' : '待添加音频'}</span><button className="rundown-index" disabled={!item.enabled} onClick={(event) => { event.stopPropagation(); (props.playItem ?? props.onSelectCurrentItem)(item); }}>{index + 1}</button></div>
            <strong>{item.lighting?.ma2Bindings?.length || item.lighting?.tracks.some(track => track.clips.some(clip => clip.events.length)) ? <span className="program-lighting-badge" title="此歌曲已有灯光编排；不代表控台正在输出"><Lightbulb aria-label="已编灯" /></span> : null}{item.title}</strong>
            <div className="p1-card-state">{project.playbackSource === 'internal' && item.referenceAudio ? <button className="song-volume-button" aria-label={`${item.title} 独立音量`} title="设置这首音频的独立音量，随工程保存" disabled={props.locked} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onChooseItem(item); setInspectorOpen(true); }}>音量 {item.playback?.volume ?? 100}%</button> : null}{item.id === currentItemId ? <><Check />{runtime === 'running' ? '播放中' : runtime === 'paused' ? '已暂停' : '当前节目'}</> : props.playedItemIds.includes(item.id) ? '已播放' : props.playItem ? doubleClickPlayback ? '双击播放' : '点击播放' : item.p1Media ? 'P1 音频' : '联动节目'}</div>
            <footer><span>{formatDuration(item.referenceAudio?.durationMs ?? 0)}</span><small><Film />{item.referenceMediaClips.length} 素材 · {item.cues.length} Cue</small></footer>
            <Button className="icon-button program-row-properties" aria-label={`编辑节目属性：${item.title}`} title="编辑节目属性" onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); props.onChooseItem(item); setInspectorOpen(true); }}><SlidersHorizontal /></Button>
          </article>;
        }} />
    </section>

    {inspectorOpen ? <section className="p1-item-inspector">
      <div className="p1-pane-title" title={selectedItem && props.playItem ? `灯光时间码起点：${internalStart(project, selectedItem.id)}` : undefined}><strong title={selectedItem?.title}>编辑节目</strong><Button className="icon-button" aria-label="收起节目属性" onClick={() => setInspectorOpen(false)}><X /></Button></div>
      {selectedItem ? <div className="p1-inspector-content" key={selectedItem.id}>
        <label><span>播放列表</span><select disabled={props.locked} aria-label="所属播放列表" value={programPlaylistId(project, selectedItem) ?? ''} onChange={(event) => { try { execute(editProgramPlaylistCommand({ type: 'assign', itemIds: [selectedItem.id], playlistId: event.currentTarget.value || null })); } catch (reason) { props.notify(String(reason), 'error'); } }}><option value="">未分组</option>{programPlaylists(project).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
        <label><span>名称</span><input key={selectedItem.title} className="title-input" disabled={props.metadataLocked} aria-label="节目名称" title="回车保存，Esc 取消" defaultValue={selectedItem.title} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') event.currentTarget.value = selectedItem.title; event.currentTarget.blur(); } }} onInput={(event) => event.currentTarget.setCustomValidity('')} onBlur={(event) => commitText(event.currentTarget, 'title')} /></label>
        <label><span>备注</span><textarea key={`${selectedItem.id}:${selectedItem.notes}`} aria-label="备注" disabled={props.metadataLocked} rows={1} defaultValue={selectedItem.notes} placeholder="选填" onInput={(event) => event.currentTarget.setCustomValidity('')} onBlur={(event) => commitText(event.currentTarget, 'notes')} /></label>
        <fieldset disabled={props.locked} className="p1-runtime-properties">
        {project.playbackSource === 'internal' ? <SongPlaybackProperties item={selectedItem} notify={props.notify} collapseAdvanced /> : null}
        <div className="p1-inspector-footer"><label className="check-field"><input type="checkbox" checked={selectedItem.enabled} onChange={(event) => execute(updateRundownItemCommand(selectedItem.id, { title: selectedItem.title, enabled: event.currentTarget.checked, notes: selectedItem.notes }))} /><span>启用</span></label>
        <button className="p1-select-current" disabled={!selectedItem.enabled || selectedItem.id === currentItemId} onClick={() => props.onSelectCurrentItem(selectedItem)}><Check />{selectedItem.id === currentItemId ? '当前节目' : '设为当前节目'}</button>
        <Button className="secondary-button inspector-edit" disabled={!selectedItem.enabled} onClick={() => { props.onSelectCurrentItem(selectedItem); props.onOpenCueEditor(); }}><SlidersHorizontal />编辑内容</Button>
        <Button className="secondary-button inspector-audio" onClick={() => props.onChooseReference(selectedItem.id)}><FileAudio />{selectedItem.referenceAudio ? '更换音频' : '添加音频'}</Button>
        <div className="p1-inspector-actions">
          <Button className="icon-button" disabled={project.rundown[0]?.id === selectedItem.id} onClick={() => execute(moveRundownItemCommand(selectedItem.id, project.rundown.findIndex((item) => item.id === selectedItem.id) - 1))} title="上移"><ArrowUp /></Button>
          <Button className="icon-button" disabled={project.rundown.at(-1)?.id === selectedItem.id} onClick={() => execute(moveRundownItemCommand(selectedItem.id, project.rundown.findIndex((item) => item.id === selectedItem.id) + 1))} title="下移"><ArrowDown /></Button>
          <Button className="icon-button" onClick={() => execute(duplicateRundownItemCommand(selectedItem.id))} title="复制"><Copy /></Button>
          <Button className="icon-button danger" onClick={() => { if (window.confirm(`确认删除节目“${selectedItem.title}”？`)) execute(removeRundownItemCommand(selectedItem.id)); }} title="删除"><Trash2 /></Button>
        </div>
        </div>
        </fieldset>
      </div> : <div className="p1-library-empty"><FileAudio /><span>选择一个音频</span></div>}
    </section> : null}
    {context && !props.locked ? <ProgramContextMenu
      item={context.item}
      project={project}
      x={context.x}
      y={context.y}
      onChooseReference={props.onChooseReference}
      onProperties={() => setInspectorOpen(true)}
      onClose={() => setContext(null)}
      onOpenCueEditor={() => { props.onSelectCurrentItem(context.item); props.onOpenCueEditor(); }}
      onSelectCurrent={() => props.onSelectCurrentItem(context.item)}
      execute={execute}
    /> : null}
  </section>;
}

function ProgramContextMenu(props: {
  onProperties: () => void;
  item: RundownItem;
  project: LinkProject;
  x: number;
  y: number;
  onChooseReference: (itemId: string) => void;
  onClose: () => void;
  onOpenCueEditor: () => void;
  onSelectCurrent: () => void;
  execute: ReturnType<typeof useDocumentStore.getState>['execute'];
}): JSX.Element {
  const index = props.project.rundown.findIndex((item) => item.id === props.item.id);
  const run = (action: () => void): void => { props.onClose(); action(); };
  return <div className="resource-context-menu program-context-menu" style={{ left: Math.min(props.x, window.innerWidth - 240), top: Math.min(props.y, window.innerHeight - 250) }} onPointerDown={(event) => event.stopPropagation()}>
    <button className="context-menu-item" onClick={() => run(props.onProperties)}><span className="context-icon"><SlidersHorizontal /></span><span>节目属性</span></button>
    <button className="context-menu-item" onClick={() => run(props.onOpenCueEditor)}><span className="context-icon"><SlidersHorizontal /></span><span>打开 Cue 编辑器</span></button>
    <button className="context-menu-item" disabled={!props.item.enabled} onClick={() => run(props.onSelectCurrent)}><span className="context-icon"><Check /></span><span>设为当前节目</span></button>
    <button className="context-menu-item" onClick={() => run(() => props.onChooseReference(props.item.id))}><span className="context-icon"><FileAudio /></span><span>{props.item.referenceAudio ? '更换参考音频' : '添加参考音频'}</span></button>
    <div className="context-separator" />
    <button className="context-menu-item" disabled={index === 0} onClick={() => run(() => props.execute(moveRundownItemCommand(props.item.id, index - 1)))}><span className="context-icon"><ArrowUp /></span><span>上移</span></button>
    <button className="context-menu-item" disabled={index === props.project.rundown.length - 1} onClick={() => run(() => props.execute(moveRundownItemCommand(props.item.id, index + 1)))}><span className="context-icon"><ArrowDown /></span><span>下移</span></button>
    <button className="context-menu-item" onClick={() => run(() => props.execute(duplicateRundownItemCommand(props.item.id)))}><span className="context-icon"><Copy /></span><span>复制节目</span></button>
    <button className="context-menu-item danger" onClick={() => run(() => { if (window.confirm(`确认删除节目“${props.item.title}”？`)) props.execute(removeRundownItemCommand(props.item.id)); })}><span className="context-icon"><Trash2 /></span><span>删除节目</span></button>
  </div>;
}

function formatMilliseconds(milliseconds: number): string {
  const totalCentiseconds = Math.max(0, Math.floor(milliseconds / 10));
  const hours = Math.floor(totalCentiseconds / 360_000);
  const minutes = Math.floor(totalCentiseconds / 6_000) % 60;
  const seconds = Math.floor(totalCentiseconds / 100) % 60;
  const centiseconds = totalCentiseconds % 100;
  return [hours, minutes, seconds, centiseconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => URL.revokeObjectURL(url);
    audio.onloadedmetadata = () => {
      const durationMs = Math.round(audio.duration * 1_000);
      cleanup();
      if (!Number.isFinite(durationMs) || durationMs <= 0) reject(new Error('无法读取参考音频时长'));
      else resolve(durationMs);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('参考音频无法解码'));
    };
    audio.src = url;
  });
}

function internalStart(project: LinkProject, itemId: string): string {
  try { const item = project.rundown.find((entry) => entry.id === itemId); if (item?.playback || item?.p1Media) return formatMilliseconds(programTimeOrigin(item)); if (project.obsOutputMode === 'scenes') return formatMilliseconds(0); const range = allocateMediaTimecodeRanges(project).find((entry) => entry.itemId === itemId); return range ? formatMilliseconds(range.startSeconds * 1000) : '请添加音频'; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}





