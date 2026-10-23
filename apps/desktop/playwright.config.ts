/**
 * Playwright 配置 —— Electron e2e smoke。
 *
 * 测试通过 `_electron.launch()` 启动 Windows 构建产物，单 worker 避免多个桌面实例互相干扰。
 */

import { defineConfig } from '@playwright/test';

// Launches inherit this instead of whatever the caller's shell holds; license
// specs that need the real gate pass TBLINK_LOCAL_TEST_ACCESS='0' explicitly.
process.env.TBLINK_LOCAL_TEST_ACCESS = '1';

export default defineConfig({
  testDir: './test-e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // DOM snapshots wait for every pending response when the context closes; a page still streaming its audio
    // then held the close until the 60-second timeout and hid the failed assertion. Actions and screenshots stay.
    trace: { mode: 'retain-on-failure', snapshots: false },
    video: 'retain-on-failure'
  }
});
