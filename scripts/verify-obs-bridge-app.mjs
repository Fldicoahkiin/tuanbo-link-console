import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(resolve('apps/desktop/package.json'));
const { _electron: electron } = require('@playwright/test');
const executable = process.argv[2], obsDirectory = process.argv[3];
if (!executable || !obsDirectory) throw new Error('Usage: node scripts/verify-obs-bridge-app.mjs <packaged exe> <isolated OBS directory>');
const directory = await mkdtemp(join(tmpdir(), 'tblink-bridge-app-'));
await cp(dirname(resolve(executable)), join(directory, 'app'), { recursive: true });
const password = randomUUID();
const port = 29000 + Math.floor(Math.random() * 10000);
await writeFile(join(obsDirectory, 'config/obs-studio/plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: port }));
const env = { ...process.env, ProgramData: join(directory, 'program-data') };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ executablePath: join(directory, 'app', basename(executable)), args: [`--user-data-dir=${join(directory, 'user-data')}`], env });
const page = await application.firstWindow();
await page.waitForLoadState('domcontentloaded');
const profile = {
  schemaVersion: 1, profileId: 'bridge-test', name: 'Bridge deployment acceptance', updatedAt: new Date().toISOString(),
  obs: { executablePath: join(obsDirectory, 'bin/64bit/obs64.exe'), workingDirectory: join(obsDirectory, 'bin/64bit'), arguments: ['--portable', '--multi', '--disable-updater', '--disable-missing-files-check'], startupTimeoutMs: 20000, shutdownTimeoutMs: 15000, webSocketUrl: `ws://127.0.0.1:${port}`, credentialId: 'obs-test' },
  p1: { executablePath: 'C:\\P1\\P1.exe', workingDirectory: 'C:\\P1', arguments: [], startupTimeoutMs: 20000, shutdownTimeoutMs: 10000, mtcInputPortProfileId: 'p1-mtc', controlOutputPortProfileId: 'p1-output', expectedFrameRate: '30', obsAudioInputName: '' },
  midiPortProfiles: [{ id: 'p1-mtc', direction: 'input', portName: '' }, { id: 'p1-output', direction: 'output', portName: '' }, { id: 'lighting-output', direction: 'output', portName: '' }], acceptedVersions: { obs: '32.2.2', p1: 'not used' }
};
let obsOwned = false;
try {
  await page.evaluate(({ profile, password }) => globalThis.tbLink.saveIntegrationProfile({ profile, obsPassword: password }), { profile, password });
  await page.evaluate(() => globalThis.tbLink.repairObsBridge());
  obsOwned = true;
  const initial = await page.evaluate(() => globalThis.tbLink.refreshExternalApplication('obs'));
  if (!initial.owned || !initial.pid) throw new Error('New OBS ownership not recorded');
  const dimensions = await page.evaluate(async () => {
    const f = await globalThis.tbLink.getObsLiveFrame();
    await globalThis.tbLink.closeObsLivePreview();
    return { width: f.width, height: f.height, bytes: f.rgba.byteLength };
  });
  await page.evaluate(() => globalThis.tbLink.repairObsBridge());
  const unchanged = await page.evaluate(() => globalThis.tbLink.refreshExternalApplication('obs'));
  if (unchanged.pid !== initial.pid) throw new Error('Healthy OBS was needlessly restarted');
  // Alter only the unused DOS stub in the isolated app copy. Windows PE executable
  // code is unchanged, but the installer must treat the package as an update.
  const bundledPath = join(directory, 'app/resources/obs/tblink-realtime-preview.dll');
  const updated = await readFile(bundledPath);
  if (updated.readUInt32LE(60) <= 64) throw new Error('No DOS stub available for update fixture');
  updated[64] ^= 1;
  await writeFile(bundledPath, updated);
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = (_window, options) => {
      if (options.title !== '维护 OBS 内置组件' || options.message !== '需要正常重启 OBS 以加载组件') throw new Error('Unexpected dialog in isolated acceptance');
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  });
  await page.evaluate(() => globalThis.tbLink.repairObsBridge());
  const repaired = await page.evaluate(() => globalThis.tbLink.refreshExternalApplication('obs'));
  if (!repaired.owned || repaired.pid === initial.pid) throw new Error('Repair did not restart owned OBS');
  await page.reload();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('button', { name: '检查并修复组件', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '检查并修复组件', exact: true }).click();
  await page.getByText('组件已就绪，真实画面检查通过。', { exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'settings.png') });
  const result = { passed: true, directory, initialPid: initial.pid, repairedPid: repaired.pid, dimensions, checks: ['packaged preload', 'fresh component deployment', 'owned OBS startup readiness', 'authenticated WebSocket connection', 'real frame', 'healthy repair preserves PID', 'loaded DLL update', 'confirmed normal restart and recovery', 'settings repair entry'] };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Packaged app verification failed:', error);
  throw error;
} finally {
  await page.evaluate(() => globalThis.tbLink.closeObsLivePreview());
  if (obsOwned) {
    const current = await page.evaluate(() => globalThis.tbLink.refreshExternalApplication('obs'));
    if (current.owned && current.pid) await page.evaluate(async () => { await globalThis.tbLink.connectObs(); await globalThis.tbLink.stopExternalApplication('obs'); });
  }
  await application.close();
}
