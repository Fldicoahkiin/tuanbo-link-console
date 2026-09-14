import { useEffect, useState, type ReactNode } from 'react';
import { ListPlus } from 'lucide-react';

export function ProgramGrid({ children, locked, onAddItem, onBlankClick }: { children: ReactNode; locked: boolean; onAddItem: () => void; onBlankClick: () => void }): JSX.Element {
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
  return <div className="p1-media-grid" tabIndex={0} aria-label="节目列表" onClick={(event) => {
    if (event.target === event.currentTarget || (event.target instanceof Element && event.target.closest('.p1-library-empty'))) onBlankClick();
  }} onContextMenu={(event) => {
    if (locked || (event.target instanceof Element && event.target.closest('.p1-media-card'))) return;
    event.preventDefault();
    setPosition({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 60)) });
  }}>
    {children}
    {position && !locked ? <div className="resource-context-menu" role="menu" style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button className="context-menu-item" role="menuitem" onClick={() => { setPosition(null); onAddItem(); }}><ListPlus /><span>新建空白节目</span></button>
    </div> : null}
  </div>;
}
