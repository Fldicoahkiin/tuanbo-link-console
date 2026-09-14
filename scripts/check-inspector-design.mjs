import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const output = 'acceptance-20260914-inspector-design';
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const results = [];
if (!await page.locator('.cue-inspector').count()) await page.getByRole('button', { name: '编辑器', exact: true }).click();
const original = await page.evaluate(() => ({
  row: globalThis.document.querySelector('.editor-preview-row').getAttribute('style'),
  bench: globalThis.document.querySelector('.timeline-workbench').getAttribute('style'),
  theme: globalThis.document.documentElement.dataset.theme
}));
const common = async () => {
  const button = page.getByRole('button', { name: '常用设置', exact: true });
  if (await button.count()) await button.click();
  await expect(page.locator('.common-properties')).toBeVisible();
};
try {
  for (const width of [810, 560, 300]) {
    await page.evaluate((width) => {
      globalThis.document.querySelector('.editor-preview-row').style.gridTemplateColumns = `minmax(240px, 1fr) 6px ${width}px`;
      globalThis.document.querySelector('.timeline-workbench').style.gridTemplateRows = '420px 6px minmax(200px, 1fr)';
    }, width);
    for (const [name, selector] of [['common', null], ['cue', '.timeline-cue'], ['media', '.timeline-clip'], ['lighting', '.lighting-track-name'], ['lighting-event', '.lighting-timeline-point']]) {
      if (selector) await page.locator(selector).first().click();
      else await common();
      const panel = page.locator('.cue-inspector');
      const overflow = await panel.evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        return [...root.querySelectorAll('input, select, button, textarea')].filter((element) => element.checkVisibility()).filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < bounds.left - 1 || box.right > bounds.right + 1;
        }).map((element) => element.getAttribute('aria-label') || element.outerHTML.slice(0, 100));
      });
      results.push({ width, name, overflow });
      if (name === 'common' && width === 810) {
        const alignment = await panel.evaluate((root) => {
          const top = (selector) => root.querySelector(selector).getBoundingClientRect().top;
          return {
            headings: top('.arrangement-property-group h3') - top('.song-properties h3'),
            firstRow: top('.tempo-primary-fields') - top('.song-properties > label'),
            secondRow: top('.loop-properties') - top('.song-properties > label:nth-of-type(3)'),
            disclosure: top('.tempo-points summary') - top('.song-advanced summary')
          };
        });
        results.push({ width, name: 'alignment', overflow: [], alignment });
        expect(Object.values(alignment).every((distance) => Math.abs(distance) <= 1)).toBe(true);
      }
      await panel.screenshot({ path: `${output}/${name}-${width}.png` });
    }
  }
  await common();
  await page.locator('.tempo-points summary').click();
  await expect(page.getByRole('button', { name: '添加变速点', exact: true })).toBeVisible();
  await page.locator('.song-advanced summary').click();
  await expect(page.getByRole('textbox', { name: 'MTC 偏移（时:分:秒:帧）', exact: true })).toBeVisible();
  await page.locator('.cue-inspector').screenshot({ path: `${output}/advanced-300.png` });
  await page.locator('.tempo-points summary').click();
  await page.locator('.song-advanced summary').click();
  await page.evaluate(() => {
    globalThis.document.documentElement.dataset.theme = 'light';
    globalThis.document.querySelector('.editor-preview-row').style.gridTemplateColumns = 'minmax(240px, 1fr) 6px 810px';
  });
  await page.locator('.cue-inspector').screenshot({ path: `${output}/common-light.png` });
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  expect(results.every((result) => result.overflow.length === 0)).toBe(true);
} finally {
  await page.evaluate((original) => {
    for (const [selector, style] of [['.editor-preview-row', original.row], ['.timeline-workbench', original.bench]]) {
      if (style === null) globalThis.document.querySelector(selector).removeAttribute('style');
      else globalThis.document.querySelector(selector).setAttribute('style', style);
    }
    if (original.theme) globalThis.document.documentElement.dataset.theme = original.theme;
    else delete globalThis.document.documentElement.dataset.theme;
  }, original);
  await browser.close();
}
