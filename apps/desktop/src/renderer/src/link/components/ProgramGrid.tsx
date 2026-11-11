import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ListPlus, Trash2 } from 'lucide-react';
import { useProgramViewport } from './useProgramViewport';
import { useDragSession } from './useDragSession';
import { contentPoint, contentRectangle, intersects, scrollBoxOf, selectionRectangle, type Point, type Rectangle } from './program-grid-geometry';
import { Menu, MenuItem } from '../ui';

export function ProgramGrid({ itemIds, renderItem, empty, compact, locked, onAddItem, onBlankClick, onImportFiles, selectedIds, onSelectionChange, onDeleteSelection, view = 'cards' }: { itemIds: string[]; renderItem: (index: number) => ReactNode; empty: ReactNode; compact: boolean; locked: boolean; onAddItem: () => void; onBlankClick: () => void; onImportFiles: (files: File[]) => Promise<void>; selectedIds: string[]; onSelectionChange: (ids: string[]) => void; onDeleteSelection: () => void; view?: 'list' | 'cards' }): JSX.Element {
  const virtual = useProgramViewport(itemIds, view, compact);
  // Box selection on empty space is a drag like the others (DragSession): Escape gives it up and puts the selection
  // back, letting go anywhere ends it. Its corners are content positions of the scrolled list (program-grid-geometry).
  const session = useDragSession<{ pointerId: number; client: Point; start: Point; base: string[]; rectangle: Rectangle | null }>();
  const lasso = useRef<{ base: string[] } | null>(null);
  const suppressClick = useRef(false);
  const rectangle = session.drag?.rectangle ?? null;
  useEffect(() => {
    // The drag went away without being let go on the list (Escape, the window lost focus): selection as before.
    if (session.drag === null && lasso.current) { onSelectionChange(lasso.current.base); lasso.current = null; }
  }, [session.drag, onSelectionChange]);
  const [fileDrop, setFileDrop] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const close = (): void => setPosition(null);
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', key); };
  }, [position]);
  return <div ref={virtual.viewport} className="home-grid" data-view={view} data-total-programs={itemIds.length} data-file-drop={fileDrop} tabIndex={0} aria-label="节目列表"
    onScroll={event => virtual.scroll(event.currentTarget.scrollTop)}
    onFocusCapture={event => virtual.setFocused(event.target.closest<HTMLElement>('[data-program-id]')?.dataset.programId ?? null)}
    onPointerDown={event => {
      if (locked || event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input, article, [role="menu"]'))) return;
      event.preventDefault(); event.currentTarget.focus();
      suppressClick.current = false;
      lasso.current = { base: selectedIds };
      session.begin(event, { pointerId: event.pointerId, client: { x: event.clientX, y: event.clientY }, start: contentPoint(event.clientX, event.clientY, scrollBoxOf(event.currentTarget)), base: event.ctrlKey || event.metaKey ? selectedIds : [], rectangle: null });
    }}
    onPointerMove={event => {
      const current = session.current();
      if (!current || locked || current.pointerId !== event.pointerId || (!current.rectangle && Math.hypot(event.clientX - current.client.x, event.clientY - current.client.y) < 4)) return;
      const box = scrollBoxOf(event.currentTarget);
      const selection = selectionRectangle(current.start, contentPoint(event.clientX, event.clientY, box));
      session.update({ ...current, rectangle: selection });
      const ids = new Set(current.base);
      for (const card of event.currentTarget.querySelectorAll<HTMLElement>('[data-program-id]')) {
        if (card.dataset.programId && intersects(selection, contentRectangle(card.getBoundingClientRect(), box))) ids.add(card.dataset.programId);
      }
      onSelectionChange([...ids]);
    }}
    onPointerUp={event => {
      const current = session.current();
      if (current?.pointerId !== event.pointerId) return;
      suppressClick.current = current.rectangle !== null; lasso.current = null; session.end();
    }}
    onPointerCancel={event => { if (session.current()?.pointerId === event.pointerId) session.end(); }}
    onClickCapture={event => {
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return; }
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-program-id]') : null;
      if (card?.dataset.programId && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); event.stopPropagation();
        const id = card.dataset.programId;
        if (!locked) onSelectionChange(selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]);
      } else onSelectionChange([]);
    }}
    onKeyDown={event => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      virtual.keyDown(event);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); if (!locked) onSelectionChange(itemIds); }
      if (event.key === 'Escape') onSelectionChange([]);
      if (event.key === 'Delete' && selectedIds.length && !locked) { event.preventDefault(); onDeleteSelection(); }
    }}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = locked ? 'none' : 'copy';
      setFileDrop(!locked);
    }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFileDrop(false); }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); setFileDrop(false);
      if (!locked) void onImportFiles(Array.from(event.dataTransfer.files));
    }} onClick={(event) => {
    if (event.target === event.currentTarget || (event.target instanceof Element && (event.target.matches('.home-grid-body') || event.target.closest('.home-empty')))) onBlankClick();
  }} onContextMenuCapture={event => {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-program-id]') : null;
    if (locked || !card?.dataset.programId) return;
    if (selectedIds.includes(card.dataset.programId)) {
      event.preventDefault(); event.stopPropagation();
      setPosition({ x: event.clientX, y: event.clientY });
    } else onSelectionChange([]);
  }} onContextMenu={(event) => {
    if (locked || (event.target instanceof Element && event.target.closest('.home-card'))) return;
    event.preventDefault();
    setPosition({ x: event.clientX, y: event.clientY });
  }}>
    {itemIds.length ? <div className="home-grid-body" style={{ height: virtual.totalHeight }}>
      {virtual.indices.map(index => <div className="home-grid-row" data-program-index={index} key={itemIds[index]} style={virtual.style(index)}>{renderItem(index)}</div>)}
    </div> : empty}
    {rectangle ? <div className="home-grid-lasso" style={rectangle} /> : null}
    {position && !locked ? <Menu x={position.x} y={position.y} label="节目列表菜单" onClose={() => setPosition(null)}>
      {selectedIds.length ? <MenuItem icon={Trash2} danger onSelect={() => { setPosition(null); onDeleteSelection(); }}>删除所选 {selectedIds.length} 个节目</MenuItem> : null}
      <MenuItem icon={ListPlus} onSelect={() => { setPosition(null); onAddItem(); }}>新建空白节目</MenuItem>
    </Menu> : null}
  </div>;
}
