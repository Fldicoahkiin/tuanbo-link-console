import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Keep the release fuses unchanged. CDP observes the actual packaged renderer;
// no Node inspector, app.asar edits, or substituted beauty IPC handlers.
export async function launchPackagedDesktop({ executable, directory, chromium }) {
  const child = spawn(executable, [`--user-data-dir=${join(directory, 'desktop-profile')}`, '--remote-debugging-port=0', '--enable-logging=stderr'],
    { cwd: dirname(executable), env: { ...process.env, ProgramData: join(directory, 'desktop-system-data') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', endpoint, startup;
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const ready = new Promise(resolve => { endpoint = resolve; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output = (output + chunk.toString('utf8')).slice(-32000);
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(output);
    if (match) endpoint(match[1]);
  });
  await writeFile(join(directory, 'packaged-desktop-process.json'), JSON.stringify({ pid: child.pid, executable, launchedAt: new Date().toISOString() }, null, 2));
  let browser, page;
  try {
    const url = await Promise.race([ready, exit.then(result => { throw new Error(`Packaged desktop exited before debugging was ready: ${JSON.stringify(result)}`); }),
      new Promise((_, reject) => { startup = setTimeout(() => reject(new Error(`Packaged desktop CDP startup timed out; PID ${child.pid} retained`)), 15000); })]);
    clearTimeout(startup);
    browser = await chromium.connectOverCDP(url);
    const deadline = Date.now() + 15000;
    while (!page && Date.now() < deadline) {
      page = browser.contexts().flatMap(context => context.pages())[0];
      if (!page) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!page) throw new Error(`Packaged desktop did not open a page; PID ${child.pid} retained`);
  } catch (error) {
    clearTimeout(startup);
    await writeFile(join(directory, 'packaged-desktop-log.txt'), output);
    if (browser) await browser.close();
    throw error;
  }
  return {
    firstWindow: async () => page,
    close: async () => {
      let timeout;
      try {
        if (!page.isClosed()) await page.evaluate(() => globalThis.window.tbLink.controlWindow('close')).catch(error => { if (!page.isClosed()) throw error; });
        const result = await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Packaged desktop did not close; PID ${child.pid} retained`)), 8000); })]);
        if (result.code !== 0) throw new Error(`Packaged desktop exit failed: ${JSON.stringify(result)}`);
      } finally {
        clearTimeout(timeout);
        await browser.close();
        await writeFile(join(directory, 'packaged-desktop-log.txt'), output);
      }
    }
  };
}
