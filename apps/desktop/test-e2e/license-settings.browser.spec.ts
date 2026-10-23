import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let script = '';
let styles = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { LicenseSettings } from './src/renderer/src/link/components/LicenseSettings'; import { LicenseGate } from './src/renderer/src/link/components/LicenseGate';
      const root = createRoot(document.getElementById('root'));
      window.renderLicense = active => root.render(React.createElement('main', { className: 'device-console settings-content-page' }, React.createElement('div', { className: 'device-detail' }, React.createElement('div', { className: 'device-panel' }, React.createElement(LicenseSettings, { runtimeActive: active }))))); window.renderLicense(false);
      window.renderGate = () => root.render(React.createElement(LicenseGate, null, React.createElement('div', { 'data-testid': 'workspace' }, '付费工作区')));`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.webp': 'dataurl' },
    alias: { '@tb/schema': resolve('../../packages/schema/src/index.ts') }
  });
  script = result.outputFiles[0]!.text;
  styles = (await Promise.all(['link.css', 'project-workspace.css', 'appearance.css', 'home-layout.css', 'settings-content.css', 'lighting.css', 'properties.css', 'device-connections.css', 'timeline-editing.css', 'interface.css'].map(file => readFile(resolve('src/renderer/src/link', file), 'utf8')))).join('\n');
});
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: styles });
  await page.evaluate(() => {
    const base = { machineCode: `TB1-${'A'.repeat(64)}`, state: 'inactive', claims: null, message: '本机尚未激活', enforcement: 'required', onlineAvailable: true };
    let current: { state: string; claims: unknown; machineCode: string; message: string; enforcement: string; onlineAvailable: boolean } = base;
    Object.defineProperty(window, 'tbLink', { configurable: true, value: {
      getLicenseStatus: () => Promise.resolve(current),
      listPurchases: () => Promise.resolve([]),
      getPurchaseCatalog: () => Promise.resolve({ available: false, currency: 'CNY', termStart: 'fulfillment', offers: [] }),
      requireOutputLicense: () => current.state === 'active' ? Promise.resolve() : Promise.reject(new Error('使用团播联动台需要有效授权')),
      activateLicenseCode: (code: string) => {
        if (code !== `TBA-${'A'.repeat(32)}`) return Promise.reject(new Error('激活码已绑定其他机器，请联系发行方办理换机'));
        current = { ...base, state: 'active', message: '本机授权有效', claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '验收公司', machineCode: base.machineCode, kind: 'perpetual', issuedAt: '2026-09-27T00:00:00Z', useUntil: null, updatesUntil: '2027-09-27T00:00:00Z', online: { customerType: 'company', leaseUntil: '2026-10-04T00:00:00Z' } } };
        return Promise.resolve(current);
      },
      refreshOnlineLicense: () => { current = { ...current, state: 'renewal-required', message: '无法连接授权服务器，请检查网络后手动重试' }; return Promise.reject(new Error('无法连接授权服务器，现有授权保持不变')); },
      exportLicenseRequest: () => Promise.resolve(true), importLicense: () => Promise.resolve(null),
      getUpdateStatus: () => Promise.resolve({ phase: 'available', currentVersion: '0.5.0', availableVersion: '0.5.1', releaseDate: '2026-11-02T00:00:00.000Z',
        progressPercent: null, transferredBytes: null, totalBytes: null, feedConfigured: true, message: '发现新版本 0.5.1',
        installBlockedReason: '本机授权当前不可用（本机尚未激活），可以查看新版本，恢复授权后再安装' }),
      onUpdateStatus: () => () => undefined,
      getAppInfo: () => Promise.resolve({ name: '团播联动台', version: '0.5.0', channel: 'release', gitSha: '0123456789abcdef0123456789abcdef01234567', appId: 'com.tuanbo.control' })
    } });
  });
  await page.addScriptTag({ content: script });
});

test('激活成功展示企业与凭证期限、清空密钥，网络失败显示需要验证', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: '本机授权', exact: true });
  await panel.getByLabel('激活码', { exact: true }).fill(`TBA-${'A'.repeat(32)}`);
  await panel.getByRole('button', { name: '激活本机' }).click();
  await expect(panel.getByText('验收公司', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('激活码', { exact: true })).toHaveValue('');
  await expect(panel.getByText(/本次签名凭证有效至/)).toBeVisible();
  await panel.getByRole('button', { name: '联网验证授权' }).click();
  await expect(panel.getByRole('alert')).toContainText('现有授权保持不变');
  await expect(panel.getByText('需要联网验证', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('license-settings.png') });
});
test('错误激活码明确反馈，运行中禁用激活、联网验证与导入', async ({ page }) => {
  const input = page.getByLabel('激活码', { exact: true });
  await input.fill(`TBA-${'B'.repeat(32)}`);
  await page.getByRole('button', { name: '激活本机' }).click();
  await expect(page.getByRole('alert')).toContainText('已绑定其他机器');
  await page.evaluate('window.renderLicense(true)');
  await expect(input).toBeDisabled();
  await page.getByText('本机信息与授权文件', { exact: true }).click();
  for (const name of ['激活本机', '联网验证授权', '导入授权文件']) await expect(page.getByRole('button', { name })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出授权申请' })).toBeEnabled();
});

test('未激活不挂载工作区，激活后经主进程校验才进入', async ({ page }, info) => {
  await page.evaluate('window.renderGate()');
  await expect(page.getByRole('heading', { name: '激活你的工作区' })).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '购买授权', exact: true })).toHaveAttribute('href', 'https://tuanbo-link.jinhefilm.com/#purchase');
  await expect(page.getByRole('link', { name: '官网了解产品' })).toHaveAttribute('href', 'https://tuanbo-link.jinhefilm.com/');
  await expect(page.getByRole('button', { name: '运行日志' })).toHaveCount(0);
  const updates = page.getByRole('region', { name: '软件更新', exact: true });
  await expect(updates.getByText('发现新版本 0.5.1', { exact: true })).toBeVisible();
  await expect(updates.getByText('本机授权当前不可用（本机尚未激活），可以查看新版本，恢复授权后再安装', { exact: true })).toBeVisible();
  await expect(updates.getByRole('button', { name: '下载更新' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('license-gate.png'), fullPage: true });
  await page.getByLabel('激活码', { exact: true }).fill(`TBA-${'A'.repeat(32)}`);
  await page.getByRole('button', { name: '激活本机' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByRole('heading', { name: '激活你的工作区' })).toHaveCount(0);
});


test('启动校验完成前不挂载工作区，网络失败后可手动验证进入', async ({ page }) => {
  await page.evaluate(() => {
    const bridge = window.tbLink;
    let verified = false;
    Object.defineProperty(window, 'tbLink', { configurable: true, value: {
      ...bridge,
      requireOutputLicense: () => verified ? Promise.resolve() : Promise.reject(new Error('无法连接授权服务器，请检查网络后手动重试')),
      refreshOnlineLicense: async () => {
        const status = await bridge.activateLicenseCode(`TBA-${'A'.repeat(32)}`);
        verified = true;
        return status;
      }
    } });
  });
  await page.evaluate('window.renderGate()');
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  await expect(page.getByText('无法连接授权服务器，请检查网络后手动重试', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '联网验证授权' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test('联网检查进行中只展示等待页', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window.tbLink, 'requireOutputLicense', { value: () => new Promise<void>(resolve => {
      Object.defineProperty(window, 'finishStartup', { configurable: true, value: resolve });
    }) });
  });
  await page.evaluate('window.renderGate()');
  await expect(page.getByText('正在核对本机授权', { exact: true })).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  await page.evaluate('window.finishStartup()');
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test('激活页保持标题栏可拖动、窗口按钮可用，小窗口可滚动输入', async ({ page }, info) => {
  await page.evaluate(() => {
    const actions: string[] = [];
    Object.defineProperty(window, 'windowActions', { value: actions });
    Object.defineProperty(window.tbLink, 'controlWindow', { value: (action: string) => { actions.push(action); return Promise.resolve(); } });
  });
  await page.evaluate('window.renderGate()');
  const preview = page.getByRole('img', { name: /团播联动台真实界面/ });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1440);
  const titlebar = page.getByRole('banner', { name: '窗口标题栏' });
  await expect(titlebar).toBeVisible();
  expect(await titlebar.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('drag');
  for (const name of ['最小化窗口', '最大化或还原窗口', '关闭软件']) {
    const button = page.getByRole('button', { name, exact: true });
    expect(await button.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
    await button.click();
  }
  expect(await page.evaluate('window.windowActions')).toEqual(['minimize', 'toggleMaximize', 'close']);
  await expect(page.getByLabel('本机机器码')).not.toBeVisible();
  await page.getByText('本机信息与授权文件', { exact: true }).click();
  await expect(page.getByLabel('本机机器码')).toBeVisible();
  await page.getByText('本机信息与授权文件', { exact: true }).click();
  await page.screenshot({ path: info.outputPath('activation-desktop.png') });
  await page.setViewportSize({ width: 720, height: 580 });
  await page.getByLabel('激活码', { exact: true }).fill('TBA-INVALID');
  await page.getByRole('button', { name: '显示激活码' }).click();
  await expect(page.getByLabel('激活码', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏激活码' }).click();
  await page.getByRole('button', { name: '激活本机', exact: true }).click();
  await expect(page.getByRole('region', { name: '本机授权', exact: true }).getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: '本机授权', exact: true }).getByRole('alert')).toHaveText('请输入完整激活码，格式为 TBA- 加 32 位字符');
  await expect(titlebar).toBeInViewport();
  expect(await page.locator('.license-page-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('activation-compact.png') });
  await page.evaluate('window.renderLicense(false)');
  await expect(page.getByRole('heading', { name: '一台主机，一份授权' })).toBeVisible();
  await page.evaluate('window.renderGate()');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('heading', { name: '激活你的工作区' })).toBeVisible();
  await page.locator('.license-page-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('activation-light.png') });
});

test('非有效授权不显示成功、不清除输入，也不进入工作区', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window.tbLink, 'activateLicenseCode', { value: async () => ({
      ...await window.tbLink.getLicenseStatus(), state: 'expired', message: '授权已到期，请续费后验证'
    }) });
  });
  await page.evaluate('window.renderGate()');
  await page.getByLabel('激活码', { exact: true }).fill(`TBA-${'A'.repeat(32)}`);
  await page.getByRole('button', { name: '激活本机' }).click();
  await expect(page.getByLabel('激活码', { exact: true })).toHaveValue(`TBA-${'A'.repeat(32)}`);
  await expect(page.getByRole('region', { name: '本机授权', exact: true }).getByRole('alert')).toHaveText('授权已到期，请续费后验证');
  await expect(page.getByText('授权已验证并保存到本机。')).toHaveCount(0);
  await expect(page.getByTestId('workspace')).toHaveCount(0);
});

async function configurePurchase(page: Page, mode: 'success' | 'lost' | 'failed-storage'): Promise<void> {
  await page.evaluate(mode => {
    const offer = { id: 'test-only', revision: 'test-1', name: '浏览器测试授权', unitAmountFen: 100,
      kind: 'perpetual' as const, useDays: null, updatesDays: 365, maxQuantity: 5, saleUntil: '2099-12-31T00:00:00Z' };
    let records: import('@tb/schema').PurchaseReceipt[] = [];
    let opens = 0; let creates = 0;
    Object.defineProperty(window, 'purchaseCounts', { configurable: true, value: () => ({ opens, creates }) });
    Object.defineProperty(window, 'tbLink', { configurable: true, value: {
      ...window.tbLink,
      listPurchases: () => Promise.resolve(records),
      getPurchaseCatalog: () => Promise.resolve({ available: true, currency: 'CNY', termStart: 'fulfillment', offers: [offer] }),
      createPurchase: (request: import('@tb/schema').PurchaseRequest) => {
        creates += 1;
        if (mode === 'failed-storage') return Promise.reject(new Error('Windows 安全存储不可用，不能保存凭证'));
        const record: import('@tb/schema').PurchaseReceipt = { localId: 'bbc5c1a4-64aa-4322-9cf3-38a19035d1e0',
          createdAt: '2026-09-28T00:00:00Z', request, rejected: false, delivery: null,
          order: mode === 'lost' ? null : { id: '4c809a80-1776-4999-9145-31d4b95cdc35', offer, state: 'pending', amountFen: request.quantity * 100, quantity: request.quantity, expiresAt: '2099-12-31T00:00:00Z', payable: true } };
        records = [record];
        return mode === 'lost' ? Promise.reject(new Error('购买服务连接失败，原购买记录已保留')) : Promise.resolve(record);
      },
      openPurchasePayment: () => { opens += 1; return Promise.resolve(); },
      copyPurchaseCode: (_localId: string, licenseId: string) => {
        Object.defineProperty(window, 'copiedPurchaseLicense', { configurable: true, value: licenseId });
        return Promise.resolve();
      },
      refreshPurchase: () => {
        const record = records[0]; if (!record) return Promise.reject(new Error('无订单'));
        const order: NonNullable<import('@tb/schema').PurchaseReceipt['order']> = { id: '4c809a80-1776-4999-9145-31d4b95cdc35', offer, state: 'fulfilled', amountFen: record.request.quantity * 100, quantity: record.request.quantity, expiresAt: '2099-12-31T00:00:00Z', payable: false };
        const result: import('@tb/schema').PurchaseReceipt = { ...record, order, delivery: {
          id: order.id, state: 'fulfilled', amountFen: order.amountFen, quantity: order.quantity, kind: 'perpetual', useUntil: null, updatesUntil: '2027-09-28T00:00:00Z',
          licenses: Array.from({ length: order.quantity }, (_, index) => ({ id: index === 0 ? '4398b2a0-9f7a-41fb-a57c-df3d5d222747' : '4747d19b-01ea-4e02-a90d-e9f0b4e11870', code: `TBA-${'A'.repeat(32)}`, revoked: false }))
        } };
        records = [result]; return Promise.resolve(result);
      }
    } });
  }, mode);
}

test('未配置购买时明确提示，保留手工激活入口且不展示测试商品', async ({ page }) => {
  await page.locator('.license-disclosure').filter({ has: page.getByText('购买授权与查询订单', { exact: true }) }).evaluate(element => { if (element instanceof HTMLDetailsElement) element.open = true; });
  await page.getByRole('button', { name: '查看可售授权' }).click();
  await expect(page.getByText('购买尚未开放，请联系发行方。已有订单仍可查询。')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建购买订单' })).toHaveCount(0);
  await expect(page.getByLabel('激活码', { exact: true })).toBeEnabled();
});

test('确认服务器价格后建单，显式打开付款页和领取，不自动绑定企业席位', async ({ page }, info) => {
  await configurePurchase(page, 'success');
  await page.locator('.license-disclosure').filter({ has: page.getByText('购买授权与查询订单', { exact: true }) }).evaluate(element => { if (element instanceof HTMLDetailsElement) element.open = true; });
  await page.getByRole('button', { name: '查看可售授权' }).click();
  await page.getByLabel('购买主体').selectOption('company');
  await page.getByLabel('授权客户名称').fill('浏览器测试企业');
  await page.getByLabel('机器数量', { exact: true }).fill('2');
  await expect(page.getByText(/含税总价 ¥2.00/)).toBeVisible();
  await expect(page.getByRole('button', { name: '创建购买订单' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '我已核对价格、机器数量与授权期限' }).check();
  await page.getByRole('button', { name: '创建购买订单' }).click();
  await expect(page.getByText('待付款或核对', { exact: true })).toBeVisible();
  expect(await page.evaluate('window.purchaseCounts()')).toEqual({ opens: 0, creates: 1 });
  await page.getByRole('button', { name: '打开支付宝付款页' }).click();
  expect(await page.evaluate('window.purchaseCounts()')).toEqual({ opens: 1, creates: 1 });
  await page.getByRole('button', { name: '查询付款并领取' }).click();
  await expect(page.getByText('已付款，可领取激活码', { exact: true })).toBeVisible();
  await expect(page.getByLabel('激活码', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '填入本机激活栏' })).toHaveCount(2);
  await page.getByRole('button', { name: '复制激活码', exact: true }).first().click();
  expect(await page.evaluate('window.copiedPurchaseLicense')).toBe('4398b2a0-9f7a-41fb-a57c-df3d5d222747');
  await page.getByRole('button', { name: '填入本机激活栏' }).first().click();
  await expect(page.getByLabel('激活码', { exact: true })).toHaveValue(`TBA-${'A'.repeat(32)}`);
  await expect(page.getByLabel('激活码', { exact: true })).toBeFocused();
  await expect(page.getByText('未激活', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('purchase-delivery.png'), fullPage: true });
  await page.evaluate('window.renderLicense(true)');
  for (const button of await page.getByRole('button', { name: '填入本机激活栏' }).all()) await expect(button).toBeDisabled();
});

test('响应丢失后展示恢复入口并阻止重复建单，恢复后领取原订单', async ({ page }) => {
  await configurePurchase(page, 'lost');
  await page.locator('.license-disclosure').filter({ has: page.getByText('购买授权与查询订单', { exact: true }) }).evaluate(element => { if (element instanceof HTMLDetailsElement) element.open = true; });
  await page.getByRole('button', { name: '查看可售授权' }).click();
  await page.getByLabel('授权客户名称').fill('测试购买人');
  await page.getByRole('checkbox', { name: '我已核对价格、机器数量与授权期限' }).check();
  await page.getByRole('button', { name: '创建购买订单' }).click();
  await expect(page.getByText('结果待确认，请恢复原订单', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建购买订单' })).toBeDisabled();
  await page.getByRole('button', { name: '恢复原订单' }).click();
  await expect(page.getByText('已付款，可领取激活码', { exact: true })).toBeVisible();
  expect(await page.evaluate('window.purchaseCounts()')).toEqual({ opens: 0, creates: 1 });
});

test('安全存储失败不出现虚构订单或付款入口', async ({ page }) => {
  await configurePurchase(page, 'failed-storage');
  await page.locator('.license-disclosure').filter({ has: page.getByText('购买授权与查询订单', { exact: true }) }).evaluate(element => { if (element instanceof HTMLDetailsElement) element.open = true; });
  await page.getByRole('button', { name: '查看可售授权' }).click();
  await page.getByLabel('授权客户名称').fill('测试购买人');
  await page.getByRole('checkbox', { name: '我已核对价格、机器数量与授权期限' }).check();
  await page.getByRole('button', { name: '创建购买订单' }).click();
  await expect(page.getByRole('alert')).toContainText('安全存储不可用');
  await expect(page.getByRole('button', { name: '打开支付宝付款页' })).toHaveCount(0);
  await expect(page.getByText('本机暂无购买记录。')).toBeVisible();
});
