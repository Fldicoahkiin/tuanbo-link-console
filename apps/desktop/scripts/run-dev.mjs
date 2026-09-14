#!/usr/bin/env node
// 启动 electron-vite dev 的安全包装。
//
// 修复：某些 shell 环境（比如部分 IDE / agent 的子 shell）会预设
// ELECTRON_RUN_AS_NODE=1，导致启动后 Electron 二进制以纯 Node 模式运行，
// 主进程 require('electron') 拿不到 protocol/app/BrowserWindow 等 API，
// 立即在 registerSchemesAsPrivileged 处崩溃。
//
// 这里在 spawn 子进程前显式删掉这个变量，确保 dev 始终拿到完整 Electron API。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const electronViteBin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

const child = spawn(process.execPath, [electronViteBin, 'dev', ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: false
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[run-dev] failed to spawn electron-vite:', err);
  process.exit(1);
});
