import { useCallback, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { IconButton, Popover } from '../ui';

/**
 * An icon on the timeline toolbar that opens a small panel of settings under it: the wheel speed, the
 * waveform look, the track to stamp on, a lighting notice. The panel is named by `label`, like the button.
 */
export function TimelinePanelButton({ label, icon, tone, children }: { label: string; icon: LucideIcon; tone?: 'warning'; children: ReactNode }): JSX.Element {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <IconButton ref={setTrigger} label={label} icon={icon} className="timeline-panel-button" data-tone={tone}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)} />
    {open ? <Popover anchor={trigger} label={label} className="timeline-panel" onClose={close}>{children}</Popover> : null}
  </>;
}
