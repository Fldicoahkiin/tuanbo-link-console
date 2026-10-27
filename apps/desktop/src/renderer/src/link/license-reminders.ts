import type { LicenseStatus } from '@tb/schema';

const RENEWAL_NOTICE_MS = 3 * 86400000;
const time = (iso: string): string => new Date(iso).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Workspace reminders for an authorized run: an offline start that must go online, and a term ending within three days. */
export function licenseReminders(status: LicenseStatus, now: number): string[] {
  if (status.state !== 'active') return [];
  const reminders: string[] = [];
  if (status.offlineUntil) reminders.push(`暂时连不上授权服务器，已离线启动。请在 ${time(status.offlineUntil)} 前联网一次，否则之后无法启动。`);
  const useUntil = status.claims?.useUntil;
  if (useUntil && Date.parse(useUntil) - now <= RENEWAL_NOTICE_MS) {
    reminders.push(`本机授权将在 ${time(useUntil)} 到期，请在「设置 → 本机授权」中续费。到期时正在进行的演出不会中断。`);
  }
  return reminders;
}
