import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run isolated Electron fixtures. Never attach to or edit the operator's open project.
const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const child = spawn(windows ? 'pnpm.cmd' : 'pnpm', ['--filter', '@tb/desktop', 'test:e2e', 'settings-redesign.spec.ts', '--output=test-results-settings-redesign'], { cwd: root, stdio: 'inherit', shell: windows });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
