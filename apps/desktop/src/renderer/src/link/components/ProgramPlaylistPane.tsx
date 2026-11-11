import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ListMusic, Plus, Pencil, Trash2 } from 'lucide-react';
import { editProgramPlaylistCommand, playlistDropIndex, playlistItems, playlistOrderFromP1, programPlaylists } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { Button, Dialog, IconButton, Menu, MenuItem, TextInput } from '../ui';
import { useDragSession } from './useDragSession';
import { useDragEdgeScroll, verticalScrollerOf } from './useDragEdgeScroll';
import { dropPlacement } from './program-grid-geometry';
import { HOME_OWN_KEYS, ownKeys } from '../keys/key-owner';

type PlaylistDrag = { pointerId: number; id: string; target: { id: string; placement: 'before' | 'after' } | null };

export const PROGRAM_DRAG_TYPE = 'application/x-tblink-program';
export function ProgramPlaylistPane(props: { project: LinkProject; selectedId: string; locked: boolean; onSelect: (id: string) => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const lists = programPlaylists(props.project);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const formId = useId();
  // Dragging a playlist to another place: the same drag as the song cards (DragSession, 4 px before it starts,
  // Escape cancels, a bar marks the drop place). 全部节目 and 未分组 stay where they are.
  const session = useDragSession<PlaylistDrag>();
  const press = useRef<{ pointerId: number; id: string; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const [refused, setRefused] = useState(false);
  const moveBlocked = props.locked ? '正在播放或处理中，停下后才能调整顺序'
    : playlistOrderFromP1(props.project) ? '这些播放列表来自 P1，顺序跟 P1 一致，请在 P1 里调整' : null;
  const drag = session.drag;
  const listIds = lists.map(list => list.id);
  const dropTarget = (clientX: number, clientY: number, previous: PlaylistDrag['target']): PlaylistDrag['target'] => {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-playlist-id]');
    const id = element?.dataset.playlistId;
    if (!element || !id || !listIds.includes(id)) return previous;
    return { id, placement: dropPlacement(clientX, clientY, element.getBoundingClientRect(), 'list') };
  };
  const moveTo = (pointer: { x: number; y: number }): void => {
    const current = session.current();
    if (!current) return;
    const target = dropTarget(pointer.x, pointer.y, current.target);
    if (target?.id !== current.target?.id || target?.placement !== current.target?.placement) session.update({ ...current, target });
  };
  // The same edge scrolling as the song cards; the list scrolls in the sidebar, which may be the pane or its holder.
  const { follow: followEdge, stop: stopEdge } = useDragEdgeScroll(moveTo);
  const dragging = drag !== null;
  useEffect(() => { if (!dragging) stopEdge(); }, [dragging, stopEdge]);
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
  return <aside className="p1-playlist-pane" data-reordering={drag !== null} data-refused={refused} title={refused ? moveBlocked ?? undefined : undefined}
    onPointerDown={event => {
      const id = event.button === 0 && event.target instanceof Element ? event.target.closest<HTMLElement>('[data-playlist-id]')?.dataset.playlistId : undefined;
      press.current = id && listIds.includes(id) ? { pointerId: event.pointerId, id, x: event.clientX, y: event.clientY } : null;
    }}
    onPointerMove={event => {
      const pressed = press.current;
      if (pressed && (event.buttons & 1) === 0) press.current = null;
      else if (pressed?.pointerId === event.pointerId && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) >= 4) {
        press.current = null; suppressClick.current = true;
        if (moveBlocked) { event.currentTarget.setPointerCapture(event.pointerId); setRefused(true); return; }
        session.begin(event, { pointerId: event.pointerId, id: pressed.id, target: dropTarget(event.clientX, event.clientY, null) });
        followEdge(verticalScrollerOf(event.currentTarget), { x: event.clientX, y: event.clientY });
        return;
      }
      const current = session.current();
      if (current?.pointerId !== event.pointerId) return;
      moveTo({ x: event.clientX, y: event.clientY });
      followEdge(verticalScrollerOf(event.currentTarget), { x: event.clientX, y: event.clientY });
    }}
    onPointerUp={event => {
      if (press.current?.pointerId === event.pointerId) press.current = null;
      if (refused) { setRefused(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
      const current = session.current();
      if (current?.pointerId !== event.pointerId) return;
      stopEdge(); session.end();
      const index = current.target ? playlistDropIndex(listIds, current.id, listIds.indexOf(current.target.id) + (current.target.placement === 'after' ? 1 : 0)) : null;
      if (index !== null && !moveBlocked) execute({ type: 'move', id: current.id, index });
    }}
    onPointerCancel={event => { press.current = null; setRefused(false); if (session.current()?.pointerId === event.pointerId) { stopEdge(); session.end(); } }}
    onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
    <div className="p1-pane-title"><strong>播放列表</strong><IconButton size="sm" label="新建播放列表" icon={Plus} disabled={props.locked} onClick={() => setEditing({ id: null, name: '' })} /></div>
    {[{ id: 'all', name: '全部节目' }, ...lists, { id: 'unassigned', name: '未分组' }].map((list) => <button key={list.id} title={listIds.includes(list.id) ? `${list.name}\n${moveBlocked ?? '按住拖动可以调整顺序'}` : list.name} aria-pressed={props.selectedId === list.id} className={props.selectedId === list.id ? 'active' : ''} onClick={() => props.onSelect(list.id)}
      data-playlist-id={list.id} data-moving={drag?.id === list.id} {...ownKeys(...HOME_OWN_KEYS.playlist)} data-drop={drag?.target?.id === list.id && drag.id !== list.id ? drag.target.placement : undefined}
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
      <MenuItem icon={ArrowUp} disabled={index <= 0 || moveBlocked !== null} {...moveBlocked ? { title: moveBlocked } : {}} onSelect={() => { execute({ type: 'move', id: current.id, index: index - 1 }); setMenu(null); }}>上移列表</MenuItem>
      <MenuItem icon={ArrowDown} disabled={index >= lists.length - 1 || moveBlocked !== null} {...moveBlocked ? { title: moveBlocked } : {}} onSelect={() => { execute({ type: 'move', id: current.id, index: index + 1 }); setMenu(null); }}>下移列表</MenuItem>
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

