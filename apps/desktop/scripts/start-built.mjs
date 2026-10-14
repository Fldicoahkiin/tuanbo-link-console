import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The GUI outlives its launcher. Inheriting a short-lived terminal's pipes causes
// Electron's IPC error reporting to throw EPIPE after that terminal exits.
export async function launchDetachedDesktop(executable, args, { cwd, logDirectory, windowsHide = false }) {
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(logDirectory, `desktop-${Date.now()}-${process.pid}.log`);
  const output = openSync(logPath, 'ax', 0o600);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(executable, args, {
      cwd, env, detached: true, windowsHide, shell: false,
      stdio: ['ignore', output, output]
    });
    await once(child, 'spawn');
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    // The child owns its inherited file handles independently of this process.
    closeSync(output);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!existsSync(join(desktop, 'out/main/index.cjs')) || !existsSync(join(desktop, 'out/renderer/index.html'))) {
    throw new Error('开发版尚未构建，请先运行 pnpm build。');
  }
  const require = createRequire(import.meta.url);
  const result = await launchDetachedDesktop(require('electron'), ['.'], {
    cwd: desktop,
    logDirectory: resolve(desktop, '../../artifacts/desktop-launch')
  });
  console.log(JSON.stringify(result));
}
