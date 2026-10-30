import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { Button, type ButtonVariant, type ControlSize } from './Button';
import { Menu } from './Menu';

/**
 * A button that opens a menu of commands under it, such as 定位 and 灯光 on the timeline. `children`
 * gets `close`, for a command to call when it runs. The button again, Escape or a press outside closes it.
 */
export function MenuButton({ label, menuLabel, icon, variant = 'ghost', size = 'md', className, title, disabled, children }: {
  label: ReactNode;
  /** Names the menu for screen readers, such as 灯光工具. */
  menuLabel: string;
  icon?: LucideIcon;
  variant?: ButtonVariant;
  size?: ControlSize;
  className?: string;
  title?: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}): JSX.Element {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setPlace(null), []);
  const toggle = (): void => {
    if (place) { setPlace(null); return; }
    const box = trigger?.getBoundingClientRect();
    if (box) setPlace({ x: box.left, y: box.bottom + 4 });
  };
  return <>
    <Button ref={setTrigger} variant={variant} size={size} icon={icon} className={className ? `ui-menu-button ${className}` : 'ui-menu-button'} title={title}
      disabled={disabled} aria-haspopup="menu" aria-expanded={place !== null} onClick={toggle}>
      {label}<ChevronDown aria-hidden="true" className="ui-menu-button-chevron" />
    </Button>
    {place ? <Menu x={place.x} y={place.y} label={menuLabel} anchor={trigger} onClose={close}>{children(close)}</Menu> : null}
  </>;
}
