import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Popover } from '../ui';

/**
 * A button in the material toolbar with a small panel under it (filters, page options, where a Cue sits
 * on the console). The panel is the shared Popover, mounted on the page body, so the toolbar's
 * horizontal scrolling cannot clip it; the button again, Escape or a press outside close it.
 */
export function Ma2MaterialMenu({ label, title = label, menuLabel = label, trigger, open, onOpenChange, children }: {
  label: string; title?: string; menuLabel?: string; trigger: ReactNode; open: boolean;
  onOpenChange: (open: boolean) => void; children: ReactNode;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const change = useRef(onOpenChange); change.current = onOpenChange;
  const close = useCallback(() => change.current(false), []);
  return <>
    <button ref={setAnchor} className="ma2-material-menu-trigger" aria-label={label} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpenChange(!open)}>{trigger}</button>
    {open ? <Popover anchor={anchor} label={menuLabel} placement="below-start" className="ma2-material-menu" onClose={close}>{children}</Popover> : null}
  </>;
}
