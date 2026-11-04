import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { CheckCircle2, ChevronRight, CircleAlert, Info, LoaderCircle, X } from 'lucide-react';
import { IconButton } from './Button';

/**
 * A titled block of related settings or information. `level` is the heading level it sits at; the
 * actions sit at the right of the heading.
 */
export function Card({ title, description, actions, level = 2, children, className, ...props }: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  const Heading = level === 2 ? 'h2' : 'h3';
  return <section {...props} className={className ? `ui-card ${className}` : 'ui-card'} aria-labelledby={title ? `${id}-title` : props['aria-labelledby']}>
    {title || actions ? <header className="ui-card-header">
      <div className="ui-card-heading">
        {title ? <Heading id={`${id}-title`}>{title}</Heading> : null}
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="ui-card-actions">{actions}</div> : null}
    </header> : null}
    <div className="ui-card-body">{children}</div>
  </section>;
}

/** Something to open when needed: advanced options, explanations, technical detail. */
export function Disclosure({ title, description, open, onToggle, className, children }: {
  title: ReactNode;
  description?: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <details className={className ? `ui-disclosure ${className}` : 'ui-disclosure'} open={open} onToggle={event => onToggle?.(event.currentTarget.open)}>
    <summary>
      <ChevronRight aria-hidden="true" />
      <span className="ui-disclosure-title"><span>{title}</span>{description ? <small>{description}</small> : null}</span>
    </summary>
    <div className="ui-disclosure-body">{children}</div>
  </details>;
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'error' | 'busy';
const noticeIcon = { info: Info, success: CheckCircle2, warning: CircleAlert, error: CircleAlert, busy: LoaderCircle } as const;

/**
 * A message in the page, next to what it is about: what happened, then what to do. Errors are
 * announced at once; the rest politely.
 */
export function Notice({ tone = 'info', title, actions, onDismiss, children }: {
  tone?: NoticeTone;
  title?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const Icon = noticeIcon[tone];
  return <div className="ui-notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon aria-hidden="true" />
    <div className="ui-notice-copy">
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
      {actions ? <div className="ui-notice-actions">{actions}</div> : null}
    </div>
    {onDismiss ? <IconButton label="关闭提示" icon={X} size="sm" onClick={onDismiss} /> : null}
  </div>;
}

/** A row of controls that belong together; `label` names it for screen readers. */
export function Toolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return <div role="toolbar" aria-label={label} className={className ? `ui-toolbar ${className}` : 'ui-toolbar'}>{children}</div>;
}

/** Controls inside a toolbar that are used together, set off from their neighbours. */
export function ToolbarGroup({ children, label }: { children: ReactNode; label?: string }): JSX.Element {
  return <div className="ui-toolbar-group" role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
}

/** Pushes what follows to the far end of the toolbar. */
export function ToolbarSpacer(): JSX.Element {
  return <span className="ui-toolbar-spacer" aria-hidden="true" />;
}
