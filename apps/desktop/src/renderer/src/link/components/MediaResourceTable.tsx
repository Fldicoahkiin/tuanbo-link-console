import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { VirtualResourceList } from './VirtualResourceList';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { LinkMediaAsset, LinkMediaFolder } from '@tb/schema';
import {
  ChevronDown,
  ChevronRight,
  FileAudio,
  FileImage,
  Film,
  Folder,
  FolderOpen,
  Monitor,
  MoreHorizontal,
  Plus
} from 'lucide-react';
import { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE, type ObsResource } from './resource-library-model';
import { ownKeys } from '../keys/key-owner';

export type MediaFilter = 'all' | 'folder' | LinkMediaAsset['kind'];
export type MediaSort = 'name' | 'type' | 'status';
export type MediaRenameTarget = { kind: 'asset' | 'folder'; id: string } | null;
export type MediaContextTarget =
  | { kind: 'blank' }
  | { kind: 'folder'; folder: LinkMediaFolder }
  | { kind: 'asset'; asset: LinkMediaAsset };

type Props = {
  view: 'grid' | 'list';
  emptyMessage: string;
  folders: LinkMediaFolder[];
  assets: LinkMediaAsset[];
  availability: Record<string, { fileAvailable: boolean }> | null;
  projectPath: string | null;
  query: string;
  filter: MediaFilter;
  sort: MediaSort;
  expandedFolderIds: Set<string>;
  selectedAssetId: string | null;
  selectedFolderId: string | null;
  renameTarget: MediaRenameTarget;
  obsVisuals: ObsResource[];
  selectedObsResourceId: string | null;
  onToggleFolder: (folderId: string) => void;
  onSelectFolder: (folderId: string | null) => void;
  onSelectAsset: (assetId: string) => void;
  onAddAssetToTimeline: (assetId: string) => void;
  onRenameAsset: (assetId: string, name: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (target: MediaContextTarget, x: number, y: number) => void;
  onSelectObsResource: (resource: ObsResource) => void;
  onAddObsResource: (resource: ObsResource) => void;
};

type MediaRow =
  | { kind: 'folder'; folder: LinkMediaFolder; depth: number }
  | { kind: 'asset'; asset: LinkMediaAsset; depth: number };

const nameCollator = new Intl.Collator('zh-CN');
const searchNames = new WeakMap<LinkMediaAsset | LinkMediaFolder, string>();
function searchableName(item: LinkMediaAsset | LinkMediaFolder): string {
  const cached = searchNames.get(item);
  if (cached !== undefined) return cached;
  const normalized = item.name.toLocaleLowerCase('zh-CN');
  searchNames.set(item, normalized);
  return normalized;
}

export function MediaResourceTable(props: Props): JSX.Element {
  const { assets, folders, filter, query, sort, availability, expandedFolderIds } = props;
  const searchQuery = useDeferredValue(query);
  const statusAvailability = sort === 'status' ? availability : null;
  const rows = useMemo(() => buildRows({ assets, folders, filter, query: searchQuery, sort, availability: statusAvailability, expandedFolderIds }),
    [assets, folders, filter, searchQuery, sort, statusAvailability, expandedFolderIds]);
  if (props.view === 'list' && rows.length + props.obsVisuals.length > 0) return <VirtualResourceList
    keys={[...rows.map(row => row.kind === 'folder' ? `folder:${row.folder.id}` : `asset:${row.asset.id}`), ...props.obsVisuals.map(resource => `obs:${resource.id}`)]}
    onContextMenu={(x, y) => props.onContextMenu({ kind: 'blank' }, x, y)}
    renderRow={index => {
      const row = rows[index];
      if (row) return row.kind === 'folder' ? <FolderRow row={row} props={props} /> : <AssetRow row={row} props={props} />;
      const resource = props.obsVisuals[index - rows.length]!;
      return <ObsVisualRow resource={resource} selected={resource.id === props.selectedObsResourceId} onSelect={props.onSelectObsResource} onAdd={props.onAddObsResource} />;
    }} />;
  return <div
    className={`media-resource-table media-view-${props.view}`}
    onContextMenu={(event) => {
      event.preventDefault();
      props.onContextMenu({ kind: 'blank' }, event.clientX, event.clientY);
    }}
  >
    <div className="media-table-body">
      {rows.map((row) => row.kind === 'folder'
        ? <FolderRow key={row.folder.id} row={row} props={props} />
        : <AssetRow key={row.asset.id} row={row} props={props} />)}
      {props.obsVisuals.map((resource) => <ObsVisualRow key={resource.id} resource={resource} selected={resource.id === props.selectedObsResourceId} onSelect={props.onSelectObsResource} onAdd={props.onAddObsResource} />)}
      {rows.length === 0 && props.obsVisuals.length === 0 ? <div className="resource-empty"><FolderOpen /><strong>{props.emptyMessage}</strong></div> : null}
    </div>
  </div>;
}

function ObsVisualRow(props: { resource: ObsResource; selected: boolean; onSelect: (resource: ObsResource) => void; onAdd: (resource: ObsResource) => void }): JSX.Element {
  const resource = props.resource;
  return <div
    className={`media-table-row obs-camera-row ${props.selected ? 'is-selected' : ''}`}
    draggable
    tabIndex={0}
    {...ownKeys('Enter')}
    onClick={() => props.onSelect(resource)}
    onDoubleClick={() => { props.onSelect(resource); props.onAdd(resource); }}
    onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') { props.onSelect(resource); props.onAdd(resource); } }}
    onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(OBS_DRAG_TYPE, JSON.stringify(resource));
    }}
  >
    <span className="media-thumbnail icon"><Monitor /></span>
    <span className="media-row-copy">
      <span className="media-name-cell"><Monitor className="media-kind-icon camera" /><strong title={resource.name}>{resource.name}</strong></span>
      <small>OBS 场景</small>
    </span>
    <span className="media-status ready">在线</span>
    <button className="media-quick-add" aria-label={`添加场景 ${resource.name} 到时间线`} onClick={(event) => { event.stopPropagation(); props.onAdd(resource); }} onDoubleClick={(event) => event.stopPropagation()}><Plus /></button>
  </div>;
}

