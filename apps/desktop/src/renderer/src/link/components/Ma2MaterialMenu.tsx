import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Floating controls must escape the horizontally scrolling material toolbar. */
export function Ma2MaterialMenu({ label, title = label, menuLabel = label, trigger, open, onOpenChange, children }: {
  label: string; title?: string; menuLabel?: string; trigger: ReactNode; open: boolean;
  onOpenChange: (open: boolean) => void; children: ReactNode;
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const change = useRef(onOpenChange); change.current = onOpenChange;
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const button = anchor.current?.getBoundingClientRect(); const menu = panel.current?.getBoundingClientRect();
      if (!button || !menu) return;
      const left = Math.max(8, Math.min(button.left, window.innerWidth - menu.width - 8));
      const top = Math.max(8, button.bottom + menu.height + 12 <= window.innerHeight ? button.bottom + 4 : button.top - menu.height - 4);
      setPosition(current => current.left === left && current.top === top ? current : { left, top });
    };
    place(); const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) change.current(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); change.current(false); anchor.current?.focus({ preventScroll: true }); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  return <>
    <button ref={anchor} className="ma2-material-menu-trigger" aria-label={label} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpenChange(!open)}>{trigger}</button>
    {open ? createPortal(<div ref={panel} className="ma2-material-menu" role="dialog" aria-label={menuLabel} style={{ position: 'fixed', ...position }}>{children}</div>, document.body) : null}
  </>;
}
