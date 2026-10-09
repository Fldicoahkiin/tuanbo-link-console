import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

if (process.argv.length !== 5) throw new Error('参数：安装后的 EXE、原生绑定测试工程、新证据目录');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const executable = resolve(process.argv[2]), directory = resolve(process.argv[4]);
await mkdir(directory);
const fixture = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
assert.ok(fixture.rundown[0].lighting.ma2Bindings.length);
fixture.rundown[0].lighting.outputMode = 'network';
const path = join(directory, '模式恢复验收.tblink');
await writeFile(path, JSON.stringify(fixture));
const errors = [], results = [];
let app = await launchPackagedDesktop({ executable, directory, chromium });
try {
  let page = await app.firstWindow();
  await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible({ timeout: 20000 });
  assert.equal((await page.evaluate(() => globalThis.window.tbLink.getLicenseStatus())).state, 'active');
  await page.evaluate(file => localStorage.setItem('tblink.last-project-path.v1', file), path);
  await page.reload();
  for (const mode of ['timecode', 'direct', 'network']) {
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('combobox', { name: '灯光输出方式' }).selectOption(mode);
    await expect.poll(async () => JSON.parse(await readFile(path, 'utf8')).rundown[0].lighting.outputMode).toBe(mode);
    await app.close();
    app = await launchPackagedDesktop({ executable, directory, chromium });
    page = await app.firstWindow();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '灯光输出方式' })).toHaveValue(mode);
    await expect(page.locator('.fatal-screen')).toHaveCount(0);
    const lighting = JSON.parse(await readFile(path, 'utf8')).rundown[0].lighting;
    assert.deepEqual(lighting.ma2Bindings, fixture.rundown[0].lighting.ma2Bindings);
    assert.deepEqual(lighting.tracks, fixture.rundown[0].lighting.tracks);
    await page.screenshot({ path: join(directory, `${mode}-reopened.png`) });
    results.push({ mode, saved: true, restarted: true, cuesAndNativeBindingsPreserved: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ executable, checkedAt: new Date().toISOString(), results, errors }, null, 2));
} finally { await app.close(); }
console.log('实际安装版三种灯光输出模式切换、保存、完整重启均通过；原生数据与 Cue 保留。');