function FolderRow({ row, props }: { row: Extract<MediaRow, { kind: 'folder' }>; props: Props }): JSX.Element {
  const expanded = props.expandedFolderIds.has(row.folder.id) || props.query.trim() !== '';
  const editing = props.renameTarget?.kind === 'folder' && props.renameTarget.id === row.folder.id;
  return <div
    className={`media-table-row folder-row ${props.selectedFolderId === row.folder.id ? 'is-selected' : ''}`}
    onClick={() => props.onSelectFolder(row.folder.id)}
    onDoubleClick={() => props.onToggleFolder(row.folder.id)}
    tabIndex={0}
    {...ownKeys('Enter')}
    onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') { props.onSelectFolder(row.folder.id); props.onToggleFolder(row.folder.id); } }}
    onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      props.onSelectFolder(row.folder.id);
      props.onContextMenu({ kind: 'folder', folder: row.folder }, event.clientX, event.clientY);
    }}
  >
    <span className="media-thumbnail icon folder-thumbnail"><Folder /></span>
    <span className="media-row-copy" style={{ paddingLeft: `${row.depth * 12}px` }}>
      <span className="media-name-cell">
      <button className="tree-toggle" aria-label={`${expanded ? '收起' : '展开'}文件夹 ${row.folder.name}`} aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); props.onToggleFolder(row.folder.id); }}>
        {expanded ? <ChevronDown /> : <ChevronRight />}
      </button>
      {expanded ? <FolderOpen className="media-kind-icon folder" /> : <Folder className="media-kind-icon folder" />}
      {editing ? <InlineNameEditor
        initialValue={row.folder.name}
        onCommit={(name) => props.onRenameFolder(row.folder.id, name)}
        onCancel={props.onCancelRename}
      /> : <strong>{row.folder.name}</strong>}
      </span>
      <small>文件夹</small>
    </span>
    <span className="media-row-disclosure">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
    <button className="media-manage" aria-label={`管理文件夹 ${row.folder.name}`} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); props.onSelectFolder(row.folder.id); props.onContextMenu({ kind: 'folder', folder: row.folder }, rect.left, rect.bottom); }}><MoreHorizontal /></button>
  </div>;
}

