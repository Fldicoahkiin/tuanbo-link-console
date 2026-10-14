import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = new URL('../apps/licensing-server/dist/web/', import.meta.url);
const shots = new URL('../apps/licensing-server/.impeccable/review/', import.meta.url);
await mkdir(shots, { recursive: true });
const fixture = JSON.parse(await readFile(new URL('../apps/licensing-server/deploy/catalog.json', import.meta.url), 'utf8'));
let catalogMode = 'open';
let writes = 0;
let nativeTesting = false;
let nativeEnabled = true;
let nativePaid = false;
let nativeFailure = false;
let nativeExpired = false;
let nativeOrder;
const nativeId = '12345678-1234-4234-8234-123456789012';
let alipayTesting = false;
let alipayClosed = false;
const alipayOrders = [];
const server = createServer(async (req, res) => {
  if (alipayTesting && req.url === '/v1/orders' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers['x-tblink-payment-channel'], 'alipay');
    const offer = fixture.offers.find(item => item.id === input.offerId);
    const id = `12345678-1234-4234-8234-12345678902${alipayOrders.length}`;
    alipayOrders.push({ id, token: req.headers.authorization, amountFen: offer.unitAmountFen });
    res.setHeader('content-type', 'application/json'); res.setHeader('X-Tblink-Payment-Environment', 'production');
    res.end(JSON.stringify({ id, state: 'pending', amountFen: offer.unitAmountFen, quantity: 1, offer,
      expiresAt: new Date(Date.now() + 3000).toISOString(), payable: true,
      paymentUrl: `https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&biz_content=${encodeURIComponent(JSON.stringify({ out_trade_no: `TB_${id.replaceAll('-', '')}` }))}` })); return;
  }
  const alipayQuery = alipayTesting && req.method === 'POST' && alipayOrders.find(order => req.url === `/v1/orders/${order.id}/reconcile`);
  if (alipayQuery) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: alipayQuery.id, state: alipayClosed ? 'expired' : 'pending', amountFen: alipayQuery.amountFen, quantity: 1,
      kind: 'subscription', useUntil: new Date(Date.now() + 30 * 86400000).toISOString(), updatesUntil: new Date(Date.now() + 30 * 86400000).toISOString(), licenses: [] })); return;
  }
  if (nativeTesting && req.url === '/v1/orders' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers['x-tblink-payment-channel'], 'wechat');
    const offer = fixture.offers.find(item => item.id === input.offerId);
    nativeOrder = { id: nativeId, state: 'pending', amountFen: offer.unitAmountFen, quantity: 1, offer,
      expiresAt: new Date(Date.now() + (nativeExpired ? 1500 : 900000)).toISOString(), payable: true, paymentUrl: 'weixin://wxpay/bizpayurl?pr=LOCAL_TEST_ONLY' };
    res.setHeader('content-type', 'application/json');
    if (nativeFailure) { res.writeHead(502).end(JSON.stringify({ code: 'WECHAT_REQUEST_UNCONFIRMED', message: '测试渠道响应丢失，请查询原订单', orderId: nativeId })); return; }
    res.end(JSON.stringify(nativeOrder)); return;
  }
  if (nativeTesting && req.url === `/v1/orders/${nativeId}/reconcile` && req.method === 'POST') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: nativeId, state: nativePaid ? 'fulfilled' : 'pending', amountFen: nativeOrder.amountFen, quantity: 1,
      kind: 'subscription', useUntil: new Date(Date.now() + 30 * 86400000).toISOString(), updatesUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
      licenses: nativePaid ? [{ id: '12345678-1234-4234-8234-123456789013', code: 'TBA-' + 'A'.repeat(32), revoked: false }] : [] })); return;
  }
  if (req.method !== 'GET') { writes++; res.writeHead(500).end(); return; }
  if (req.url === '/v1/catalog') {
    if (catalogMode === 'error') { res.writeHead(503).end('{}'); return; }
    const channel = req.headers['x-tblink-payment-channel'] ?? 'alipay';
    res.setHeader('X-Tblink-Payment-Channel', channel);
    const available = catalogMode === 'open' && (channel !== 'wechat' || nativeEnabled);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ available, currency: 'CNY', termStart: 'fulfillment', offers: available ? fixture.offers : [] })); return;
  }
  const files = { '/purchase/': ['purchase/index.html', 'text/html'], '/purchase.js': ['purchase.js', 'text/javascript'], '/purchase.css': ['purchase.css', 'text/css'], '/site.css': ['site.css', 'text/css'] };
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
    await page.goto(`http://127.0.0.1:${address.port}/purchase/`, {waitUntil:'networkidle'});
    const plans=page.locator('button.plan'); await plans.first().waitFor();
    assert.equal(await plans.count(),2);
    assert.equal(await page.locator('#total').textContent(),'¥800.00');
    await plans.nth(1).click();
    assert.equal(await page.locator('#total').textContent(),'¥8000.00');
    assert.equal(await plans.nth(1).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('body').innerText().then(t=>t.includes('成都相变风景科技有限公司')),false);
    assert.equal(await page.getByRole('heading', { name: '购买团播联动台授权' }).count(),1);
    assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);
    await page.evaluate(()=>globalThis.scrollTo(0,0));
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,shots)),fullPage:true});
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
    await page.goto(`http://127.0.0.1:${address.port}/purchase/`,{waitUntil:'networkidle'});
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
  await page.close(); nativeTesting = true;
  for (const [name, width, height, colorScheme] of [['desktop', 1440, 960, 'light'], ['mobile-dark', 390, 844, 'dark']]) {
    const native = await browser.newPage({ viewport: { width, height }, colorScheme });
    const errors = []; native.on('pageerror', error => errors.push(error.message));
    await native.goto(`http://127.0.0.1:${address.port}/purchase/`, { waitUntil: 'networkidle' });
    await native.locator('#payment-channel').selectOption('wechat');
    await native.waitForFunction(() => !globalThis.document.querySelector('#payment-channel').disabled);
    await native.locator('#customer').fill('本地微信验收'); await native.locator('#consent').check();
    await native.locator('#purchase-form button[type=submit]').click();
    const saved = await native.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem('tblink.purchase.receipt')));
    assert.equal(saved.version, 2); assert.equal(saved.paymentChannel, 'wechat');
    assert.equal(await native.locator('#payment-channel').isDisabled(), true);
    const download = native.waitForEvent('download'); await native.locator('#export').click(); await download;
    await native.locator('#submit-order').click(); await native.locator('#wechat-payment').waitFor({ state: 'visible' });
    assert.equal(await native.locator('#pay').isHidden(), true);
    assert.equal(await native.locator('#wechat-qr').evaluate(canvas => canvas.width === 240 && canvas.getContext('2d').getImageData(0, 0, 240, 240).data.some((v, i) => i % 4 !== 3 && v === 0)), true);
    assert.equal(await native.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    await native.locator('#order').scrollIntoViewIfNeeded();
    await native.screenshot({ path: join(tmpdir(), `tblink-wechat-${name}.png`), fullPage: true });
    nativePaid = true; await native.locator('#query').click(); await native.locator('#codes code').waitFor();
    assert.equal(await native.locator('#wechat-payment').isHidden(), true); assert.deepEqual(errors, []);
    nativePaid = false; await native.close();
  }
  const states = await browser.newPage();
  nativeEnabled = false;
  await states.goto(`http://127.0.0.1:${address.port}/purchase/`, { waitUntil: 'networkidle' });
  await states.locator('#payment-channel').selectOption('wechat');
  await states.waitForFunction(() => globalThis.document.querySelector('#catalog-status').textContent.includes('微信暂未开放'));
  assert.equal(await states.locator('#purchase-form').isHidden(), true);
  await states.locator('#payment-channel').selectOption('alipay'); await states.locator('#purchase-form').waitFor({ state: 'visible' });
  nativeEnabled = true; nativeFailure = true;
  await states.locator('#payment-channel').selectOption('wechat');
  await states.waitForFunction(() => !globalThis.document.querySelector('#payment-channel').disabled);
  await states.locator('#customer').fill('本地响应丢失验收'); await states.locator('#consent').check();
  await states.locator('#purchase-form button[type=submit]').click();
  const download = states.waitForEvent('download'); await states.locator('#export').click(); await download;
  await states.locator('#submit-order').click(); await states.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await states.locator('#query').isVisible(), true); assert.equal(await states.locator('#wechat-payment').isHidden(), true);
  assert.equal(await states.locator('#discard').isHidden(), true);
  nativeFailure = false; nativeExpired = true;
  await states.locator('#submit-order').click(); await states.locator('#wechat-payment').waitFor({ state: 'visible' });
  await states.waitForFunction(() => globalThis.document.querySelector('#order-state').textContent.includes('已过期'));
  assert.equal(await states.locator('#wechat-payment').isHidden(), true);
  console.log('wechat: local QR, fixed-channel receipt, paid/closed/failed/expired states passed; no real channel requests');
  await states.close();
  nativeTesting = false; alipayTesting = true;
  const regenerate = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const regenerateErrors = []; regenerate.on('pageerror', error => regenerateErrors.push(error.message));
  await regenerate.goto(`http://127.0.0.1:${address.port}/purchase/`, { waitUntil: 'networkidle' });
  await regenerate.locator('#customer').fill('本地关单验收'); await regenerate.locator('#consent').check();
  await regenerate.locator('#purchase-form button[type=submit]').click();
  const firstDownload = regenerate.waitForEvent('download'); await regenerate.locator('#export').click(); await firstDownload;
  await regenerate.locator('#submit-order').click(); await regenerate.locator('#pay').waitFor({ state: 'visible' });
  const first = await regenerate.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem('tblink.purchase.receipt')));
  await regenerate.locator('#restart').waitFor({ state: 'visible' });
  assert.equal(await regenerate.locator('#pay').isHidden(), true);
  assert.equal((await regenerate.locator('#order-state').textContent()).includes('已过期'), true);
  await regenerate.locator('#restart').click(); await regenerate.locator('#error').waitFor({ state: 'visible' });
  assert.equal((await regenerate.locator('#error').textContent()).includes('尚未关闭'), true);
  assert.deepEqual(await regenerate.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem('tblink.purchase.receipt'))), first);
  alipayClosed = true;
  await regenerate.locator('#restart').click();
  await regenerate.waitForFunction(() => globalThis.document.querySelector('#order-state').textContent.includes('已为同一套餐准备新订单'));
  const next = await regenerate.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem('tblink.purchase.receipt')));
  assert.equal(next.orderId, null); assert.notEqual(next.token, first.token); assert.deepEqual(next.request, first.request);
  assert.equal(await regenerate.locator('#restart').isHidden(), true); assert.equal(await regenerate.locator('#submit-order').isDisabled(), true);
  const secondDownload = regenerate.waitForEvent('download'); await regenerate.locator('#export').click(); await secondDownload;
  await regenerate.locator('#submit-order').click(); await regenerate.locator('#pay').waitFor({ state: 'visible' });
  assert.equal(alipayOrders.length, 2); assert.notEqual(alipayOrders[1].token, alipayOrders[0].token);
  assert.equal(await regenerate.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  await regenerate.screenshot({ path: join(tmpdir(), 'tblink-alipay-regenerate-mobile-dark.png'), fullPage: true });
  assert.deepEqual(regenerateErrors, []);
  console.log('alipay: expired link offers regenerate only after server confirms closure; new credential and order passed');
  await regenerate.close();

} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
