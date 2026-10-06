import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // Windows 文件与原生进程测试共享磁盘；限制并发，避免高核机器耗尽 I/O。
    maxWorkers: 4,
    // 排除 e2e（Playwright spec）；vitest 不会跑它，由 playwright test 单独跑
    exclude: ['**/node_modules/**', '**/dist/**', '**/test-e2e/**'],
    coverage: {
      reporter: ['text', 'html']
    }
  },
  resolve: {
    alias: {
      '@tb/core/link': resolve(__dirname, 'packages/core/src/link-public.ts'),
      '@tb/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@tb/core/contracts': resolve(__dirname, 'packages/core/src/contracts.ts'),
      '@tb/schema': resolve(__dirname, 'packages/schema/src/index.ts')
    }
  }
});
