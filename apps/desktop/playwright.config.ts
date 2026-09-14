/**
 * Playwright 配置 —— Electron e2e smoke。
 *
 * 测试通过 `_electron.launch()` 启动 Windows 构建产物，单 worker 避免多个桌面实例互相干扰。
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test-e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  }
});
