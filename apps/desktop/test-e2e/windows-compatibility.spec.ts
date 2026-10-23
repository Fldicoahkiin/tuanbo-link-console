import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { closeDiscarding } from './save-questions';

test('全新配置与空 PATH：桌面程序能通过真实 IPC 检测本机集成和虚拟 MIDI', async ({}, info) => {
  // Windows 环境变量名称不区分大小写，不能留下另一份 Path。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.toLowerCase() !== 'path' && typeof value === 'string'));
  const packagedExecutable = process.env.TBLINK_COMPAT_EXECUTABLE;
  const app = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: [`--user-data-dir=${info.outputPath('profile')}`, ...(packagedExecutable ? [] : [join(process.cwd(), 'out/main/index.cjs')])],
    env: { ...env, PATH: '' }
  });
  const diagnostics: string[] = [];
  app.process().stderr?.on('data', (value: Buffer) => diagnostics.push(value.toString()));
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    await expect(page.getByRole('button', { name: '打开工程', exact: true })).toBeVisible();
    expect(await app.evaluate(() => Object.entries(process.env).filter(([key, value]) => key.toLowerCase() === 'path' && Boolean(value)))).toEqual([]);
    const integrations = await page.evaluate(() => window.tbLink.detectLocalIntegrations());
    expect(Object.keys(integrations.applications).sort()).toEqual(['ma2', 'ma3d', 'obs', 'p1']);
    const midi = await page.evaluate(() => window.tbLink.loopMidi('detect'));
    expect(['missing', 'installed', 'running']).toContain(midi.state);
    await page.screenshot({ path: info.outputPath('windows-empty-path.png') });
  } catch (error) {
    const page = await app.firstWindow();
    await writeFile(info.outputPath('failure-ui.txt'), `${page.url()}\n${await page.locator('body').innerText()}\n${diagnostics.join('\n')}`);
    await page.screenshot({ path: info.outputPath('failure-ui.png') });
    throw error;
  } finally {
    await closeDiscarding(app);
  }
});
