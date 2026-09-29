import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = new URL('../apps/licensing-server/dist/web/', import.meta.url);
const shots = new URL('../apps/licensing-server/.impeccable/review/', import.meta.url);
await mkdir(shots, { recursive: true });
const fixture = JSON.parse(await readFile(new URL('../apps/licensing-server/deploy/catalog.json', import.meta.url), 'utf8'));
let catalogMode = 'open';
let writes = 0;
const server = createServer(async (req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(500).end(); return; }
  if (req.url === '/v1/catalog') {
    if (catalogMode === 'error') { res.writeHead(503).end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ available: catalogMode === 'open', currency: 'CNY', termStart: 'fulfillment', offers: catalogMode === 'open' ? fixture.offers : [] })); return;
  }
  const files = { '/': ['index.html', 'text/html'], '/purchase.js': ['purchase.js', 'text/javascript'], '/purchase.css': ['purchase.css', 'text/css'], '/assets/studio.webp': ['assets/studio.webp', 'image/webp'] };
  files['/assets/display.woff2']=['assets/display.woff2','font/woff2'];
  const file = files[req.url];
  if (!file) { res.writeHead(404).end(); return; }
  try { res.setHeader('content-type', file[1]); res.end(await readFile(new URL(file[0], root))); }
  catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height, colorScheme] of [['desktop',1440,960,'light'],['mobile',390,844,'light'],['desktop-dark',1440,960,'dark'],['mobile-dark',390,844,'dark']]) {
    const page = await browser.newPage({ viewport: {width,height}, colorScheme, reducedMotion: 'reduce' });
    const errors=[]; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${address.port}`, {waitUntil:'networkidle'});
    const plans=page.locator('button.plan'); await plans.first().waitFor();
    assert.equal(await plans.count(),2);
    assert.equal(await page.locator('#total').textContent(),'¥800.00');
    await plans.nth(1).click();
    assert.equal(await page.locator('#total').textContent(),'¥8000.00');
    assert.equal(await plans.nth(1).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('body').innerText().then(t=>t.includes('成都相变风景科技有限公司')),false);
    assert.equal(await page.locator('img').evaluate(img=>img.complete && img.naturalWidth>0),true);
    assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);
    await page.evaluate(()=>globalThis.scrollTo(0,0));
    await page.screenshot({path:new URL(`${name}.png`,shots).pathname,fullPage:true});
    if (name==='desktop') {
      await page.locator('#customer').fill('自动化验收（本地模拟）');
      await page.locator('#consent').check();
      await page.locator('#purchase-form button[type=submit]').click();
      await page.locator('#order').waitFor({state:'visible'});
      assert.equal(await plans.first().isDisabled(),true);
      const saved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tblink.purchase.receipt')));
      assert.equal(saved.request.offerId,'single-device-annual');
      assert.equal(saved.request.quotedUnitAmountFen,800000);
      await page.reload(); await page.locator('#order').waitFor({state:'visible'});
      assert.equal(await page.locator('#submit-order').isDisabled(),true);
      assert.equal(await plans.nth(1).getAttribute('aria-pressed'),'true');
    }
    assert.deepEqual(errors,[]); await page.close();
    console.log(`${name}: plans, selection, layout and image passed`);
  }
  const page=await browser.newPage();
  for (const mode of ['closed','error']) {
    catalogMode=mode;
    await page.goto(`http://127.0.0.1:${address.port}`,{waitUntil:'networkidle'});
    assert.equal(await page.locator('#purchase-form').isHidden(),true);
    assert.equal(await page.locator('button.plan').count(),0);
    if(mode==='error') assert.equal(await page.locator('#error').isVisible(),true);
    console.log(`${mode}: no checkout passed`);
  }
  catalogMode='open'; await page.locator('#reload').click(); await page.locator('button.plan').first().waitFor();
  assert.equal(await page.locator('#purchase-form').isVisible(),true);
  await page.locator('summary').filter({hasText:'恢复已有订单'}).click();
  const annual=fixture.offers[1];
  const receipt={version:1,product:'tuanbo-link-console',createdAt:new Date().toISOString(),token:'TBD-'+'A'.repeat(64),request:{offerId:annual.id,revision:annual.revision,quotedUnitAmountFen:annual.unitAmountFen,quantity:1,customer:'本地恢复验收',customerType:'personal'},orderId:null,discardable:false};
  await page.locator('#import').setInputFiles({name:'receipt.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(receipt))});
  await page.locator('#order').waitFor({state:'visible'});
  assert.equal(await page.locator('button.plan').nth(1).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#pay').isHidden(),true);
  assert.equal(await page.locator('#pay').getAttribute('href'),null);
  assert.equal(writes,0); console.log('recovery passed; no order/payment requests sent');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
