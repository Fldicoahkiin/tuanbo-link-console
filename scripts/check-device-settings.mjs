import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../acceptance-20260914-device-settings/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const original = await page.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight, theme: globalThis.document.documentElement.dataset.theme }));
const results = [];
const sections = [
  ['设备连接', ['OBS Studio', 'MA2 控台', '音频与 MIDI', '虚拟 MIDI', '高级与诊断']],
  ['播放', ['播放主控', '播放习惯']],
  ['画面与同步', ['监看与性能', '视频定位', '时间码同步', '场景工作方式']],
  ['外观与更新', ['界面外观', '软件更新']]
].flatMap(([group, names]) => names.map((name) => ({ group, name })));
const groups = page.getByRole('navigation', { name: '设置子菜单', exact: true });
try {
  if (!await page.locator('.device-console').isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子菜单', exact: true }).getByRole('button', { name: '设备连接', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => { globalThis.document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1540, 1180]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [index, { group, name }] of sections.entries()) {
        await groups.getByRole('button', { name: group, exact: true }).click();
        await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: new RegExp(name) }).click();
        await expect(page.locator('.device-detail-header h3')).toHaveText(name);
        const audit = await page.locator('.device-console').evaluate((root) => {
          const visible = [...root.querySelectorAll('input,select,button,label,p,h2,h3,summary')].filter((element) => element.checkVisibility());
          return {
            overflow: visible.filter((element) => element.getBoundingClientRect().right > globalThis.innerWidth + 1).map((element) => element.getAttribute('aria-label') || element.textContent?.slice(0, 60)),
            smallText: visible.filter((element) => !element.matches('input[type=checkbox]') && parseFloat(globalThis.getComputedStyle(element).fontSize) < 14).map((element) => element.outerHTML.slice(0, 140)),
            inputs: visible.filter((element) => element.matches('input:not([type=checkbox]),select')).map((element) => ({ name: element.getAttribute('aria-label'), height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width }))
          };
        });
        expect(audit.overflow).toEqual([]);
        expect(audit.smallText).toEqual([]);
        expect(audit.inputs.every((input) => input.height >= 40)).toBe(true);
        results.push({ theme, width, device: name, ...audit });
        await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${width}-${index}.png`, output)), fullPage: true });
      }
    }
  }
  await groups.getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: /MA2 控台/ }).click();
  const address = page.getByRole('textbox', { name: 'MA2 控台 IP', exact: true });
  const oldValue = await address.inputValue();
  await address.fill('192.168.20.10');
  await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: /OBS Studio/ }).click();
  await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: /MA2 控台/ }).click();
  await expect(address).toHaveValue('192.168.20.10');
  await address.fill(oldValue);
  results.push({ check: '切换设备保留未保存参数', passed: true });
  await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2));
  console.log(`通过 ${results.length} 项检查，截图位于 acceptance-20260914-device-settings`);
} finally {
  await page.evaluate((value) => { if (value) globalThis.document.documentElement.dataset.theme = value; else delete globalThis.document.documentElement.dataset.theme; }, original.theme);
  await page.setViewportSize({ width: original.width, height: original.height });
  await groups.getByRole('button', { name: '设备连接', exact: true }).click();
  await page.getByRole('navigation', { name: '设置子子菜单' }).getByRole('button', { name: /OBS Studio/ }).click();
  await browser.close();
}
