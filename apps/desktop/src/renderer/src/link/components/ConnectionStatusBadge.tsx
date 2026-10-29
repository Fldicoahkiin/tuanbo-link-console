import type { ConnectionStatus } from '../view-models/connection-status';

/**
 * A connection's state as a coloured dot and one word, the same colours as the top bar's status chips;
 * the explanation is in the tooltip.
 */
export function ConnectionStatusBadge({ name, status }: { name: string; status: ConnectionStatus }): JSX.Element {
  return <span className={`connection-status-badge state-${status.state}`} role="status" title={status.detail} aria-label={`${name}：${status.value}。${status.detail}`}>
    <span className="connection-overview-dot" aria-hidden="true" />{status.value}
  </span>;
}
