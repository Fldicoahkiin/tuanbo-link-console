import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/link-main.ts')
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
});
