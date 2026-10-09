import { afterEach, expect, it, vi } from 'vitest';
import { allowProjectReopen, isProjectReopenSuspended, suspendProjectReopen } from './project-recovery';

afterEach(() => vi.unstubAllGlobals());
it('崩溃只暂停对应工程自动打开；用户明确重开才解除，不改工程数据', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  suspendProjectReopen('D:/演出.tblink');
  expect(isProjectReopenSuspended('D:/演出.tblink')).toBe(true);
  expect(isProjectReopenSuspended('D:/其他.tblink')).toBe(false);
  suspendProjectReopen(null);
  allowProjectReopen('D:/其他.tblink');
  expect(isProjectReopenSuspended('D:/演出.tblink')).toBe(true);
  allowProjectReopen('D:/演出.tblink');
  expect(isProjectReopenSuspended('D:/演出.tblink')).toBe(false);
});
