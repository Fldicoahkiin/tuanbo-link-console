import type { LinkObsSnapshot } from '@tb/core/link';

type ObsStatusEntry = { level: 'info' | 'warning' | 'error'; message: string; result: 'succeeded' | 'failed'; details?: Readonly<Record<string, unknown>> };

/**
 * The run-log entry for an OBS connection change, or null. Connecting is not recorded, and neither is a failed
 * attempt: the connect call records its own failure. A drop while connected needs someone's attention.
 */
export function obsStatusLogEntry(previous: LinkObsSnapshot['status'], next: LinkObsSnapshot): ObsStatusEntry | null {
  if (next.status === 'connected') return previous === 'connected' ? null
    : { level: 'info', message: `OBS 已连接（OBS ${next.obsVersion ?? '版本未知'}）`, result: 'succeeded', details: { obsVersion: next.obsVersion, webSocketVersion: next.webSocketVersion } };
  if (previous !== 'connected') return null;
  if (next.status === 'error') return { level: 'error', message: `OBS 连接错误：${next.error ?? '未知原因'}`, result: 'failed', details: { error: next.error } };
  if (next.status !== 'disconnected') return null;
  return next.error ? { level: 'warning', message: `OBS 连接已断开：${next.error}`, result: 'failed', details: { error: next.error } }
    : { level: 'info', message: 'OBS 已断开连接', result: 'succeeded' };
}
