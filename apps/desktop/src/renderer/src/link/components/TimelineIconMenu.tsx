import { useEffect, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function TimelineIconMenu({ label, icon: Icon, children }: { label: string; icon: LucideIcon; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent): void => { if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) ref.current.open = false; };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, []);
  return <details ref={ref} className="timeline-icon-menu"><summary aria-label={label} title={label}><Icon /></summary><div className="timeline-icon-menu-content">{children}</div></details>;
}