function AssetRow({ row, props }: { row: Extract<MediaRow, { kind: 'asset' }>; props: Props }): JSX.Element {
  const lowPower = useDisplayPreferences((state) => state.lowPower);
  const available = props.availability?.[row.asset.id]?.fileAvailable;
  const editing = props.renameTarget?.kind === 'asset' && props.renameTarget.id === row.asset.id;
  const Icon = row.asset.kind === 'video' ? Film : row.asset.kind === 'audio' ? FileAudio : FileImage;
  return <div
    className={`media-table-row asset-row ${props.selectedAssetId === row.asset.id ? 'is-selected' : ''}`}
    draggable={!editing}
    tabIndex={0}
    {...ownKeys('Enter')}
    onClick={() => { props.onSelectAsset(row.asset.id); props.onSelectFolder(row.asset.folderId); }}
    onDoubleClick={() => { if (!editing) props.onAddAssetToTimeline(row.asset.id); }}
    onKeyDown={(event) => {
      if (!editing && event.target === event.currentTarget && event.key === 'Enter') props.onAddAssetToTimeline(row.asset.id);
    }}
    onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      props.onSelectAsset(row.asset.id);
      props.onContextMenu({ kind: 'asset', asset: row.asset }, event.clientX, event.clientY);
    }}
    onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(MEDIA_DRAG_TYPE, row.asset.id);
    }}
  >
    {lowPower || row.asset.kind === 'audio' || !props.projectPath
      ? <span className="media-thumbnail icon"><Icon /></span>
      : <AssetThumbnail asset={row.asset} projectPath={props.projectPath} />}
    <span className="media-row-copy" style={{ paddingLeft: `${row.depth * 12}px` }}>
      <span className="media-name-cell">
        <Icon className={`media-kind-icon ${row.asset.kind}`} />
        {editing ? <InlineNameEditor
          initialValue={row.asset.name}
          onCommit={(name) => props.onRenameAsset(row.asset.id, name)}
          onCancel={props.onCancelRename}
        /> : <strong title={row.asset.name}>{row.asset.name}</strong>}
      </span>
      <small className={available === false ? 'media-file-missing' : undefined}>{available === false ? '文件缺失' : props.view === 'grid' ? row.asset.kind === 'audio' ? '音频' : assetInfo(row.asset) : `${mediaKindLabel(row.asset.kind)} · ${assetInfo(row.asset)}`}</small>
    </span>
    {row.asset.durationMs !== undefined ? <span className="media-duration">{formatDuration(row.asset.durationMs)}</span> : null}
    <button className="media-manage" aria-label={`管理素材 ${row.asset.name}`} onClick={(event) => { event.stopPropagation(); props.onSelectAsset(row.asset.id); const rect = event.currentTarget.getBoundingClientRect(); props.onContextMenu({ kind: 'asset', asset: row.asset }, rect.left, rect.bottom); }} onDoubleClick={(event) => event.stopPropagation()}><MoreHorizontal /></button>
    <button className="media-quick-add" aria-label={`添加素材 ${row.asset.name} 到时间线`} disabled={available === false} onClick={(event) => { event.stopPropagation(); props.onAddAssetToTimeline(row.asset.id); }} onDoubleClick={(event) => event.stopPropagation()}><Plus /></button>
    <span className={`media-status ${available === true ? 'ready' : available === false ? 'missing' : 'checking'}`}>
      {available === true ? '就绪' : available === false ? '缺失' : '检查中'}
    </span>
  </div>;
}

