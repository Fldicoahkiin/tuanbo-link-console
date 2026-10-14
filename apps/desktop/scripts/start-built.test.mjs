import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { launchDetachedDesktop } from './start-built.mjs';

test('GUI output remains writable after its launcher exits, including with ELECTRON_RUN_AS_NODE inherited', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-launch-'));
  const worker = `setTimeout(() => {
    console.log('stdout-after-launcher-exit');
    console.error('stderr-after-launcher-exit');
    if (process.env.ELECTRON_RUN_AS_NODE !== undefined) process.exit(3);
    require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'done'))}, 'ok');
  }, 500);`;
  const launcher = `import { launchDetachedDesktop } from ${JSON.stringify(new URL('./start-built.mjs', import.meta.url).href)};
    const result = await launchDetachedDesktop(process.execPath, ['-e', ${JSON.stringify(worker)}], ${JSON.stringify({ cwd: directory, logDirectory: directory, windowsHide: true })});
    console.log(JSON.stringify(result));`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', launcher], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  parent.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  parent.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [code] = await once(parent, 'close');
  assert.equal(code, 0, stderr);
  const { logPath } = JSON.parse(stdout);
  let contents = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    contents = await readFile(logPath, 'utf8');
    if (contents.includes('stderr-after-launcher-exit')) break;
    await setTimeout(50);
  }
  assert.match(contents, /stdout-after-launcher-exit/);
  assert.match(contents, /stderr-after-launcher-exit/);
  assert.equal(await readFile(join(directory, 'done'), 'utf8'), 'ok');
});

test('failed executable launch rejects rather than reporting successful startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-launch-error-'));
  await assert.rejects(launchDetachedDesktop(join(directory, 'missing.exe'), [], {
    cwd: directory, logDirectory: directory
  }), { code: 'ENOENT' });
});
