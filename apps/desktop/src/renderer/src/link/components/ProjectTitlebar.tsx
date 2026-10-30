import { useEffect, useState } from 'react';
import { Download, FilePlus2, FileSearch, FolderOpen, History, SaveAll } from 'lucide-react';
import { DocumentActions, downloadUnsavedProject, type DocumentActionProps, type DocumentFileCommands } from './DocumentActions';
import { IconButton, Menu, MenuItem, MenuSeparator } from '../ui';

/**
 * The programme page's part of the title bar: the project menu, the project name and the document
 * commands. Hovering the bar shows where the project is saved.
 */
export function ProjectTitlebar({ name, path, dirty, locked, documentActions, fileCommands, onOpen, onCreate, onFindMissing }: {
  name: string;
  path: string | null;
  dirty: boolean;
  locked: boolean;
  documentActions: DocumentActionProps;
  fileCommands: DocumentFileCommands;
  onOpen: () => void;
  onCreate: () => void;
  onFindMissing: () => void;
}): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); };
  }, [menu]);
  const run = (action: () => void): void => { setMenu(null); action(); };
  return <div className="titlebar-document" data-page="project" title={path ?? undefined}>
    <IconButton label="工程菜单" title="工程 · 打开或新建" icon={FolderOpen} aria-haspopup="menu" aria-expanded={menu !== null}
      onPointerDown={event => { if (menu) event.stopPropagation(); }}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: box.left, y: box.bottom + 4 }); }} />
    <strong className="titlebar-document-name" aria-label="当前工程">{name}</strong>
    {/* Saving stays available while playing; undo and redo wait like other edits here. */}
    <DocumentActions {...documentActions} historyDisabled={Boolean(documentActions.historyDisabled) || locked} />
    {menu ? <Menu x={menu.x} y={menu.y} label="工程操作" onClose={() => setMenu(null)}>
      <MenuItem icon={FolderOpen} disabled={locked} onSelect={() => run(onOpen)}>打开工程</MenuItem>
      <MenuItem icon={FilePlus2} disabled={locked} onSelect={() => run(onCreate)}>新建独立工程</MenuItem>
      <MenuItem icon={SaveAll} disabled={fileCommands.replaceDisabled} onSelect={() => run(fileCommands.onSaveAs)}>另存为…</MenuItem>
      <MenuSeparator />
      <MenuItem icon={History} disabled={fileCommands.replaceDisabled || !path || !dirty} onSelect={() => run(fileCommands.onRevert)}>恢复到上次保存</MenuItem>
      <MenuItem icon={Download} disabled={!dirty} onSelect={() => run(downloadUnsavedProject)}>备份未保存工程</MenuItem>
      <MenuItem icon={FileSearch} disabled={locked || !path} onSelect={() => run(onFindMissing)}>找回缺失素材</MenuItem>
    </Menu> : null}
  </div>;
}
