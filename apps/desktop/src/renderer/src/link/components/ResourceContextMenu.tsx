import { obsSourceKinds, type ObsSourceKind } from '@tb/schema';
import type { LinkMediaFolder, LinkMediaKind } from '@tb/schema';
import {
  Camera,
  AppWindow,
  Globe,
  Mic,
  Monitor,
  Type,
  Volume2,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileAudio,
  FileImage,
  Film,
  FolderInput,
  FolderPlus,
  ListFilter,
  Pencil,
  Search,
  Trash2
} from 'lucide-react';
import type { MediaContextTarget, MediaSort } from './MediaResourceTable';

const sourceIcons = { camera: Camera, media: Film, image: FileImage, browser: Globe, window: AppWindow, text: Type, display: Monitor, audioInput: Mic, audioOutput: Volume2 };

type Props = {
  x: number;
  y: number;
  target: MediaContextTarget;
  activeFolderId: string | null;
  folders: LinkMediaFolder[];
  onImport: (kind: LinkMediaKind, folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onPreviewAsset: (assetId: string) => void;
  onPublishAsset: (assetId: string) => void;
  onRename: (target: Exclude<MediaContextTarget, { kind: 'blank' }>) => void;
  onMoveAsset: (assetId: string, folderId: string | null) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onRemove: (target: Exclude<MediaContextTarget, { kind: 'blank' }>) => void;
  onSort: (sort: MediaSort) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onSyncObs: () => void;
  onCreateObsSource: (kind: ObsSourceKind) => void;
  onClose: () => void;
};

export function ResourceContextMenu(props: Props): JSX.Element {
  const width = props.target.kind === 'blank' ? 340 : 220;
  const left = Math.min(props.x, window.innerWidth - width - 8);
  const top = Math.max(8, Math.min(props.y, window.innerHeight - (props.target.kind === 'blank' ? 620 : 300)));
  const folderId = props.target.kind === 'folder'
    ? props.target.folder.id
    : props.target.kind === 'asset'
      ? props.target.asset.folderId
      : props.activeFolderId;
  const asset = props.target.kind === 'asset' ? props.target.asset : null;
  const folder = props.target.kind === 'folder' ? props.target.folder : null;
  return <div className="resource-context-menu" style={{ left, top, width }} onMouseDown={(event) => event.stopPropagation()}>
    {props.target.kind === 'blank' ? <><div className="obs-source-menu-grid">{(Object.keys(obsSourceKinds) as ObsSourceKind[]).map((kind) => { const Icon = sourceIcons[kind]; return <MenuButton key={kind} icon={<Icon />} label={obsSourceKinds[kind].label} onClick={() => props.onCreateObsSource(kind)} />; })}</div>
    <div className="context-separator" />
    <MenuButton icon={<Film />} label="导入视频素材" onClick={() => props.onImport('video', folderId)} />
    <MenuButton icon={<FileAudio />} label="添加音频" onClick={() => props.onImport('audio', folderId)} />
    <MenuButton icon={<FileImage />} label="添加图片" onClick={() => props.onImport('image', folderId)} />
    <MenuButton icon={<FolderPlus />} label="新建文件夹" onClick={() => props.onCreateFolder(folderId)} />
    <div className="context-separator" />
    <MenuButton icon={<Camera />} label="刷新 OBS 资源" onClick={props.onSyncObs} />
    </> : null}
    {asset ? <>
      <div className="context-separator" />
      <MenuButton icon={<Search />} label="参考预览" onClick={() => props.onPreviewAsset(asset.id)} />
      <MenuButton icon={<Monitor />} label="同步素材独立场景" onClick={() => props.onPublishAsset(asset.id)} />
      <MenuButton icon={<Pencil />} label="重命名" onClick={() => props.onRename({ kind: 'asset', asset })} />
      <MoveSubmenu
        folders={props.folders}
        currentFolderId={asset.folderId}
        onMove={(nextFolderId) => props.onMoveAsset(asset.id, nextFolderId)}
      />
      <MenuButton danger icon={<Trash2 />} label="删除素材" onClick={() => props.onRemove({ kind: 'asset', asset })} />
    </> : null}
    {folder ? <>
      <div className="context-separator" />
      <MenuButton icon={<FolderPlus />} label="新建子文件夹" onClick={() => props.onCreateFolder(folder.id)} />
      <MenuButton icon={<Pencil />} label="重命名文件夹" onClick={() => props.onRename({ kind: 'folder', folder })} />
      <MoveSubmenu
        folders={folderMoveTargets(props.folders, folder.id)}
        currentFolderId={folder.parentId}
        onMove={(nextFolderId) => props.onMoveFolder(folder.id, nextFolderId)}
      />
      <MenuButton danger icon={<Trash2 />} label="删除空文件夹" onClick={() => props.onRemove({ kind: 'folder', folder })} />
    </> : null}
    {props.target.kind === 'blank' ? <><div className="context-separator" />
    <div className="context-submenu-wrap">
      <MenuButton icon={<ListFilter />} label="排序方式" suffix={<ChevronRight />} />
      <div className="context-submenu">
        <MenuButton label="按名称" onClick={() => props.onSort('name')} />
        <MenuButton label="按类型" onClick={() => props.onSort('type')} />
        <MenuButton label="按状态" onClick={() => props.onSort('status')} />
      </div>
    </div>
    <MenuButton icon={<ChevronsUpDown />} label="展开全部文件夹" onClick={props.onExpandAll} />
    <MenuButton icon={<ChevronsDownUp />} label="折叠全部文件夹" onClick={props.onCollapseAll} />
    </> : null}
  </div>;
}

function folderMoveTargets(folders: LinkMediaFolder[], folderId: string): LinkMediaFolder[] {
  const excluded = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId !== null && excluded.has(folder.parentId) && !excluded.has(folder.id)) {
        excluded.add(folder.id);
        changed = true;
      }
    }
  }
  return folders.filter((folder) => !excluded.has(folder.id));
}

function MoveSubmenu(props: {
  folders: LinkMediaFolder[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}): JSX.Element {
  return <div className="context-submenu-wrap">
    <MenuButton icon={<FolderInput />} label="移动到" suffix={<ChevronRight />} />
    <div className="context-submenu move-submenu">
      <MenuButton checked={props.currentFolderId === null} label="资源库根目录" onClick={() => props.onMove(null)} />
      {props.folders.map((folder) => <MenuButton
        checked={props.currentFolderId === folder.id}
        key={folder.id}
        label={folder.name}
        onClick={() => props.onMove(folder.id)}
      />)}
    </div>
  </div>;
}

function MenuButton(props: {
  icon?: JSX.Element;
  label: string;
  suffix?: JSX.Element;
  danger?: boolean;
  checked?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return <button
    className={`context-menu-item ${props.danger ? 'danger' : ''}`}
    disabled={!props.onClick && !props.suffix}
    onClick={props.onClick}
  >
    <span className="context-icon">{props.icon}{props.checked ? <i /> : null}</span>
    <span>{props.label}</span>{props.suffix}
  </button>;
}
