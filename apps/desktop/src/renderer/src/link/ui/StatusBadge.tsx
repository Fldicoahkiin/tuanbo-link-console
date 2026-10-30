import type { ConnectionStatus } from '../view-models/connection-status';

/**
 * One status as a coloured dot and one word, with the explanation in the tooltip. The status comes
 * from the status center (view-models/status-center.ts), so the same state reads and looks the same
 * on the top bar, in its details and in settings. With `onOpen` it is a button that leads to the
 * place where the status can be changed.
 */
export function StatusBadge({ name, status, showName = false, onOpen }: {
  name: string;
  status: ConnectionStatus;
  /** Shows the name before the word, as on the top bar. */
  showName?: boolean;
  onOpen?: () => void;
}): JSX.Element {
  const content = <><span className="ui-status-dot" aria-hidden="true" />{showName ? <span className="ui-status-name">{name}</span> : null}<span className="ui-status-value">{status.value}</span></>;
  const label = `${name}：${status.value}。${status.detail}`;
  return onOpen
    ? <button type="button" className="ui-status" data-state={status.state} data-interactive="true" title={status.detail} aria-label={label} onClick={onOpen}>{content}</button>
    : <span className="ui-status" data-state={status.state} role="status" title={status.detail} aria-label={label}>{content}</span>;
}