function AssetThumbnail({ asset, projectPath }: { asset: LinkMediaAsset; projectPath: string }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError(null);
    void linkDesktopViewModel.ensureMediaThumbnailUrl({ projectPath, relativePath: asset.relativePath, sha256: asset.sha256, kind: asset.kind })
      .then((value) => { if (!cancelled) setUrl(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [asset.kind, asset.relativePath, asset.sha256, projectPath]);
  if (error) return <span className="media-thumbnail failed" aria-label={`缩略图生成失败：${error}`} title={error}><FileImage /><small>失败</small></span>;
  if (!url) return <span className="media-thumbnail icon" title="正在生成缩略图"><Film /></span>;
  return <span className="media-thumbnail">
    <img src={url} alt={asset.name} onError={() => setError(`无法显示素材缩略图：${asset.name}`)} />
  </span>;
}

function InlineNameEditor(props: { initialValue: string; onCommit: (name: string) => void; onCancel: () => void }): JSX.Element {
  const [value, setValue] = useState(props.initialValue);
  const cancelled = useRef(false);
  return <input
    autoFocus
    className="media-inline-name"
    {...ownKeys('*')}
    value={value}
    onChange={(event) => setValue(event.currentTarget.value)}
    onClick={(event) => event.stopPropagation()}
    onBlur={() => { if (!cancelled.current) props.onCommit(value); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') {
        cancelled.current = true;
        props.onCancel();
        event.currentTarget.blur();
      }
    }}
  />;
}

function buildRows(props: Pick<Props, 'assets' | 'folders' | 'filter' | 'query' | 'sort' | 'availability' | 'expandedFolderIds'>): MediaRow[] {
  const query = props.query.trim().toLocaleLowerCase('zh-CN');
  const folderByParent = new Map<string | null, LinkMediaFolder[]>();
  for (const folder of props.folders) {
    const children = folderByParent.get(folder.parentId) ?? [];
    children.push(folder);
    folderByParent.set(folder.parentId, children);
  }
  const assetByFolder = new Map<string | null, LinkMediaAsset[]>();
  for (const asset of props.assets) {
    if (props.filter !== 'all' && props.filter !== asset.kind) continue;
    if (query !== '' && !searchableName(asset).includes(query)) continue;
    const children = assetByFolder.get(asset.folderId) ?? [];
    children.push(asset);
    assetByFolder.set(asset.folderId, children);
  }
  const rows: MediaRow[] = [];
  const append = (parentId: string | null, depth: number): void => {
    const folders = [...(folderByParent.get(parentId) ?? [])].sort((a, b) => nameCollator.compare(a.name, b.name));
    for (const folder of folders) {
      if (!folderMatches(folder.id, query, folderByParent, assetByFolder, folder)) continue;
      rows.push({ kind: 'folder', folder, depth });
      if (query !== '' || props.expandedFolderIds.has(folder.id)) append(folder.id, depth + 1);
    }
    if (props.filter === 'folder') return;
    const assets = [...(assetByFolder.get(parentId) ?? [])].sort((a, b) => compareAssets(a, b, props.sort, props.availability));
    for (const asset of assets) rows.push({ kind: 'asset', asset, depth });
  };
  append(null, 0);
  return rows;
}

function folderMatches(
  folderId: string,
  query: string,
  folders: Map<string | null, LinkMediaFolder[]>,
  assets: Map<string | null, LinkMediaAsset[]>,
  folder: LinkMediaFolder
): boolean {
  if (query === '' || searchableName(folder).includes(query)) return true;
  if ((assets.get(folderId) ?? []).length > 0) return true;
  return (folders.get(folderId) ?? []).some((child) => folderMatches(child.id, query, folders, assets, child));
}

function compareAssets(
  left: LinkMediaAsset,
  right: LinkMediaAsset,
  sort: MediaSort,
  availability: Props['availability']
): number {
  if (sort === 'type') return nameCollator.compare(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`);
  if (sort === 'status') {
    const leftStatus = availability?.[left.id]?.fileAvailable === false ? 1 : 0;
    const rightStatus = availability?.[right.id]?.fileAvailable === false ? 1 : 0;
    if (leftStatus !== rightStatus) return leftStatus - rightStatus;
  }
  return nameCollator.compare(left.name, right.name);
}

function mediaKindLabel(kind: LinkMediaAsset['kind']): string {
  return kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片';
}

function assetInfo(asset: LinkMediaAsset): string {
  if (asset.width && asset.height) return `${asset.width}×${asset.height}`;
  if (asset.durationMs) return formatDuration(asset.durationMs);
  return `${Math.max(1, Math.round(asset.byteLength / 1_024))} KB`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
