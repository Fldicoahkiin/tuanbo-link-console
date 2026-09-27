import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let script = '';
let styles = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { LicenseSettings } from './src/renderer/src/link/components/LicenseSettings'; import { LicenseGate } from './src/renderer/src/link/components/LicenseGate';
      const root = createRoot(document.getElementById('root'));
      window.renderLicense = active => root.render(React.createElement(LicenseSettings, { runtimeActive: active })); window.renderLicense(false);
      window.renderGate = () => root.render(React.createElement(LicenseGate, null, React.createElement('div', { 'data-testid': 'workspace' }, '付费工作区')));`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@tb/schema': resolve('../../packages/schema/src/index.ts') }
  });
  script = result.outputFiles[0]!.text;
  styles = (await Promise.all(['link.css', 'appearance.css', 'interface.css', 'device-connections.css', 'settings-content.css'].map(file => readFile(resolve('src/renderer/src/link', file), 'utf8')))).join('\n');
});
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent('<main class="device-console settings-content-page"><div class="device-detail"><div class="device-panel" id="root"></div></div></main>');
  await page.addStyleTag({ content: styles });
  await page.evaluate(() => {
    const base = { machineCode: `TB1-${'A'.repeat(64)}`, state: 'inactive', claims: null, message: '本机尚未激活', enforcement: 'required', onlineAvailable: true };
    let current: { state: string; claims: unknown; machineCode: string; message: string; enforcement: string; onlineAvailable: boolean } = base;
    Object.defineProperty(window, 'tbLink', { configurable: true, value: {
      getLicenseStatus: () => Promise.resolve(current),
      requireOutputLicense: () => current.state === 'active' ? Promise.resolve() : Promise.reject(new Error('使用团播联动台需要有效授权')),
      activateLicenseCode: (code: string) => {
        if (code !== `TBA-${'A'.repeat(32)}`) return Promise.reject(new Error('激活码已绑定其他机器，请联系发行方办理换机'));
        current = { ...base, state: 'active', message: '本机授权有效', claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '验收公司', machineCode: base.machineCode, kind: 'perpetual', issuedAt: '2026-09-27T00:00:00Z', useUntil: null, updatesUntil: '2027-09-27T00:00:00Z', online: { customerType: 'company', leaseUntil: '2026-10-04T00:00:00Z' } } };
        return Promise.resolve(current);
      },
      refreshOnlineLicense: () => Promise.reject(new Error('无法连接授权服务器，现有授权保持不变')),
      exportLicenseRequest: () => Promise.resolve(true), importLicense: () => Promise.resolve(null)
    } });
  });
  await page.addScriptTag({ content: script });
});

test('激活成功展示企业与离线期限、清空密钥，网络失败保留已激活状态', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: '本机授权', exact: true });
  await panel.getByLabel('激活码', { exact: true }).fill(`TBA-${'A'.repeat(32)}`);
  await panel.getByRole('button', { name: '激活本机' }).click();
  await expect(panel.getByText('验收公司', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('激活码', { exact: true })).toHaveValue('');
  await expect(panel.getByText(/本次离线凭证有效至/)).toBeVisible();
  await panel.getByRole('button', { name: '联网验证授权' }).click();
  await expect(panel.getByRole('alert')).toContainText('现有授权保持不变');
  await expect(panel.getByText('已激活', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('license-settings.png') });
});
test('错误激活码明确反馈，运行中禁用激活、联网验证与导入', async ({ page }) => {
  const input = page.getByLabel('激活码', { exact: true });
  await input.fill(`TBA-${'B'.repeat(32)}`);
  await page.getByRole('button', { name: '激活本机' }).click();
  await expect(page.getByRole('alert')).toContainText('已绑定其他机器');
  await page.evaluate('window.renderLicense(true)');
  await expect(input).toBeDisabled();
  for (const name of ['激活本机', '联网验证授权', '导入授权文件']) await expect(page.getByRole('button', { name })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出授权申请' })).toBeEnabled();
});

test('未激活不挂载工作区，激活后经主进程校验才进入', async ({ page }, info) => {
  await page.evaluate('window.renderGate()');
  await expect(page.getByRole('heading', { name: '激活团播联动台' })).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  await expect(page.getByText('本软件所有产品功能均需付费激活', { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath('license-gate.png') });
  await page.getByLabel('激活码', { exact: true }).fill(`TBA-${'A'.repeat(32)}`);
  await page.getByRole('button', { name: '激活本机' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByRole('heading', { name: '激活团播联动台' })).toHaveCount(0);
});
