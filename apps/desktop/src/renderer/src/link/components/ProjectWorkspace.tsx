import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addRundownItemCommand, playlistItems, programPlaylists, setReferenceAudioCommand } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { useSelectedProgram } from '../useSelectedProgram';
import { linkDesktopViewModel, linkFileViewModel } from '../view-models/link-desktop-view-model';
import { importProgramFiles } from './import-program-files';
import { usePlayProgram } from './usePlayProgram';
import { ProjectPlaybackMonitor } from './ProjectPlaybackMonitor';
import type { DocumentActionProps, DocumentFileCommands } from './DocumentActions';
import { ProjectTitlebar } from './ProjectTitlebar';

import { ProjectWelcome } from './ProjectWelcome';
import { type ProjectPlayer } from './ProjectPlayerControls';
import { MissingAssetsDialog } from './MissingAssetsDialog';
import { ProjectLibrary } from './ProjectLibrary';
import './home-page.css';

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
  fileCommands: DocumentFileCommands;
};

export function ProjectWorkspace({ toolbarHost, playlistHost, onCreate, onOpen, onImportSongs, player, editingLocked, coordinator, notify, onOpenCueEditor, documentActions, fileCommands }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const projectPath = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
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
      notify('参考音频已导入工程。');
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
    <div className="home-page">
      <MissingAssetsDialog request={missingAssetsRequest} locked={locked} notify={notify} />
      {toolbarHost ? createPortal(<ProjectTitlebar name={project.name} path={projectPath} dirty={dirty} locked={locked} documentActions={documentActions} fileCommands={fileCommands}
        onOpen={onOpen} onCreate={onCreate} onFindMissing={() => setMissingAssetsRequest((request) => request + 1)} />, toolbarHost) : null}

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
