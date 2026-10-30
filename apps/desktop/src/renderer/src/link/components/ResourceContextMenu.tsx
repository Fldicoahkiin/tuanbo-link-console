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
  ChevronsDownUp,
  ChevronsUpDown,
  FileAudio,
  FileImage,
  Film,
  FolderPlus,
  Pencil,
  Search,
  Trash2
} from 'lucide-react';
import type { MediaContextTarget, MediaSort } from './MediaResourceTable';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui';

const sourceIcons = { camera: Camera, media: Film, image: FileImage, browser: Globe, window: AppWindow, text: Type, display: Monitor, audioInput: Mic, audioOutput: Volume2 };

type Props = {
  x: number;
  y: number;
  target: MediaContextTarget;
  sort: MediaSort;
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
  const folderId = props.target.kind === 'folder'
    ? props.target.folder.id
    : props.target.kind === 'asset'
      ? props.target.asset.folderId
      : props.activeFolderId;
  const asset = props.target.kind === 'asset' ? props.target.asset : null;
  const folder = props.target.kind === 'folder' ? props.target.folder : null;
  return <Menu x={props.x} y={props.y} label="素材菜单" {...(asset ? { title: asset.name } : folder ? { title: folder.name } : {})} onClose={props.onClose}>
    {props.target.kind === 'blank' ? <>
      <MenuLabel>添加到 OBS 场景</MenuLabel>
      <div className="obs-source-menu-grid">{(Object.keys(obsSourceKinds) as ObsSourceKind[]).map((kind) => <MenuItem key={kind} icon={sourceIcons[kind]} onSelect={() => props.onCreateObsSource(kind)}>{obsSourceKinds[kind].label}</MenuItem>)}</div>
      <MenuSeparator />
      <MenuItem icon={Film} onSelect={() => props.onImport('video', folderId)}>导入视频素材</MenuItem>
      <MenuItem icon={FileAudio} onSelect={() => props.onImport('audio', folderId)}>添加音频</MenuItem>
      <MenuItem icon={FileImage} onSelect={() => props.onImport('image', folderId)}>添加图片</MenuItem>
      <MenuItem icon={FolderPlus} onSelect={() => props.onCreateFolder(folderId)}>新建文件夹</MenuItem>
      <MenuSeparator />
      <MenuItem icon={Camera} onSelect={props.onSyncObs}>刷新 OBS 资源</MenuItem>
      <MenuSeparator />
      <MenuLabel>排序方式</MenuLabel>
      {(['name', 'type', 'status'] as const).map((value) => <MenuItem key={value} checked={props.sort === value} onSelect={() => props.onSort(value)}>{sortLabels[value]}</MenuItem>)}
      <MenuSeparator />
      <MenuItem icon={ChevronsUpDown} onSelect={props.onExpandAll}>展开全部文件夹</MenuItem>
      <MenuItem icon={ChevronsDownUp} onSelect={props.onCollapseAll}>折叠全部文件夹</MenuItem>
    </> : null}
    {asset ? <>
      <MenuItem icon={Search} onSelect={() => props.onPreviewAsset(asset.id)}>参考预览</MenuItem>
      <MenuItem icon={Monitor} onSelect={() => props.onPublishAsset(asset.id)}>同步素材独立场景</MenuItem>
      <MenuItem icon={Pencil} onSelect={() => props.onRename({ kind: 'asset', asset })}>重命名</MenuItem>
      <MoveTargets folders={props.folders} currentFolderId={asset.folderId} onMove={(nextFolderId) => props.onMoveAsset(asset.id, nextFolderId)} />
      <MenuSeparator />
      <MenuItem icon={Trash2} danger onSelect={() => props.onRemove({ kind: 'asset', asset })}>删除素材</MenuItem>
    </> : null}
    {folder ? <>
      <MenuItem icon={FolderPlus} onSelect={() => props.onCreateFolder(folder.id)}>新建子文件夹</MenuItem>
      <MenuItem icon={Pencil} onSelect={() => props.onRename({ kind: 'folder', folder })}>重命名文件夹</MenuItem>
      <MoveTargets folders={folderMoveTargets(props.folders, folder.id)} currentFolderId={folder.parentId} onMove={(nextFolderId) => props.onMoveFolder(folder.id, nextFolderId)} />
      <MenuSeparator />
      <MenuItem icon={Trash2} danger onSelect={() => props.onRemove({ kind: 'folder', folder })}>删除空文件夹</MenuItem>
    </> : null}
  </Menu>;
}

const sortLabels: Record<MediaSort, string> = { name: '按名称', type: '按类型', status: '按状态' };

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

/** The folders an item can move to, ticked where it is now; listed in the menu instead of a hover submenu. */
function MoveTargets(props: {
  folders: LinkMediaFolder[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}): JSX.Element {
  return <>
    <MenuSeparator />
    <MenuLabel>移动到</MenuLabel>
    <MenuItem checked={props.currentFolderId === null} onSelect={() => props.onMove(null)}>资源库根目录</MenuItem>
    {props.folders.map((folder) => <MenuItem key={folder.id} checked={props.currentFolderId === folder.id} onSelect={() => props.onMove(folder.id)}>{folder.name}</MenuItem>)}
  </>;
}
