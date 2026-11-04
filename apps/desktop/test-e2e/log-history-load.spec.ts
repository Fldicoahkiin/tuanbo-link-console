import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeDiscarding } from './save-questions';

const DAY = 24 * 60 * 60 * 1000;
// Below the 200 MB / 30 day retention, so the startup cleanup leaves the history alone.
const SESSIONS = 150, SESSION_BYTES = 1.25 * 1024 * 1024, SPREAD_DAYS = 25;

/** A finished session: long-run-like entries stamped and last written `ageMs` ago. */
async function writeSession(directory: string, index: number, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs);
  const entry = (n: number) => JSON.stringify({ id: `${index}-${n}`, sessionId: `history-${index}`, timestamp: new Date(at.getTime() - (2000 - n) * 1000).toISOString(),
    monotonicMs: n, level: 'info', category: 'action', device: 'obs', message: `切换场景 · 场景 ${n % 7} · succeeded`, result: 'succeeded',
    details: { kind: 'obs.setProgramScene', at: n, durationMs: 12, note: '历史负载'.repeat(20) } });
  const line = `${entry(0)}\n`, count = Math.ceil(SESSION_BYTES / Buffer.byteLength(line));
  const file = join(directory, `history-${String(index).padStart(3, '0')}.jsonl`);
  await writeFile(file, Array.from({ length: count }, (_, n) => entry(n)).join('\n') + '\n');
  await utimes(file, at, at);
}

/** Main-process RSS peak and the longest event-loop stall while `work` runs. */
async function measure(app: ElectronApplication, work: () => Promise<void>): Promise<{ ms: number; rssBeforeMB: number; rssPeakMB: number; maxStallMs: number }> {
  await app.evaluate(() => {
    const probe = { before: process.memoryUsage().rss, peak: 0, stall: 0, last: performance.now() };
    probe.peak = probe.before;
    Reflect.set(globalThis, '__logProbe', probe);
    Reflect.set(globalThis, '__logProbeTimer', setInterval(() => {
      const now = performance.now();
      probe.stall = Math.max(probe.stall, now - probe.last - 20); probe.last = now;
      probe.peak = Math.max(probe.peak, process.memoryUsage().rss);
    }, 20));
  });
  const started = Date.now();
  await work();
  const ms = Date.now() - started;
  const probe = await app.evaluate(() => {
    clearInterval(Reflect.get(globalThis, '__logProbeTimer') as NodeJS.Timeout);
    return Reflect.get(globalThis, '__logProbe') as { before: number; peak: number; stall: number };
  });
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return { ms, rssBeforeMB: mb(probe.before), rssPeakMB: mb(probe.peak), maxStallMs: Math.round(probe.stall) };
}

test('近 200 MB 历史日志：打开日志页和导出 30 天都不把历史读进主进程内存', async ({}, info) => {
  test.setTimeout(600_000);
  const profile = info.outputPath('profile'), logs = join(profile, 'link-logs');
  await mkdir(logs, { recursive: true });
  for (let index = 0; index < SESSIONS; index++) await writeSession(logs, index, DAY + (SESSIONS - index) * (SPREAD_DAYS - 1) * DAY / SESSIONS);
  const app = await electron.launch({ args: [`--user-data-dir=${profile}`, join(process.cwd(), 'out/main/index.cjs')] });
  const metrics: Record<string, unknown> = { historyMB: Math.round(SESSIONS * SESSION_BYTES / 1024 / 1024), sessions: SESSIONS };
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    const region = page.getByRole('region', { name: '运行日志设置' });
    metrics.openLogPage = await measure(app, async () => {
      await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '帮助与反馈', exact: true }).click();
      await page.getByRole('button', { name: '运行日志', exact: true }).click();
      await expect(region.locator('.settings-log-filters [role=status]')).toHaveText(/^\d+ 条$/, { timeout: 120_000 });
    });
    metrics.rowsShown = await region.locator('.settings-log-row').count();
    const range = region.getByLabel('导出范围');
    if (await range.count()) await range.selectOption('30');
    const exports = region.getByRole('region', { name: '导出日志与诊断' });
    for (const [kind, button, file] of [['exportText', '导出日志', '历史.txt'], ['exportPackage', '导出诊断包', '历史.tbdiag.gz']] as const) {
      const destination = info.outputPath(file);
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
      metrics[kind] = { ...await measure(app, async () => {
        await exports.getByRole('button', { name: button, exact: true }).click();
        await expect(exports.getByRole('status')).toContainText(destination, { timeout: 300_000 });
      }), fileMB: Math.round((await stat(destination)).size / 1024 / 1024) };
    }
  } finally {
    await writeFile(info.outputPath('log-history-metrics.json'), JSON.stringify(metrics, null, 2));
    console.log('LOG_HISTORY_METRICS', JSON.stringify(metrics));
    await closeDiscarding(app);
  }
  const open = metrics.openLogPage as Awaited<ReturnType<typeof measure>>;
  expect(open.ms).toBeLessThan(5_000);
  expect(open.rssPeakMB - open.rssBeforeMB).toBeLessThan(100);
  expect(open.maxStallMs).toBeLessThan(250);
  for (const kind of ['exportText', 'exportPackage']) {
    const exported = metrics[kind] as Awaited<ReturnType<typeof measure>>;
    expect(exported.rssPeakMB - exported.rssBeforeMB).toBeLessThan(150);
  }
});
