import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ListPlus, Trash2 } from 'lucide-react';
import { useProgramViewport } from './useProgramViewport';
import { FloatingMenu } from '../ui/FloatingMenu';

export function ProgramGrid({ itemIds, renderItem, empty, compact, locked, onAddItem, onBlankClick, onImportFiles, selectedIds, onSelectionChange, onDeleteSelection, view = 'cards' }: { itemIds: string[]; renderItem: (index: number) => ReactNode; empty: ReactNode; compact: boolean; locked: boolean; onAddItem: () => void; onBlankClick: () => void; onImportFiles: (files: File[]) => Promise<void>; selectedIds: string[]; onSelectionChange: (ids: string[]) => void; onDeleteSelection: () => void; view?: 'list' | 'cards' }): JSX.Element {
  const virtual = useProgramViewport(itemIds, view, compact);
  const drag = useRef<{ x: number; y: number; base: string[]; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [rectangle, setRectangle] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
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
  return <div ref={virtual.viewport} className="p1-media-grid program-virtual-grid" data-view={view} data-total-programs={itemIds.length} data-file-drop={fileDrop} tabIndex={0} aria-label="节目列表"
    onScroll={event => virtual.scroll(event.currentTarget.scrollTop)}
    onFocusCapture={event => virtual.setFocused(event.target.closest<HTMLElement>('[data-program-id]')?.dataset.programId ?? null)}
    onPointerDown={event => {
      if (locked || event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input, article, [role="menu"]'))) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      suppressClick.current = false;
      drag.current = { x: event.clientX, y: event.clientY, base: event.ctrlKey || event.metaKey ? selectedIds : [], moved: false };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || locked || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
      start.moved = true;
      const left = Math.min(start.x, event.clientX), top = Math.min(start.y, event.clientY);
      const right = Math.max(start.x, event.clientX), bottom = Math.max(start.y, event.clientY);
      setRectangle({ left, top, width: right - left, height: bottom - top });
      const ids = new Set(start.base);
      for (const card of event.currentTarget.querySelectorAll<HTMLElement>('[data-program-id]')) {
        const box = card.getBoundingClientRect();
        if (box.left < right && box.right > left && box.top < bottom && box.bottom > top && card.dataset.programId) ids.add(card.dataset.programId);
      }
      onSelectionChange([...ids]);
    }}
    onPointerUp={event => { suppressClick.current = drag.current?.moved ?? false; drag.current = null; setRectangle(null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; setRectangle(null); suppressClick.current = false; }}
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
      if (event.key === 'Escape') { onSelectionChange([]); drag.current = null; setRectangle(null); }
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
    if (event.target === event.currentTarget || (event.target instanceof Element && (event.target.matches('.program-virtual-body') || event.target.closest('.p1-library-empty')))) onBlankClick();
  }} onContextMenuCapture={event => {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-program-id]') : null;
    if (locked || !card?.dataset.programId) return;
    if (selectedIds.includes(card.dataset.programId)) {
      event.preventDefault(); event.stopPropagation();
      setPosition({ x: event.clientX, y: event.clientY });
    } else onSelectionChange([]);
  }} onContextMenu={(event) => {
    if (locked || (event.target instanceof Element && event.target.closest('.p1-media-card'))) return;
    event.preventDefault();
    setPosition({ x: event.clientX, y: event.clientY });
  }}>
    {itemIds.length ? <div className="program-virtual-body" style={{ height: virtual.totalHeight }}>
      {virtual.indices.map(index => <div className="program-virtual-row" data-program-index={index} key={itemIds[index]} style={virtual.style(index)}>{renderItem(index)}</div>)}
    </div> : empty}
    {rectangle ? <div className="program-selection-rectangle" style={rectangle} /> : null}
    {position && !locked ? <FloatingMenu x={position.x} y={position.y} className="resource-context-menu" label="节目列表菜单">
      {selectedIds.length ? <button className="context-menu-item danger" role="menuitem" onClick={() => { setPosition(null); onDeleteSelection(); }}><Trash2 /><span>删除所选 {selectedIds.length} 个节目</span></button> : null}
      <button className="context-menu-item" role="menuitem" onClick={() => { setPosition(null); onAddItem(); }}><ListPlus /><span>新建空白节目</span></button>
    </FloatingMenu> : null}
  </div>;
}
