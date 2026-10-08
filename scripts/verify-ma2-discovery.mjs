import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

const [executable, output] = process.argv.slice(2);
const directory = resolve(output); await mkdir(directory);
const { chromium, expect } = createRequire(resolve('apps/desktop/package.json'))('@playwright/test');
const application = await launchPackagedDesktop({ executable, directory, chromium });
try {
  const page = await application.firstWindow();
  await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
  const result = await page.evaluate(async () => {
    const api = globalThis.window.tbLink;
    const started = performance.now();
    const first = api.discoverMa2();
    const cancel = new Promise((resolve, reject) => setTimeout(() => api.cancelMa2Discovery().then(resolve, reject), 250));
    const [cancelled] = await Promise.all([first, cancel]);
    const cancellationMs = performance.now() - started;
    // A second explicit search verifies the first released its service lock and sockets.
    const fullStarted = performance.now();
    const discovered = await api.discoverMa2();
    return { cancelled, cancellationMs, discovered, fullSearchMs: performance.now() - fullStarted };
  });
  assert(result.cancelled.warnings.some(message => message.includes('取消')));
  assert(result.cancellationMs < 10000);
  assert(result.fullSearchMs < 50000);
  assert(result.discovered.ranges.some(message => message.includes('本次检查')));
  assert(result.discovered.ranges.some(message => message.startsWith('检查覆盖 ')));
  // Real TCP transport with a constructed banner: verifies the packaged IPC and
  // saved-address discovery path, not a physical grandMA2 or its login protocol.
  let receivedBytes = 0;
  const server = createServer(socket => {
    socket.write('[Channel]>');
    const timer = setTimeout(() => socket.end("\r\nLogged in as User 'guest'\r\n[Channel]>"), 120);
    socket.on('data', data => { receivedBytes += data.length; });
    socket.on('error', error => { console.error('测试探测连接失败', error.message); });
    socket.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let savedAddress;
  try {
    const port = server.address().port;
    savedAddress = await page.evaluate(async port => {
      const api = globalThis.window.tbLink;
      await api.saveMa2Network({ settings: { host: '127.0.0.1', port, monitorPort: 30001, username: 'test', autoConnect: false } });
      return api.discoverMa2();
    }, port);
    assert(savedAddress.hosts.some(host => host.host === '127.0.0.1' && host.port === port && host.identity === 'ma2'));
    assert.equal(receivedBytes, 0, '自动搜索不得向候选目标发送登录或控台命令');
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const logs = await page.evaluate(() => globalThis.window.tbLink.queryLogs());
  assert(logs.some(entry => entry.message.startsWith('自动发现完成：')));
  await writeFile(join(directory, 'logs.json'), JSON.stringify(logs, null, 2));
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ executable, ...result, constructedBannerProbe: { savedAddress, receivedBytes }, realConsoleAcceptance: false }, null, 2));
  console.log(`安装版真实网卡搜索与取消通过：取消 ${Math.round(result.cancellationMs)}ms，完整搜索 ${Math.round(result.fullSearchMs)}ms。未替代实体控台验收。`);
} finally { await application.close(); }
