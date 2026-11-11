import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { FloatingMenu } from './FloatingMenu';
import { ownKeys } from '../keys/key-owner';

/**
 * A right-click or button menu at a point. The first item takes focus; the arrow keys, Home and End
 * move between items, Escape and Tab close it, and Escape gives focus back to what had it before. Keys
 * pressed in the menu stay in it, so the page behind does not also run its shortcuts. A press outside
 * the menu, leaving the window or resizing it closes the menu too; a press on `anchor`, the button that
 * opened it, is left to that button. `title` names what the menu acts on (a clip, a Cue), above the items.
 */
export function Menu({ x, y, label, title, anchor, onClose, children }: {
  x: number; y: number; label: string; title?: string; anchor?: HTMLElement | null; onClose: () => void; children: ReactNode;
}): JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const opener = useRef<Element | null>(null);
  const items = (): HTMLButtonElement[] => [...holder.current?.querySelectorAll<HTMLButtonElement>('.ui-menu-item:not(:disabled)') ?? []];
  useEffect(() => {
    opener.current = document.activeElement;
    holder.current?.querySelector<HTMLButtonElement>('.ui-menu-item:not(:disabled)')?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && (holder.current?.parentElement?.contains(event.target) || anchor?.contains(event.target))) return;
      close.current();
    };
    const leave = (): void => close.current();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('blur', leave);
    window.addEventListener('resize', leave);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('blur', leave); window.removeEventListener('resize', leave); };
  }, [anchor]);
  const move = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
      if (event.key === 'Escape' && opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
      return;
    }
    const list = items();
    const at = list.findIndex(item => item === document.activeElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % list.length : event.key === 'ArrowUp' ? (at - 1 + list.length) % list.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : null;
    if (next === null || list.length === 0) return;
    event.preventDefault();
    list[next]?.focus();
  };
  return <FloatingMenu x={x} y={y} className="ui-menu" label={label}>
    {title ? <div className="ui-menu-title" title={title}>{title}</div> : null}
    <div ref={holder} className="ui-menu-items" {...ownKeys('*')} onKeyDown={move}>{children}</div>
  </FloatingMenu>;
}

/**
 * One command in a menu. `danger` marks one that removes something. `checked` makes it a choice that
 * shows a tick when it is the current one (a sort order, a folder). `opens` marks one that shows more
 * choices in the same menu (设置分类), with an arrow at the end.
 */
export function MenuItem({ icon: Icon, danger = false, disabled = false, checked, opens = false, shortcut, title, onSelect, children }: {
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  opens?: boolean;
  shortcut?: string;
  title?: string;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  const Mark = checked ? Check : Icon;
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} className="ui-menu-item"
    data-danger={danger || undefined} disabled={disabled} title={title} onClick={onSelect}>
    <span className="ui-menu-icon" aria-hidden="true">{Mark ? <Mark /> : null}</span>
    <span className="ui-menu-label">{children}</span>
    {shortcut ? <kbd>{shortcut}</kbd> : opens ? <ChevronRight aria-hidden="true" className="ui-menu-opens" /> : null}
  </button>;
}

export function MenuSeparator(): JSX.Element {
  return <div className="ui-menu-separator" role="separator" />;
}

/** A small heading over a group of items, such as the folders of 移动到. */
export function MenuLabel({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ui-menu-group-label" role="presentation">{children}</div>;
}

/** A line of help under the items, such as the keys that do the same thing. */
export function MenuNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="ui-menu-note" role="note">{children}</p>;
}
