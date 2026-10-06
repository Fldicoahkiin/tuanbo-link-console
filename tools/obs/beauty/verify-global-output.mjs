import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function verifyGlobalOutput({ root, directory, fixture, executable, port, password, call, screenshot, difference }) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const { _electron: electron, expect } = require('@playwright/test');
  const sceneA = 'Global beauty A', sceneB = 'Global beauty B', filterName = '团播·人像美颜';
  await call('CreateScene', { sceneName: sceneA });
  await call('CreateScene', { sceneName: sceneB });
  const created = await call('CreateInput', { sceneName: sceneA, inputName: 'Global beauty photo', inputKind: 'image_source', inputSettings: { file: fixture }, sceneItemEnabled: true });
  await call('CreateSceneItem', { sceneName: sceneB, sourceName: 'Global beauty photo', sceneItemEnabled: true });
  await call('SetCurrentProgramScene', { sceneName: sceneA });
  const baseline = await screenshot('global-original', sceneA);
  const app = await electron.launch({ cwd: join(root, 'apps/desktop'), env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1', ProgramData: join(directory, 'desktop-system-data') },
    args: [`--user-data-dir=${join(directory, 'global-desktop-profile')}`, join(root, 'apps/desktop/out/main/index.cjs')] });
  const report = { passed: false, errors: [], scope: 'Real UI auto-start, scene following, immediate parameter delivery and OBS scene pixels; no IPC mocks.' };
  let page;
  try {
    page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(String(error)));
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    const external = { executablePath: executable, workingDirectory: dirname(executable), arguments: [], startupTimeoutMs: 10000, shutdownTimeoutMs: 5000 };
    const profile = { schemaVersion: 1, profileId: 'beauty-global-test', name: '全画面美颜验收', updatedAt: new Date().toISOString(),
      obs: { ...external, autoConnectOnLaunch: false, webSocketUrl: `ws://127.0.0.1:${port}`, credentialId: 'isolated-obs' },
      p1: { ...external, mtcInputPortProfileId: 'in', controlOutputPortProfileId: 'out', expectedFrameRate: '25' },
      midiPortProfiles: [{ id: 'in', direction: 'input', portName: '' }, { id: 'out', direction: 'output', portName: '' }], acceptedVersions: { obs: '32.0.4', p1: 'not-used' } };
    await page.evaluate(async payload => { await globalThis.window.tbLink.saveIntegrationProfile(payload); await globalThis.window.tbLink.connectObs(); }, { profile, obsPassword: password });
    await expect.poll(() => page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime()), { timeout: 30000 }).toMatchObject({ phase: 'tracking', sourceName: sceneA });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '人像美颜', exact: true }).click();
    await expect(page.getByLabel('美颜画面来源')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '启动美颜', exact: true })).toHaveCount(0);
    await page.getByRole('slider', { name: '磨皮', exact: true }).fill('65');
    await page.getByRole('slider', { name: '美白', exact: true }).fill('40');
    await expect.poll(async () => (await call('GetSourceFilter', { sourceName: sceneA, filterName })).filterSettings.white).toBe(.4);
    report.pixelDifference = difference(baseline, await screenshot('global-processed', sceneA));
    assert(report.pixelDifference > .01, 'Global filter did not change composed pixels');
    await page.screenshot({ path: join(directory, 'global-ui.png') });
    const statusBox = () => page.getByLabel('美颜生效状态').boundingBox();
    const tabsBox = () => page.getByRole('navigation', { name: '美颜分类' }).boundingBox();
    const trackedLayout = { status: await statusBox(), tabs: await tabsBox() };
    const preview = await page.locator('.beauty-preview-viewer').elementHandle();
    assert(preview, 'Missing live preview');
    await call('SetSceneItemEnabled', { sceneName: sceneA, sceneItemId: created.sceneItemId, sceneItemEnabled: false });
    await expect.poll(() => page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime()), { timeout: 10000 }).toMatchObject({ phase: 'waiting', faces: 0 });
    await expect(page.getByLabel('美颜生效状态')).toContainText('等待');
    const waitingLayout = { status: await statusBox(), tabs: await tabsBox() };
    assert.equal(trackedLayout.status.height, 38);
    assert.equal(waitingLayout.status.height, trackedLayout.status.height);
    assert.equal(waitingLayout.tabs.y, trackedLayout.tabs.y, 'Detection state moved the controls');
    assert(await preview.evaluate(element => element.isConnected), 'Detection state replaced the preview');
    report.statusLayout = { tracked: trackedLayout, waiting: waitingLayout, previewRetained: true };
    await call('SetSceneItemEnabled', { sceneName: sceneA, sceneItemId: created.sceneItemId, sceneItemEnabled: true });
    await expect.poll(() => page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime()), { timeout: 10000 }).toMatchObject({ phase: 'tracking' });
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
    await call('SetCurrentProgramScene', { sceneName: sceneB });
    await expect.poll(() => page.evaluate(() => globalThis.window.tbLink.readBeautyRuntime()), { timeout: 30000 }).toMatchObject({ phase: 'tracking', sourceName: sceneB });
    assert.equal((await call('GetSourceFilter', { sourceName: sceneA, filterName })).filterEnabled, false);
    assert.equal((await call('GetSourceFilter', { sourceName: sceneB, filterName })).filterSettings.white, .4);
    report.switchedDifference = difference(baseline, await screenshot('global-switched', sceneB));
    assert(report.switchedDifference > .01);
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '人像美颜', exact: true }).click();
    await page.getByRole('button', { name: '全部归零', exact: true }).click();
    await expect.poll(async () => (await call('GetSourceFilter', { sourceName: sceneB, filterName })).filterSettings.white).toBe(0);
    report.resetDifference = difference(baseline, await screenshot('global-reset', sceneB));
    assert.equal(report.resetDifference, 0);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    if (page) await page.screenshot({ path: join(directory, 'global-failure.png') });
    throw error;
  } finally {
    try { if (page) await page.evaluate(() => globalThis.window.tbLink.disconnectObs()); }
    finally { await app.close(); await writeFile(join(directory, 'global-output.json'), JSON.stringify(report, null, 2)); }
  }
  return report;
}
