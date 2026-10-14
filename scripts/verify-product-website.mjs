import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
const req = createRequire(resolve('apps/desktop/package.json'));
const { chromium } = req('@playwright/test');
let preview;
if (!process.env.TBLINK_WEBSITE_ORIGIN) {
  process.env.TBLINK_WEBSITE_PORT = '0';
  preview = (await import('./serve-product-website.mjs')).server;
  if (!preview.listening) await once(preview, 'listening');
}
const origin = process.env.TBLINK_WEBSITE_ORIGIN ?? `http://127.0.0.1:${preview.address().port}`;
const output = resolve('artifacts/website-review'); await mkdir(output, { recursive: true });
const catalog = JSON.parse(await readFile('apps/licensing-server/deploy/catalog.json', 'utf8'));
const browser = await chromium.launch({ headless: true }); const results = [];
try {
  for (const width of [360, 390, 768, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    const errors = [], mediaRequests = []; page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.url().endsWith('.mp4')) mediaRequests.push(r.url()); });
    await page.route('**/v1/catalog', route => route.fulfill({ json: { available: true, currency: 'CNY', termStart: 'fulfillment', offers: catalog.offers } }));
    for (const path of ['/', '/download/', '/guide/', '/purchase/', '/terms/', '/refund/', '/privacy/']) {
      let initialBytes;
      await page.goto(origin + path, { waitUntil: 'networkidle' });
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, `${width}: ${path} overflow`);
      assert.equal(await page.locator('h1').count(), 1);
      const images = await page.locator('img').all();
      for (const image of images) {
        if (await image.isVisible()) { await image.scrollIntoViewIfNeeded(); await image.evaluate(img => img.decode()); assert.ok(await image.evaluate(img => img.naturalWidth > 0)); }
      }
      await page.evaluate(() => globalThis.scrollTo(0, 0));
      if (width === 390 || width === 1440) await page.screenshot({ path: join(output, `${width}-${path === '/' ? 'home' : path.split('/')[1]}.png`), fullPage: true });
      if (path === '/') {
        assert.equal(mediaRequests.length, 0, 'Video must not download before user action');
        await page.locator('[data-image]').first().click(); await page.locator('#image-viewer[open]').waitFor(); await page.keyboard.press('Escape');
        assert.equal(await page.locator('#image-viewer').isVisible(), false);
        assert.equal(await page.locator('[data-image]').first().evaluate(el => el === globalThis.document.activeElement), true, 'Dialog must restore keyboard focus');
        initialBytes = await page.evaluate(() => performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.encodedBodySize, 0));
        assert.ok(initialBytes < 1.5 * 1024 * 1024, `Page assets exceed budget: ${initialBytes}`);
      }
      results.push({ width, path, overflow: false, images: 'decoded', initialBytes, errors: [...errors] }); assert.deepEqual(errors, []);
    }
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.route('**/v1/catalog', route => route.fulfill({ json: { available: true, currency: 'CNY', termStart: 'fulfillment', offers: catalog.offers } }));
  await page.goto(origin); await page.locator('[data-time="40"]').click();
  await page.waitForFunction(() => { const v = globalThis.document.querySelector('video'); return v.currentTime >= 40 && !v.paused; }, undefined, { timeout: 20000 });
  await page.locator('video').evaluate(v => v.pause());
  await page.locator('video').evaluate(v => v.requestFullscreen());
  assert.equal(await page.evaluate(() => globalThis.document.fullscreenElement?.tagName), 'VIDEO');
  await page.evaluate(() => globalThis.document.exitFullscreen());
  assert.ok(await page.locator('track').count());
  await page.locator('[data-clip="lighting"]').click(); await page.waitForFunction(() => globalThis.document.querySelector('video').currentSrc.includes('lighting'));
  await page.locator('video').evaluate(v => v.pause());
  await page.locator('[data-time="60"]').click();
  await page.waitForFunction(() => { const v = globalThis.document.querySelector('video'); return v.currentTime >= 60 && v.textTracks[0].mode === 'showing'; });
  await page.locator('video').evaluate(v => v.pause());
  await page.goto(origin + '/#purchase'); assert.equal(await page.locator('#purchase').count(), 1);
  const range = await fetch(origin + '/media/20261010-overview.mp4', { headers: { Range: 'bytes=0-1023' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 1024);
  const invalid = await fetch(origin + '/media/20261010-overview.mp4', { headers: { Range: 'bytes=999999999-' } }); assert.equal(invalid.status, 416);
  await page.goto(origin); await page.evaluate(() => { globalThis.document.documentElement.style.zoom = '2'; });
  assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)); await page.screenshot({ path: join(output, 'zoom-200.png') });
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, video: 'played and seeked', range: '206 and 416 verified', zoom200: 'no overflow', checkedAt: new Date().toISOString() }, null, 2));
  console.log('官网 20 个页面/宽度组合、图片、视频跳转、Range、200% 缩放验证通过。');
} finally { await browser.close(); if (preview) { preview.closeAllConnections(); await new Promise((resolve, reject) => preview.close(error => error ? reject(error) : resolve())); } }
