import { useEffect, useState } from 'react';
import { licenseStatusSchema } from '@tb/schema';
import { licenseReminders } from './license-reminders';

/** Reminders read once when the workspace opens; each stays until the operator dismisses it. */
export function useLicenseReminders(): [string[], (index: number) => void] {
  const [reminders, setReminders] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void window.tbLink.getLicenseStatus().then(
      (value) => { if (alive) setReminders(licenseReminders(licenseStatusSchema.parse(value), Date.now())); },
      (failure: unknown) => console.error('读取授权提醒失败', failure));
    return () => { alive = false; };
  }, []);
  return [reminders, (index) => setReminders((current) => current.filter((_, item) => item !== index))];
}
