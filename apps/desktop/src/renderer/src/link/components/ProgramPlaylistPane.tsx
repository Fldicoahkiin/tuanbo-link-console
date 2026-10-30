import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ListMusic, Plus, Pencil, Trash2 } from 'lucide-react';
import { editProgramPlaylistCommand, playlistItems, programPlaylists } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { Button, Dialog, IconButton, Menu, MenuItem, TextInput } from '../ui';

export const PROGRAM_DRAG_TYPE = 'application/x-tblink-program';
export function ProgramPlaylistPane(props: { project: LinkProject; selectedId: string; locked: boolean; onSelect: (id: string) => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const lists = programPlaylists(props.project);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const formId = useId();
  useEffect(() => {
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  const execute = (edit: Parameters<typeof editProgramPlaylistCommand>[0]): boolean => {
    if (props.locked) return false;
    try { useDocumentStore.getState().execute(editProgramPlaylistCommand(edit)); return true; }
    catch (reason) { props.notify(reason instanceof Error ? reason.message : String(reason), 'error'); return false; }
  };
  const save = (): void => {
    if (!editing) return;
    const id = editing.id ?? crypto.randomUUID();
    if (execute({ type: editing.id ? 'rename' : 'add', id, name: editing.name })) { setEditing(null); props.onSelect(id); }
  };
  const current = lists.find((list) => list.id === menu?.id);
  const index = lists.findIndex((list) => list.id === menu?.id);
  return <aside className="p1-playlist-pane">
    <div className="p1-pane-title"><strong>播放列表</strong><IconButton size="sm" label="新建播放列表" icon={Plus} disabled={props.locked} onClick={() => setEditing({ id: null, name: '' })} /></div>
    {[{ id: 'all', name: '全部节目' }, ...lists, { id: 'unassigned', name: '未分组' }].map((list) => <button key={list.id} title={list.name} aria-pressed={props.selectedId === list.id} className={props.selectedId === list.id ? 'active' : ''} onClick={() => props.onSelect(list.id)}
      onKeyDown={(event) => {
        if (!props.locked && !['all', 'unassigned'].includes(list.id) && (event.key === 'F2' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          if (event.key === 'F2') setEditing({ id: list.id, name: list.name });
          else { const bounds = event.currentTarget.getBoundingClientRect(); setMenu({ id: list.id, x: bounds.left, y: bounds.bottom }); }
        }
      }}
      onDoubleClick={() => { if (!props.locked && !['all', 'unassigned'].includes(list.id)) setEditing({ id: list.id, name: list.name }); }}
      onContextMenu={(event) => { event.preventDefault(); if (!props.locked && !['all', 'unassigned'].includes(list.id)) setMenu({ id: list.id, x: event.clientX, y: event.clientY }); }}
      onDragOver={(event) => { if (!props.locked && list.id !== 'all' && event.dataTransfer.types.includes(PROGRAM_DRAG_TYPE)) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData(PROGRAM_DRAG_TYPE); if (id && list.id !== 'all') execute({ type: 'assign', itemIds: [id], playlistId: list.id === 'unassigned' ? null : list.id }); }}>
      <ListMusic /><span>{list.name}</span><small>{playlistItems(props.project, list.id).length}</small>
    </button>)}
    {createPortal(<>{menu && current ? <Menu x={menu.x} y={menu.y} label={`${current.name} 菜单`} onClose={() => setMenu(null)}>
      <MenuItem icon={Pencil} onSelect={() => { setEditing({ id: current.id, name: current.name }); setMenu(null); }}>重命名列表</MenuItem>
      <MenuItem icon={ArrowUp} disabled={index <= 0} onSelect={() => { execute({ type: 'move', id: current.id, index: index - 1 }); setMenu(null); }}>上移列表</MenuItem>
      <MenuItem icon={ArrowDown} disabled={index >= lists.length - 1} onSelect={() => { execute({ type: 'move', id: current.id, index: index + 1 }); setMenu(null); }}>下移列表</MenuItem>
      <MenuItem icon={Trash2} danger onSelect={() => { setRemoving(current.id); setMenu(null); }}>删除列表</MenuItem>
    </Menu> : null}
    {editing ? <Dialog size="sm" title={editing.id ? '重命名列表' : '新建播放列表'} closeLabel="取消" onClose={() => setEditing(null)}
      actions={<><Button variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button variant="primary" type="submit" form={formId} disabled={props.locked || !editing.name.trim()}>保存列表</Button></>}>
      <form id={formId} onSubmit={(event) => { event.preventDefault(); save(); }}>
        <TextInput autoFocus aria-label="列表名称" placeholder="例如：暖场、正式演出" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.currentTarget.value })} />
      </form>
    </Dialog> : null}
    {removing ? <Dialog size="sm" title={`删除“${lists.find((list) => list.id === removing)?.name ?? ''}”？`} closeLabel="取消" onClose={() => setRemoving(null)}
      description="歌曲和素材会保留，列表里的歌曲移到“未分组”。"
      actions={<><Button variant="secondary" onClick={() => setRemoving(null)}>取消</Button><Button variant="danger" disabled={props.locked} onClick={() => { if (execute({ type: 'remove', id: removing })) { if (props.selectedId === removing) props.onSelect('all'); setRemoving(null); } }}>删除列表，保留歌曲</Button></>} /> : null}
    </>, document.body)}
  </aside>;
}

