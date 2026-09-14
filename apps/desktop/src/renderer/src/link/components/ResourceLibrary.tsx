import type { ObsSourceKind } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { ObsSourceDialog } from './ObsSourceDialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinkMediaAsset, LinkMediaFolder, LinkMediaKind } from '@tb/schema';
import type { LinkObsInventory, LinkObsSnapshot } from '@tb/core/link';
import {
  FolderPlus,
  Import,
  RefreshCw,
  Search
} from 'lucide-react';
import {
  MediaResourceTable,
  type MediaContextTarget,
  type MediaFilter,
  type MediaRenameTarget,
  type MediaSort
} from './MediaResourceTable';
import { ResourceContextMenu } from './ResourceContextMenu';
import { buildObsVisualResources, type ObsResource } from './resource-library-model';

export { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE } from './resource-library-model';
export type { ObsResource } from './resource-library-model';

type Props = {
  folders: LinkMediaFolder[];
  assets: LinkMediaAsset[];
  assetAvailability: Record<string, { fileAvailable: boolean }> | null;
  projectPath: string | null;
  inventory: LinkObsInventory | null;
  obsStatus: LinkObsSnapshot['status'];
  selectedAssetId: string | null;
  selectedObsResourceId: string | null;
  onImport: (files: File[], folderId: string | null) => void;
  onAddFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onRemoveFolder: (folderId: string) => void;
  onSelectAsset: (assetId: string) => void;
  onAddAssetToTimeline: (assetId: string) => void;
  onRenameAsset: (assetId: string, name: string) => void;
  onMoveAsset: (assetId: string, folderId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  onRefreshObs: () => void;
  onAddObsResource: (resource: ObsResource) => boolean;
  onSelectObsResource: (resource: ObsResource) => void;
};

type ContextState = { x: number; y: number; target: MediaContextTarget } | null;

export function ResourceLibrary(props: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const importFolderId = useRef<string | null>(null);
  const [sourceKind, setSourceKind] = useState<ObsSourceKind | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<'local' | 'obs'>('local');
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [sort, setSort] = useState<MediaSort>('name');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set(props.folders.map((folder) => folder.id)));
  const [renameTarget, setRenameTarget] = useState<MediaRenameTarget>(null);
  const [newFolderParentId, setNewFolderParentId] = useState<string | null | undefined>(undefined);
  const [context, setContext] = useResourceContext();
  const [fileDropActive, setFileDropActive] = useState(false);
  const obsVisuals = useMemo(() => buildObsVisualResources(props.inventory, true), [props.inventory]);
  const visibleObsVisuals = props.obsStatus === 'connected' && section === 'obs'
    ? obsVisuals.filter((resource) => resource.name.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN')))
    : [];

  const requestImport = (kind: LinkMediaKind | 'all', folderId: string | null): void => {
    importFolderId.current = folderId;
    if (inputRef.current) inputRef.current.accept = acceptForKind(kind);
    inputRef.current?.click();
    setContext(null);
  };
  const runAndClose = (action: () => void): void => {
    setContext(null);
    action();
  };
  const publish = async (): Promise<void> => {
    if (publishing) return;
    const document = useDocumentStore.getState();
    setPublishError('');
    if (useRuntimeStore.getState().state !== 'idle') { setPublishError('请先停止播放，再同步素材场景。'); return; }
    if (!document.path || !document.project || props.obsStatus !== 'connected') { setPublishError('请保存工程并连接 OBS，再同步素材场景。'); return; }
    setPublishing(true);
    await synchronizeMaterials(document.path, document.project, setPublishError);
    setPublishing(false);
  };

  return <aside
    className={`resource-library panel ${fileDropActive ? 'is-file-drop-active' : ''}`}
    onDragEnter={(event) => {
      if (event.dataTransfer.types.includes('Files')) setFileDropActive(true);
    }}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDropActive(false);
    }}
    onDrop={(event) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setFileDropActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) props.onImport(files, selectedFolderId);
    }}
  >
    <div className="resource-sections" role="group" aria-label="素材来源">
      <button aria-pressed={section === 'local'} onClick={() => setSection('local')}>本地素材 <small>{props.assets.length}</small></button>
      <button aria-pressed={section === 'obs'} onClick={() => setSection('obs')}>OBS 场景 <small>{props.obsStatus === 'connected' ? obsVisuals.length : '离线'}</small></button>
    </div>
    <div className="resource-toolbar">
      <div className="resource-filterbar">
      {section === 'local' ? <select aria-label="素材类型" value={filter} onChange={(event) => setFilter(event.currentTarget.value as MediaFilter)}>
        <option value="all">全部</option>
        <option value="folder">文件夹</option><option value="video">视频</option><option value="audio">音频</option><option value="image">图片</option>
      </select> : null}
      <div className="resource-search"><Search /><input aria-label="搜索素材" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={section === 'local' ? '搜索素材名称' : '搜索 OBS 场景'} onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }} />{section === 'obs' ? <button type="button" className="resource-search-refresh" title="刷新场景" aria-label="刷新场景" disabled={props.obsStatus !== 'connected'} onClick={props.onRefreshObs}><RefreshCw /></button> : null}</div>
      </div>
    </div>
    {section === 'local' && selectedFolderId ? <div className="resource-folder-location"><span>导入到：{props.folders.find((folder) => folder.id === selectedFolderId)?.name}</span><button onClick={() => setSelectedFolderId(null)}>返回根目录</button></div> : null}
    {newFolderParentId !== undefined ? <NewFolderEditor
      parentName={props.folders.find((folder) => folder.id === newFolderParentId)?.name ?? '资源库根目录'}
      onCancel={() => setNewFolderParentId(undefined)}
      onCommit={(name) => {
        props.onAddFolder(name, newFolderParentId);
        if (newFolderParentId) setExpandedFolderIds((current) => new Set(current).add(newFolderParentId));
        setNewFolderParentId(undefined);
      }}
    /> : null}
    <input
      ref={inputRef}
      hidden
      multiple
      type="file"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        if (files.length > 0) props.onImport(files, importFolderId.current);
        event.currentTarget.value = '';
      }}
    />
    {fileDropActive ? <div className="resource-drop-overlay"><Import /><strong>释放以导入素材</strong><span>{selectedFolderId ? '导入当前文件夹' : '导入资源库根目录'}</span></div> : null}
    <MediaResourceTable
      folders={section === 'local' ? props.folders : []}
      assets={section === 'local' ? props.assets : []}
      view="list"
      emptyMessage={query ? '没有找到匹配的素材，试试其他名称' : section === 'obs' ? props.obsStatus === 'connected' ? 'OBS 中暂无场景' : '连接 OBS 后，可在这里选择场景' : '导入视频、音频或图片，也可以拖放文件到这里'}
      availability={props.assetAvailability}
      projectPath={props.projectPath}
      query={query}
      filter={filter}
      sort={sort}
      expandedFolderIds={expandedFolderIds}
      selectedAssetId={props.selectedAssetId}
      selectedFolderId={selectedFolderId}
      renameTarget={renameTarget}
      obsVisuals={visibleObsVisuals}
      selectedObsResourceId={props.selectedObsResourceId}
      onToggleFolder={(folderId) => setExpandedFolderIds((current) => toggleSetValue(current, folderId))}
      onSelectFolder={setSelectedFolderId}
      onSelectAsset={props.onSelectAsset}
      onAddAssetToTimeline={props.onAddAssetToTimeline}
      onRenameAsset={(assetId, name) => { props.onRenameAsset(assetId, name); setRenameTarget(null); }}
      onRenameFolder={(folderId, name) => { props.onRenameFolder(folderId, name); setRenameTarget(null); }}
      onCancelRename={() => setRenameTarget(null)}
      onContextMenu={(target, x, y) => setContext({ target, x, y })}
      onSelectObsResource={props.onSelectObsResource}
      onAddObsResource={props.onAddObsResource}
    />
    {publishError ? <p role="alert" className="device-error">{publishError}</p> : null}
    {context ? createPortal(<ResourceContextMenu
      {...context}
      activeFolderId={selectedFolderId}
      folders={props.folders}
      onCreateObsSource={(kind) => runAndClose(() => { if (kind === 'media' || kind === 'image') requestImport(kind === 'image' ? 'image' : 'all', selectedFolderId); else setSourceKind(kind); })}
      onImport={requestImport}
      onCreateFolder={(parentId) => runAndClose(() => setNewFolderParentId(parentId))}
      onPreviewAsset={(assetId) => runAndClose(() => props.onSelectAsset(assetId))}
      onPublishAsset={() => runAndClose(() => { void publish(); })}
      onRename={(target) => runAndClose(() => setRenameTarget({ kind: target.kind, id: target.kind === 'asset' ? target.asset.id : target.folder.id }))}
      onMoveAsset={(assetId, folderId) => runAndClose(() => props.onMoveAsset(assetId, folderId))}
      onMoveFolder={(folderId, parentId) => runAndClose(() => props.onMoveFolder(folderId, parentId))}
      onRemove={(target) => runAndClose(() => target.kind === 'asset' ? props.onRemoveAsset(target.asset.id) : props.onRemoveFolder(target.folder.id))}
      onSort={(next) => runAndClose(() => setSort(next))}
      onExpandAll={() => runAndClose(() => setExpandedFolderIds(new Set(props.folders.map((folder) => folder.id))))}
      onCollapseAll={() => runAndClose(() => setExpandedFolderIds(new Set()))}
      onSyncObs={() => runAndClose(() => { if (props.obsStatus === 'connected') props.onRefreshObs(); })}
      onClose={() => setContext(null)}
    />, document.body) : null}
    {sourceKind ? <ObsSourceDialog kind={sourceKind} scenes={props.inventory?.scenes ?? []} onClose={() => setSourceKind(null)} /> : null}
  </aside>;
}

