import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LinkUpdateStatus } from '@tb/core/link';
import type { ReleaseNote } from '../../../scripts/release-notes.mjs';

const releaseNotes: ReleaseNote[] = [
  { version: '0.4.27', blocks: [{ kind: 'list', items: [[{ text: '同步', strong: true }, { text: '：以时间线为准。', strong: false }]] }] },
  { version: '0.4.26', blocks: [{ kind: 'paragraph', content: [{ text: '上一版的说明。', strong: false }] }] }
];

let script = '';
let styles = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { UpdateCenter } from './src/renderer/src/link/components/UpdateCenter'; createRoot(document.getElementById('root')).render(React.createElement(UpdateCenter, { notify: message => { document.getElementById('notice').textContent = message; } }));`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { __TBLINK_RELEASE_NOTES__: JSON.stringify(releaseNotes) }
  });
  script = result.outputFiles[0]!.text;
  styles = (await Promise.all(['link.css', 'appearance.css', 'interface.css'].map(file => readFile(resolve('src/renderer/src/link', file), 'utf8')))).join('\n');
});

test('公司更新无需客户凭证，下载后由用户确认安装，关闭恢复工作区', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent('<main class="app-shell"><div id="root"></div><div id="notice" role="status"></div></main>');
  await page.addStyleTag({ content: styles });
  await page.evaluate(() => {
    const status: LinkUpdateStatus = { phase: 'idle', currentVersion: '0.4.27', availableVersion: null, releaseDate: null, progressPercent: null, transferredBytes: null, totalBytes: null, feedConfigured: true, installBlockedReason: null, message: '可以检查软件更新' };
    Object.defineProperty(window, 'tbLink', { configurable: true, value: {
      getUpdateStatus: () => Promise.resolve(status), onUpdateStatus: () => () => undefined,
      getAppInfo: () => Promise.resolve({ name: '团播联动台', version: '0.4.27', channel: 'release', gitSha: '0123456789abcdef0123456789abcdef01234567', appId: 'com.tuanbo.control' }),
      checkForUpdates: () => Promise.resolve({ ...status, phase: 'available', availableVersion: '0.4.28', message: '发现新版本 0.4.28' }),
      downloadUpdate: () => Promise.resolve({ ...status, phase: 'downloaded', availableVersion: '0.4.28', message: '版本 0.4.28 已下载，确认后重启安装' }),
      installUpdate: () => Promise.reject(new Error('联动尚未停止，请停止联动后再安装更新'))
    } });
  });
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: '软件更新', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
  await expect(page.getByText('团播联动台 · 正式版 · 提交 0123456789ab · com.tuanbo.control', { exact: true })).toBeVisible();
  const notes = page.getByRole('region', { name: '更新日志' });
  await expect(notes.locator('details').first()).toHaveAttribute('open', '');
  await expect(notes.getByText('v0.4.27当前版本', { exact: true })).toBeVisible();
  await expect(notes.getByText('：以时间线为准。')).toBeVisible();
  await expect(notes.getByText('上一版的说明。')).toBeHidden();
  await expect(notes.getByRole('link')).toHaveCount(0);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByText('发现新版本 0.4.28', { exact: true })).toBeVisible();
  await expect(notes.getByRole('link', { name: '在官网查看 0.4.28 的更新内容' })).toHaveAttribute('href', 'https://tuanbo-link.jinhefilm.com/download/#changelog');
  await page.getByRole('button', { name: '下载更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '重启并安装', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('company-update.png') });
  await page.getByRole('button', { name: '重启并安装', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('联动尚未停止');
  await expect(page.getByRole('button', { name: '重启并安装', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '软件更新', exact: true })).toBeEnabled();
  expect(await page.locator('.app-shell').evaluate(element => element.hasAttribute('inert'))).toBe(false);
});

test('超出升级服务期限：显示新版本和原因，不提供下载', async ({ page }) => {
  await page.setContent('<main class="app-shell"><div id="root"></div><div id="notice" role="status"></div></main>');
  await page.addStyleTag({ content: styles });
  await page.evaluate(() => {
    const status: LinkUpdateStatus = { phase: 'available', currentVersion: '0.5.0', availableVersion: '0.5.1', releaseDate: '2026-11-02T00:00:00.000Z', progressPercent: null, transferredBytes: null, totalBytes: null, feedConfigured: true,
      installBlockedReason: '新版本 0.5.1 发布于 2026-11-02，晚于本机授权的升级服务期限 2026-10-31；可以继续使用当前版本，续费延长升级服务后再安装', message: '发现新版本 0.5.1' };
    Object.defineProperty(window, 'tbLink', { configurable: true, value: { getUpdateStatus: () => Promise.resolve(status), onUpdateStatus: () => () => undefined,
      getAppInfo: () => Promise.resolve({ name: '团播联动台', version: '0.5.0', channel: 'development', gitSha: '0123456789abcdef0123456789abcdef01234567-dirty', appId: 'com.tuanbo.control' }) } });
  });
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: '软件更新', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('发现新版本 0.5.1', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/晚于本机授权的升级服务期限 2026-10-31/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '下载更新' })).toHaveCount(0);
  // After renewing, the operator checks again to recompute the term.
  await expect(dialog.getByRole('button', { name: '检查更新' })).toBeEnabled();
  await expect(dialog.getByText('团播联动台 · 开发版 · 提交 0123456789ab-dirty · com.tuanbo.control', { exact: true })).toBeVisible();
});

test('当前版本比更新源新时不显示「可用版本」', async ({ page }) => {
  await page.setContent('<main class="app-shell"><div id="root"></div><div id="notice" role="status"></div></main>');
  await page.addStyleTag({ content: styles });
  await page.evaluate(() => {
    const status: LinkUpdateStatus = { phase: 'upToDate', currentVersion: '0.5.0', availableVersion: '0.4.29', releaseDate: null, progressPercent: null, transferredBytes: null, totalBytes: null, feedConfigured: true,
      installBlockedReason: null, message: '当前已经是最新版本' };
    Object.defineProperty(window, 'tbLink', { configurable: true, value: { getUpdateStatus: () => Promise.resolve(status), onUpdateStatus: () => () => undefined,
      getAppInfo: () => Promise.resolve({ name: '团播联动台', version: '0.5.0', channel: 'release', gitSha: '0123456789abcdef0123456789abcdef01234567', appId: 'com.tuanbo.control' }) } });
  });
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: '软件更新', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('当前版本 0.5.0', { exact: true })).toBeVisible();
});
