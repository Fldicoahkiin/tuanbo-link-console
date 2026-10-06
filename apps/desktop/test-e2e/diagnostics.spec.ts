import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

const packageSchema = z.object({ context: z.object({ environment: z.object({ appVersion: z.string(), osRelease: z.string(), cpu: z.string() }), problem: z.string() }),
  logs: z.array(z.object({ message: z.string() })) });

test('运行日志使用设置子菜单，真实导出诊断及文本，并显示取消和落盘失败', async ({}, info) => {
  const application = await electron.launch({ env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' },
    args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
    await page.evaluate(() => window.tbLink.recordLog({ level: 'error', category: 'device', device: 'MA2', message: '异机灯光测试记录', result: 'failed', details: { password: 'must-not-export' } }));
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '运行日志', exact: true }).click();
    const logs = page.getByRole('region', { name: '运行日志设置' });
    await expect(logs.getByText('异机灯光测试记录', { exact: true })).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('logs-submenu.png') });
    const textPath = info.outputPath('运行日志.txt');
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, textPath);
    await logs.getByRole('button', { name: '导出日志', exact: true }).click();
    await expect(logs.getByRole('status')).toContainText(textPath);
    const text = await readFile(textPath, 'utf8');
    expect(text).toContain('异机灯光测试记录'); expect(text).not.toContain('must-not-export');
    await logs.getByText('附加问题说明与灯光数据（选填）', { exact: true }).click();
    const exports = logs.getByRole('region', { name: '导出日志与诊断', exact: true });
    await exports.getByLabel('问题描述（选填）').fill('另一台主机：播放后没有出灯');
    const diagnosticPath = info.outputPath('现场.tbdiag.gz');
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, diagnosticPath);
    await exports.getByRole('button', { name: '导出诊断包', exact: true }).click();
    await expect(exports.getByRole('status')).toContainText(diagnosticPath);
    const unpacked = gunzipSync(await readFile(diagnosticPath)).toString('utf8');
    const data = packageSchema.parse(JSON.parse(unpacked));
    const desktopPackage = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')));
    expect(data.context.environment.appVersion).toBe(desktopPackage.version);
    expect(data.context.problem).toContain('另一台主机'); expect(data.context.environment.cpu).toBeTruthy();
    expect(data.logs.some(log => log.message.includes('已启动'))).toBe(true);
    expect(unpacked).not.toContain('must-not-export');
    await application.evaluate(({ dialog }) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' }); });
    await exports.getByRole('button', { name: '导出诊断包', exact: true }).click();
    await expect(exports.getByRole('status')).toHaveText('已取消导出。');
    const blocked = info.outputPath('blocked'); await writeFile(blocked, 'keep');
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, join(blocked, '日志.txt'));
    await exports.getByRole('button', { name: '导出日志', exact: true }).click();
    await expect(exports.getByRole('alert')).toContainText('操作失败');
    expect(await readFile(blocked, 'utf8')).toBe('keep');
    await page.screenshot({ path: info.outputPath('diagnostic-export.png') });
    await page.getByRole('button', { name: '程序维护', exact: true }).click();
    const maintenance = page.getByRole('region', { name: '程序维护设备面板', exact: true });
    await expect(maintenance.getByRole('button', { name: /导出/ })).toHaveCount(0);
    await expect(maintenance.getByRole('heading', { name: '联动台预览没有画面', exact: true })).toBeVisible();
    await expect(maintenance.getByLabel('OBS Studio 可执行文件', { exact: true })).not.toBeVisible();
    await expect(maintenance.getByLabel('最多等待启动（秒）').first()).not.toBeVisible();
    await page.screenshot({ path: info.outputPath('program-maintenance.png') });
    await maintenance.getByText('无法自动启动 OBS Studio？设置程序位置', { exact: true }).click();
    await expect(maintenance.getByLabel('OBS Studio 可执行文件', { exact: true })).toBeVisible();
    const obsSettings = maintenance.locator('.device-program-card.obs');
    await obsSettings.getByText('技术参数（排查启动问题时使用）', { exact: true }).click();
    await obsSettings.getByLabel('最多等待启动（秒）', { exact: true }).fill('2.5');
    await obsSettings.getByLabel('最多等待关闭（秒）', { exact: true }).fill('4');
    await maintenance.getByRole('button', { name: '保存启动设置', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.obs.startupTimeoutMs)).toBe(2500);
    expect(await page.evaluate(async () => (await window.tbLink.loadIntegrationProfile())?.obs.shutdownTimeoutMs)).toBe(4000);
  } finally { await application.close(); }
});

test('未激活主机可记录界面错误并导出，关闭重开仍能查看历史记录', async ({}, info) => {
  const profile = info.outputPath('profile');
  for (const round of [0, 1]) {
    const application = await electron.launch({ env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '0' },
      args: [`--user-data-dir=${profile}`, join(process.cwd(), 'out/main/index.cjs')] });
    try {
      const page = await application.firstWindow();
      await page.getByRole('heading', { name: '激活团播联动台', exact: true }).waitFor();
      if (!round) await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: '诊断验收：界面错误', error: new Error('诊断验收：界面错误') })));
      await page.getByRole('button', { name: '运行日志', exact: true }).click();
      await expect(page.getByText('界面异常：诊断验收：界面错误', { exact: true })).toBeVisible();
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      const destination = info.outputPath(`未激活-${round}.tbdiag.gz`);
      await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, destination);
      await page.getByRole('button', { name: '导出诊断包', exact: true }).click();
      await expect(page.getByRole('status')).toContainText(destination);
      expect(gunzipSync(await readFile(destination)).toString('utf8')).toContain('诊断验收：界面错误');
      await expect(page.evaluate(() => window.tbLink.requireOutputLicense())).rejects.toThrow('有效授权');
    } finally { await application.close(); }
  }
});
