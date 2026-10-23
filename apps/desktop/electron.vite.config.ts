import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const release = mode === 'release';
  // A leftover test-channel variable must not turn an official build into an activation-free package.
  if (release && process.env.TBLINK_INTERNAL_DISTRIBUTION_FILE) throw new Error('正式构建不能携带 TBLINK_INTERNAL_DISTRIBUTION_FILE');
  return {
    main: {
      define: {
        __TBLINK_INTERNAL_DISTRIBUTION__: process.env.TBLINK_INTERNAL_DISTRIBUTION_FILE ? readFileSync(resolve(process.env.TBLINK_INTERNAL_DISTRIBUTION_FILE), 'utf8') : 'null',
        __TBLINK_LOCAL_TEST_ACCESS__: JSON.stringify(!release),
        __TBLINK_GIT_SHA__: JSON.stringify(gitRevision(release))
      },
      build: {
        sourcemap: false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/link-main.ts'),
            'waveform-worker': resolve(__dirname, 'src/main/link/waveform-worker.ts'),
            'project-document-worker': resolve(__dirname, 'src/main/link/project-document-worker.ts')
          },
          external: ['ffmpeg-static'],
          // 必须打成 CJS：包根 package.json 是 "type": "module"，
          // 打成 ESM 时 Electron 在 ESM 上下文里 `import { BrowserWindow } from 'electron'`
          // 走 Node ESM loader 直接报 "does not provide an export named 'BrowserWindow'"
          // —— 因为 node_modules/electron 的 index.js 只导出 binary path，名称导出靠 Electron
          // 运行时拦截 require('electron') 才有，所以主进程统一走 CJS 最稳。
          // .cjs 后缀让 Node 永远按 CJS 解析，绕开包级 type:module 设置。
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
            chunkFileNames: 'chunks/[name]-[hash].cjs'
          }
        }
      },
      resolve: {
        alias: {
          '@tb/core/link': resolve(__dirname, '../../packages/core/src/link-public.ts'),
          '@tb/core': resolve(__dirname, '../../packages/core/src/index.ts'),
          '@tb/schema': resolve(__dirname, '../../packages/schema/src/index.ts')
        }
      }
    },
    preload: {
      build: {
        sourcemap: false,
        rollupOptions: {
          output: {
            format: 'cjs'
          }
        }
      },
      resolve: {
        alias: {
          '@tb/core/link': resolve(__dirname, '../../packages/core/src/link-public.ts'),
          '@tb/core': resolve(__dirname, '../../packages/core/src/index.ts'),
          '@tb/schema': resolve(__dirname, '../../packages/schema/src/index.ts')
        }
      }
    },
    renderer: {
      plugins: [react()],
      resolve: {
        alias: {
          '@tb/core/link': resolve(__dirname, '../../packages/core/src/link-public.ts'),
          '@tb/core': resolve(__dirname, '../../packages/core/src/index.ts'),
          '@tb/schema': resolve(__dirname, '../../packages/schema/src/index.ts')
        }
      }
    }
  };
});

/** The commit shown in logs, diagnostics and the update panel. A release build without Git is refused. */
function gitRevision(release: boolean): string | null {
  try {
    const git = (args: string[]): string => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
    const sha = git(['rev-parse', 'HEAD']);
    return git(['status', '--porcelain']) ? `${sha}-dirty` : sha;
  } catch (error) {
    if (release) throw new Error(`正式构建需要读取 Git 提交号：${error instanceof Error ? error.message : String(error)}`);
    console.warn(`未能读取 Git 提交号，本次开发构建不记录提交号：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
