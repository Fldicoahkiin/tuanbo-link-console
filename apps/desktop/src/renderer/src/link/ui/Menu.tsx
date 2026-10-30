import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FloatingMenu } from './FloatingMenu';

/**
 * A right-click or button menu at a point. The first item takes focus; the arrow keys, Home and End
 * move between items and Escape closes it.
 */
export function Menu({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: ReactNode }): JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const items = (): HTMLButtonElement[] => [...holder.current?.querySelectorAll<HTMLButtonElement>('.ui-menu-item:not(:disabled)') ?? []];
  useEffect(() => { holder.current?.querySelector<HTMLButtonElement>('.ui-menu-item:not(:disabled)')?.focus(); }, []);
  const move = (event: KeyboardEvent): void => {
    const list = items();
    const at = list.findIndex(item => item === document.activeElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % list.length : event.key === 'ArrowUp' ? (at - 1 + list.length) % list.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : null;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (next === null || list.length === 0) return;
    event.preventDefault();
    list[next]?.focus();
  };
  return <FloatingMenu x={x} y={y} className="ui-menu" label={label}>
    <div ref={holder} className="ui-menu-items" onKeyDown={move}>{children}</div>
  </FloatingMenu>;
}

/** One command in a menu. `danger` marks one that removes something. */
export function MenuItem({ icon: Icon, danger = false, disabled = false, shortcut, onSelect, children }: {
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  return <button type="button" role="menuitem" className="ui-menu-item" data-danger={danger || undefined} disabled={disabled} onClick={onSelect}>
    <span className="ui-menu-icon" aria-hidden="true">{Icon ? <Icon /> : null}</span>
    <span className="ui-menu-label">{children}</span>
    {shortcut ? <kbd>{shortcut}</kbd> : null}
  </button>;
}

export function MenuSeparator(): JSX.Element {
  return <div className="ui-menu-separator" role="separator" />;
}
