import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, type Ma2LiveInput, type Ma2LiveRequest, type Ma2LiveSnapshot } from '@tb/schema';

for (const failure of ['read', 'input'] as const) test(`推杆位置与双向回读、失焦释放，${failure} 失败停止后续读取`, async ({}, info) => {
  test.setTimeout(90000);
  const source = { show: '推杆界面验收', generation: 'test', version: '3.7.0.5' };
  const sequences = [{ sequence: 9900, name: '面光', cues: [{ index: 1, number: '1.000', name: '面光' }] }];
  const project = createEmptyLinkProject('推杆验收'); project.schemaVersion = 2;
  project.rundown = [{ id: 'song', title: '推杆验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() }];
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { ...source, entries: [{ target: 9900, name: '面光' }] }, sequences, errors: [], fixtureUsage: [], readAt: new Date().toISOString() } };
  const file = info.outputPath('faders.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')], env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
  const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ ipcMain, dialog, BrowserWindow }, { file, source, sequences }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000);
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
      process.env.TBLINK_FADER_LEVEL = '0.5'; process.env.TBLINK_FADER_INPUTS = '[]'; process.env.TBLINK_FADER_RELEASES = '0'; process.env.TBLINK_FADER_READS = '0';
      const replace = (name: string, handler: Parameters<typeof ipcMain.handle>[1]): void => { ipcMain.removeHandler(name); ipcMain.handle(name, handler); };
      replace('link:ma2-network-status', () => ({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, version: '3.7.0.5', passwordSaved: false, error: null }));
      replace('link:ma2-executor-pages', () => ({ ...source, buttonPage: 4, faderPage: 100, pages: [{ page: 100, name: '常用推杆' }] }));
      replace('link:ma2-executor-page', (_event, request: { page: number }) => ({ page: request.page, name: '常用推杆', source, sequences, readAt: new Date().toISOString(), items: [{ slot: 1, width: 1, name: '面光_Long_Sequence_Name_For_Fader', sequence: 9900, kind: 'sequence', button: 1, reference: ['25', '1', '9900'] }] }));
      replace('link:ma2-live-read', (_event, request: Ma2LiveRequest): Ma2LiveSnapshot => {
        process.env.TBLINK_FADER_READS = String(Number(process.env.TBLINK_FADER_READS) + 1);
        if (process.env.TBLINK_FADER_FAIL) throw new Error('测试断线');
        const value = Number(process.env.TBLINK_FADER_LEVEL);
        return { page: request.page, start: request.start, readAt: Date.now(), items: Array.from({ length: 15 }, (_, index) => ({ slot: request.start + index, width: 1, name: index === 0 ? '面光' : '', objectType: index === 0 ? 'LT' : '', objectNumber: index === 0 ? '9900' : '', running: false, cue: index === 0 ? '1 面光' : '', blocks: [{ slot: request.start + index, fader: index === 0 ? { value, min: 0, max: 1, name: 'LTP', text: `${Math.round(value * 100)}%` } : null, buttons: [0, 1, 2].map(id => ({ id, name: index === 0 ? ['Go', 'Flash', 'Off'][id]! : 'Empty', active: false })) }] })) };
      });
      replace('link:ma2-live-input', (_event, request: Ma2LiveInput) => {
        if (process.env.TBLINK_FADER_INPUT_FAIL) throw new Error('测试发送失败');
        const inputs = JSON.parse(process.env.TBLINK_FADER_INPUTS ?? '[]') as unknown[]; inputs.push(request); process.env.TBLINK_FADER_INPUTS = JSON.stringify(inputs);
        const action = request.action;
        if (action.kind === 'fader') setTimeout(() => { process.env.TBLINK_FADER_LEVEL = String(action.value); }, 180);
      });
      replace('link:ma2-live-release', () => { process.env.TBLINK_FADER_RELEASES = String(Number(process.env.TBLINK_FADER_RELEASES) + 1); });
    }, { file, source, sequences });
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('button', { name: '灯光工作台', exact: true }).click();
    const pool = page.getByRole('region', { name: 'MA2 序列预览' });
    await pool.getByRole('button', { name: '控台页面', exact: true }).click();
    await pool.getByLabel('控台页面类型').selectOption('fader');
    const slider = page.getByRole('slider', { name: '推杆 100.1', exact: true });
    await expect(slider).toHaveValue('0.5');
    await expect(page.locator('.ma2-fader-strip')).toHaveCount(15);
    await slider.focus(); await slider.press('End');
    await expect(slider).toHaveValue('1');
    await expect(page.getByText('等待控台回读', { exact: true })).toBeVisible();
    await expect(page.locator('.ma2-fader-block output').first()).toHaveText('100%');
    await app.evaluate(() => { process.env.TBLINK_FADER_LEVEL = '0.63'; });
    await expect(slider).toHaveValue('0.63');
    await expect(page.locator('.ma2-fader-block output').first()).toHaveText('63%');
    await page.screenshot({ path: info.outputPath('fader-page-preview.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1180, 720));
    const layout = await page.locator('.ma2-fader-strip').first().evaluate(element => ({ heading: element.querySelector('.ma2-fader-heading')!.getBoundingClientRect().bottom, current: element.querySelector('.ma2-fader-current')!.getBoundingClientRect().top, controls: element.querySelector('.ma2-fader-blocks')!.getBoundingClientRect().bottom, viewport: element.closest('.ma2-fader-bank')!.getBoundingClientRect().bottom }));
    expect(layout.heading).toBeLessThanOrEqual(layout.current);
    expect(layout.controls).toBeLessThanOrEqual(layout.viewport + 1);
    const nameBounds = await page.locator('.ma2-fader-strip').first().evaluate(element => ({ strip: element.getBoundingClientRect().right, title: element.querySelector('.ma2-fader-heading button')!.getBoundingClientRect().right }));
    expect(nameBounds.title).toBeLessThanOrEqual(nameBounds.strip);
    await page.screenshot({ path: info.outputPath('fader-page-compact.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000));
    await page.getByRole('button', { name: '执行器 1 Flash', exact: true }).focus(); await page.keyboard.down('Space');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(() => app.evaluate(() => Number(process.env.TBLINK_FADER_RELEASES))).toBeGreaterThan(0);
    await page.keyboard.up('Space');
    await pool.getByLabel('推杆范围').selectOption('16');
    await expect(page.getByRole('slider', { name: '推杆 100.16', exact: true })).toHaveValue('0.63');
    const calls = JSON.parse(await app.evaluate(() => process.env.TBLINK_FADER_INPUTS ?? '[]')) as Ma2LiveInput[];
    expect(calls.filter(call => call.action.kind === 'fader')).toHaveLength(1);
    expect(calls[0]).toMatchObject({ page: 100, slot: 1, action: { kind: 'fader', value: 1 } });
    if (failure === 'read') await app.evaluate(() => { process.env.TBLINK_FADER_FAIL = '1'; });
    else {
      await app.evaluate(() => { process.env.TBLINK_FADER_INPUT_FAIL = '1'; });
      await page.getByRole('slider', { name: '推杆 100.16', exact: true }).press('End');
    }
    await expect(page.getByRole('alert').filter({ hasText: failure === 'read' ? '测试断线' : '测试发送失败' })).toBeVisible();
    await expect(page.getByRole('slider', { name: '推杆 100.16', exact: true })).toBeDisabled();
    const stoppedReads = await app.evaluate(() => Number(process.env.TBLINK_FADER_READS));
    await page.waitForTimeout(350);
    expect(await app.evaluate(() => Number(process.env.TBLINK_FADER_READS))).toBe(stoppedReads);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close(); }
});