function NewFolderEditor(props: { parentName: string; onCommit: (name: string) => void; onCancel: () => void }): JSX.Element {
  const [name, setName] = useState('新建文件夹');
  return <form className="new-folder-editor" onSubmit={(event) => { event.preventDefault(); props.onCommit(name); }}>
    <FolderPlus /><span><small>位置：{props.parentName}</small><input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} /></span>
    <button type="submit">确定</button><button type="button" onClick={props.onCancel}>取消</button>
  </form>;
}

function useResourceContext(): [ContextState, React.Dispatch<React.SetStateAction<ContextState>>] {
  const [context, setContext] = useState<ContextState>(null);
  useEffect(() => {
    if (!context) return;
    const close = (): void => setContext(null);
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [context]);
  return [context, setContext];
}

function acceptForKind(kind: LinkMediaKind | 'all'): string {
  if (kind === 'all') return 'audio/*,video/*,image/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.mp4,.mov,.mkv,.avi,.webm,.png,.jpg,.jpeg,.webp,.gif,.bmp';
  if (kind === 'video') return 'video/*,.mp4,.mov,.mkv,.avi,.webm';
  if (kind === 'audio') return 'audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg';
  return 'image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp';
}

function toggleSetValue<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

async function synchronizeMaterials(path: string, project: NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>, onError: (message: string) => void): Promise<void> {
  try {
    await desktop.prepareObsMediaScenes(path, project, useDisplayPreferences.getState().preciseSeeking);
    useIntegrationStore.getState().setInventory(await desktop.readObsInventory());
  } catch (error) {
    const message = `素材场景同步失败：${String(error)}`; onError(message);
    try { await desktop.recordLog({ level: 'error', category: 'device', device: 'obs', result: 'failed', message }); }
    catch (logError) { onError(`${message}；记录失败：${String(logError)}`); }
  }
}
