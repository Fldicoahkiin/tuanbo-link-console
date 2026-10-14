import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('真实 MIDI 初始化失败也不能冻结菜单、界面计时和关闭窗口', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'tblink-startup-response-'));
  const executablePath = process.env.TBLINK_TEST_EXECUTABLE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')]), `--user-data-dir=${userData}`]
  });
  const processExited = new Promise<number | null>((resolve) => application.process().once('exit', resolve));
  const page = await application.firstWindow();
  // Do not mock navigator, override IPC, or reload away the real startup path.
  await expect(page.getByRole('button', { name: '新建工程', exact: true })).toBeVisible();
  const midiResult = await page.evaluate(() => window.tbLink.recheckMidi().then(() => 'ready', (error: unknown) => error instanceof Error ? error.message : String(error)));
  expect(midiResult, 'MIDI 实际结果').toMatch(/ready|MIDI 端口枚举未响应|MIDI 检测组件运行失败|Windows MIDI 服务正在停止/);
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), 100))), { timeout: 8000 }).toBe(1);
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置子菜单' })).toBeVisible();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建工程', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(processExited).resolves.toBe(0);
});
