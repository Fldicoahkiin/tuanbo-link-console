import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

test('全工作区外观、最小窗口和键盘入口', async ({}, info) => {
  const project = parseLinkProject({ ...createEmptyLinkProject('秋日舞台 · 联动排练'), playbackSource: 'internal',
    rundown: ['开场 · 灯光渐入', '第一幕 · 追光', '双人舞 · 城市夜色', '返场 · 一起出发'].map((title, index) => ({ id: `program-${index}`, title, cues: [] })) });
  const file = info.outputPath('interface.tblink');
  await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
    await page.screenshot({ path: info.outputPath('welcome.png') });
    const create = page.getByRole('button', { name: '新建工程', exact: true });
    await create.click();
    const dialog = page.getByRole('dialog', { name: '新建联动工程', exact: true });
    await expect(page.getByLabel('工程名称', { exact: true })).toBeFocused();
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('project-dialog.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('.p1-media-card')).toHaveCount(4);
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await nav.getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByRole('button', { name: '新建播放列表', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '新建播放列表', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '新建播放列表', exact: true })).toBeFocused();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { localStorage.setItem('tblink.appearance.v1', value); window.dispatchEvent(new Event('tblink-appearance-change')); }, theme);
      const contrasts = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (token: string): number[] => {
          probe.style.color = `var(${token})`;
          const values = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number);
          if (!values || values.length < 3) throw new Error(`颜色无法解析：${token}`);
          return values;
        };
        const luminance = (channels: number[]): number => channels.slice(0, 3).reduce((sum, channel, index) => {
          const value = channel / 255;
          return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!;
        }, 0);
        const pairs = ['--surface', '--surface-raised', '--surface-hover', '--page-background', '--sidebar-background'].flatMap(background =>
          ['--text-primary', '--text-secondary', '--text-tertiary'].map(foreground => {
            const bg = resolve(background); const fg = resolve(foreground); const alpha = fg[3] ?? 1;
            const a = luminance(bg); const b = luminance(fg.slice(0, 3).map((value, index) => value * alpha + bg[index]! * (1 - alpha)));
            return { foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
          }));
        const action = luminance(resolve('--accent-fill')); const label = luminance(resolve('--on-accent'));
        pairs.push({ foreground: '--on-accent', background: '--accent-fill', ratio: (Math.max(action, label) + .05) / (Math.min(action, label) + .05) });
        probe.remove();
        return pairs;
      });
      await writeFile(info.outputPath(`${theme}-contrast.json`), JSON.stringify(contrasts, null, 2));
      for (const pair of contrasts) expect(pair.ratio, `${theme} ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(4.5);
      for (const [width, height] of [[1920, 1080], [1540, 960], [1180, 720]]) {
        await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(size[0]!, size[1]!); }, [width!, height!]);
        for (const name of ['节目单', '编辑器', '灯光工作台', '设置']) {
          await nav.getByRole('button', { name, exact: true }).click();
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const workspace = await page.locator('.app-workspace').boundingBox();
          expect(workspace!.height).toBeGreaterThan(500);
          expect(workspace!.y + workspace!.height).toBeLessThanOrEqual(height! + 1);
          if (name === '节目单') {
            const library = await page.locator('.p1-library-workbench').boundingBox();
            expect(library!.height).toBeGreaterThan(200);
            expect(library!.y + library!.height).toBeLessThanOrEqual(height!);
          }
          await page.screenshot({ path: info.outputPath(`${theme}-${width}-${name}.png`) });
          expect(await page.locator('.app-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
      }
    }
    await nav.getByRole('button', { name: '节目单', exact: true }).click();
    await expect(page.locator('.p1-item-inspector')).toBeVisible();
    await expect(page.locator('.p1-media-grid')).toHaveAttribute('data-view', 'cards');
    await page.getByRole('button', { name: '卡片视图', exact: true }).click();
    await expect(page.locator('.p1-media-grid')).toHaveAttribute('data-view', 'cards');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    await page.getByRole('button', { name: '编辑节目属性：开场 · 灯光渐入', exact: true }).click();
    await expect(page.getByLabel('节目名称', { exact: true })).toHaveValue('开场 · 灯光渐入');
    await page.getByRole('button', { name: '收起节目属性', exact: true }).click();
    await page.getByLabel('搜索节目', { exact: true }).fill('不存在的节目');
    await expect(page.getByText('没有找到匹配的节目', { exact: true })).toBeVisible();
    await page.getByLabel('搜索节目', { exact: true }).fill('');
    await nav.getByRole('button', { name: '编辑器', exact: true }).click();
    const inspector = page.locator('.cue-inspector');
    const inspectorBefore = (await inspector.boundingBox())!.width;
    const resizeInspector = page.getByRole('button', { name: '调整属性面板宽度', exact: true });
    await resizeInspector.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(inspectorBefore);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await inspector.boundingBox())!.width).toBe(inspectorBefore);
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    const groups = page.getByRole('navigation', { name: '设置子菜单' });
    for (const group of ['设备连接', '播放', '画面与同步', '外观与更新']) {
      await groups.getByRole('button', { name: group, exact: true }).click();
      const sections = page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button');
      for (let index = 0; index < await sections.count(); index++) {
        await sections.nth(index).click();
        await expect(page.locator('.device-console:visible')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`settings-${group}-${index}.png`) });
      }
    }
    await groups.getByRole('button', { name: '播放', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: '播放习惯', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(590);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const zoomImage = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(info.outputPath('settings-200-percent.png'), Buffer.from(zoomImage, 'base64'));
    expect(await page.locator('.device-console:visible').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Tab');
    await nav.getByRole('button', { name: '节目单', exact: true }).focus();
    expect(await nav.getByRole('button', { name: '节目单', exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    expect(await nav.getByRole('button', { name: '节目单', exact: true }).evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    expect(errors).toEqual([]);
  } catch (error) {
    const page = await app.firstWindow();
    await writeFile(info.outputPath('failure-ui.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: info.outputPath('failure-ui.png') });
    throw error;
  } finally { const page = await app.firstWindow(); if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close(); }
});
