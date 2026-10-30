import type { ReactNode } from 'react';

/**
 * A long job in progress: what it is doing, how far it got and, below, the detail and its actions
 * (such as cancel). Without `max` the bar runs without a measure. `compact` is for the sidebar.
 */
export function Progress({ label, title, status, value, max, detail, compact = false, children }: {
  /** Names the bar for screen readers. */
  label: string;
  title: ReactNode;
  status?: ReactNode;
  value?: number | undefined;
  max?: number | undefined;
  detail?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return <div className="ui-progress" data-density={compact ? 'compact' : undefined} role="status" aria-live="polite">
    <div className="ui-progress-heading"><strong>{title}</strong>{status ? <span>{status}</span> : null}</div>
    <progress aria-label={label} {...max ? { value: value ?? 0, max } : {}} />
    {detail ? <small>{detail}</small> : null}
    {children ? <div className="ui-progress-actions">{children}</div> : null}
  </div>;
}
