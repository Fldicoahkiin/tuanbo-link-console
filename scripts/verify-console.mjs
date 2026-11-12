import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const folder = await mkdtemp(join(tmpdir(), 'tblink-console-browser-'));
const bundle = join(folder, 'fixture.mjs');
await build({ entryPoints: [fileURLToPath(new URL('../apps/licensing-server/src/console-fixture.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'esm' });
const { startConsoleFixture } = await import(pathToFileURL(bundle).href);
const fixture = await startConsoleFixture();
const origin = 'https://admin.tuanbo-link.jinhefilm.com';
const assets = new URL('../apps/licensing-server/dist/console/', import.meta.url);
const shots = new URL('../apps/licensing-server/dist/console-review/', import.meta.url); await mkdir(shots, { recursive: true });
// 页面带上和线上一样的 CSP（从 Nginx 配置里读，不另抄一份）：组件库或页面在运行时插 <style>、内联脚本会被浏览器拦下，这里当作失败。
const csp = /add_header Content-Security-Policy "([^"]+)"/.exec(await readFile(new URL('../apps/licensing-server/deploy/console-site.conf', import.meta.url), 'utf8'))?.[1];
assert.ok(csp, 'console-site.conf 里没找到 Content-Security-Policy');
function totp(secret) {
  let bits = 0; let value = 0; const bytes = [];
  for (const char of secret) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(fixture.now() / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(); const offset = mac.at(-1) & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
function forward(request) {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers(), host: new URL(origin).host }; delete headers['content-length'];
    const req = httpRequest({ host: '127.0.0.1', port: fixture.port, path: new URL(request.url()).pathname + new URL(request.url()).search, method: request.method(), headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const responseHeaders = {}; for (const [name, value] of Object.entries(res.headers)) if (value !== undefined && !['transfer-encoding', 'connection', 'content-length'].includes(name)) responseHeaders[name] = Array.isArray(value) ? value.join('\n') : value; resolve({ status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) }); });
    }); req.on('error', reject); req.end(request.postData() ?? undefined);
  });
}
// 用户在下拉里选中一项时，浏览器先发 input 再发 change，两个事件之间页面有机会重画。selectOption 在一次调用里连发两个事件，
// 测不出「选了又弹回」（2026-11-12 现场：「原因」下拉选不上），所以这里按浏览器的顺序分两步发，并核对选中的值留住了。
// 对话框里已经没有原生下拉了；页面上还有原生下拉时用它。导出只是为了暂时没有调用时 lint 不把它当成没用的函数。
export async function choose(select, value) {
  await select.evaluate(async (element, next) => {
    element.value = next; element.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => { setTimeout(resolve, 0); });
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  assert.equal(await select.inputValue(), value);
}
// 对话框里的下拉（Base UI Select）：像人一样点开触发器、点选项，再核对触发器上显示的文字。
async function pick(scope, label, option) {
  const trigger = scope.getByRole('combobox', { name: label });
  await trigger.click(); await scope.page().getByRole('option', { name: option, exact: true }).click();
  assert.equal((await trigger.innerText()).trim(), option);
}
// 原因、付款方式：点下面的常用项，输入框里就是这段文字。
async function preset(dialog, label, option) {
  await dialog.getByRole('group', { name: `常用${label}` }).getByRole('button', { name: option, exact: true }).click();
  assert.equal(await dialog.getByRole('textbox', { name: label }).inputValue(), option);
}
const browser = await chromium.launch({ headless: true, ...(process.env.TBLINK_TEST_BROWSER_CHANNEL ? { channel: process.env.TBLINK_TEST_BROWSER_CHANNEL } : {}) }); const errors = [];
try {
  async function pageFor(role, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    await context.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/console-api/')) { await route.fulfill(await forward(route.request())); return; }
      const files = { '/': ['index.html', 'text/html'], '/console.js': ['console.js', 'application/javascript'], '/console.css': ['console.css', 'text/css'] };
      const file = files[path]; if (!file) { await route.fulfill({ status: 404 }); return; }
      await route.fulfill({ contentType: file[1], headers: { 'Content-Security-Policy': csp }, body: await readFile(new URL(file[0], assets)) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) errors.push(message.text()); });
    await page.goto(origin); await page.getByRole('button', { name: '使用开通凭据设置账号' }).click();
    const invitation = role === 'owner' ? { token: fixture.invitation } : fixture.invite(role);
    const secret = role === 'owner' ? fixture.secret : fixture.enrollment(invitation.token).secret;
    await page.getByLabel('一次性开通凭据').fill(invitation.token); await page.getByRole('button', { name: '准备绑定验证器' }).click();
    // 验证码输满 6 位且密码已填时自动提交开通。
    await page.getByLabel('设置密码').fill('browser-isolated-password'); await page.getByLabel('验证器验证码', { exact: true }).fill(totp(secret));
    await page.getByRole('heading', { name: '保存恢复码' }).waitFor();
    const recovery = await page.getByTestId('recovery-codes').getByRole('listitem').first().innerText();
    await page.getByRole('button', { name: '已保存，返回登录' }).click();
    await page.getByLabel('用户名', { exact: true }).fill(`fixture-${role}`); await page.getByLabel('密码', { exact: true }).fill('browser-isolated-password');
    if (role === 'operations') {
      // 下一枚验证码输满 6 位即自动登录，不点按钮。
      fixture.advance(30000); await page.getByLabel('验证器验证码', { exact: true }).fill(totp(secret));
    } else {
      // 恢复码是次要入口：点「改用恢复码」才换成长输入框。
      await page.getByRole('button', { name: '改用恢复码' }).click(); await page.getByLabel('恢复码', { exact: true }).fill(recovery);
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
    return { page, context };
  }
  const { page, context } = await pageFor('owner');
  await page.getByRole('button', { name: '订单中心', exact: true }).click(); await page.getByRole('button', { name: '创建线下订单', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('业务订单编号').fill('BROWSER-ORDER-1'); await dialog.getByLabel('客户名称').fill('浏览器验收客户');
  // 备注选填：不填也能创建。
  await dialog.getByLabel('授权截止时间').fill('2026-11-06T16:00'); await dialog.getByLabel('金额').fill('800');
  await dialog.getByRole('button', { name: '创建订单' }).click(); await dialog.getByText('线下订单已创建，待核款').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '查看详情' }).first().click(); await page.getByRole('button', { name: '确认线下收款' }).click();
  // 必填项未填时点主按钮：不提交，在字段下面写明缺什么；付款方式可以直接填常用项以外的文字；备注选填。
  await dialog.getByRole('textbox', { name: '付款方式' }).fill('测试核款');
  await dialog.getByRole('button', { name: '确认收款并发码' }).click(); await dialog.getByText('请填写收款流水号').waitFor();
  assert.equal(await dialog.getByText('核款与发码已完成').count(), 0);
  await dialog.getByLabel('收款流水号').fill('BROWSER-BANK-1');
  // 只签一份时结果直接显示激活码，点完成后直接打开这张授权的详情。
  await dialog.getByRole('button', { name: '确认收款并发码' }).click(); await dialog.getByText('核款与发码已完成').waitFor(); assert.match(await dialog.getByTestId('secret').innerText(), /^TBA-/);
  await dialog.getByRole('button', { name: '完成', exact: true }).click(); await page.getByRole('heading', { name: '授权详情' }).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('TBA-'), false);
  await page.getByRole('button', { name: '查看完整激活码' }).click(); await preset(dialog, '原因（选填）', '向客户交付'); await dialog.getByRole('button', { name: '显示激活码' }).click(); await dialog.getByTestId('secret').waitFor(); assert.match(await dialog.getByTestId('secret').innerText(), /^TBA-/); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  // 超过 30 分钟（二次验证有效期）后再做敏感操作：表单上方弹验证层，输错抖动并清空，输对后自动继续原操作。
  fixture.advance(30 * 60000 + 1000);
  await page.getByRole('button', { name: '查看完整激活码' }).click(); await preset(dialog, '原因（选填）', '核对客户提供的激活码'); await dialog.getByRole('button', { name: '显示激活码' }).click();
  await page.getByText('二次验证：未验证').waitFor();
  const code = dialog.getByLabel('验证器验证码', { exact: true }); await code.fill('000000'); await dialog.getByText('验证码不对或已用过').waitFor(); assert.equal(await code.inputValue(), '');
  assert.equal(await dialog.getByRole('textbox', { name: '原因' }).inputValue(), '核对客户提供的激活码');
  await code.fill(totp(fixture.secret)); await dialog.getByTestId('secret').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByText(/二次验证：有效/).waitFor();
  // 第二张线下单生成支付宝付款链接：显示二维码，弹窗每 5 秒读一次订单状态，模拟到账后提示已付款。
  await page.getByRole('button', { name: '订单中心', exact: true }).click(); await page.getByRole('button', { name: '创建线下订单', exact: true }).click();
  await dialog.getByLabel('业务订单编号').fill('BROWSER-ORDER-2'); await dialog.getByLabel('客户名称').fill('放弃付款客户');
  await dialog.getByLabel('授权截止时间').fill('2026-11-06T16:00'); await dialog.getByLabel('金额').fill('800');
  await dialog.getByRole('button', { name: '创建订单' }).click(); await dialog.getByText('线下订单已创建，待核款').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('row', { name: /BROWSER-ORDER-2/ }).getByRole('button', { name: '查看详情' }).click(); await page.getByRole('heading', { name: '订单详情' }).waitFor();
  await page.getByRole('button', { name: '生成支付宝付款链接' }).click();
  await dialog.getByRole('button', { name: '生成链接' }).click(); await dialog.getByAltText('支付宝付款二维码').waitFor();
  fixture.payAlipay(new URL(page.url()).hash.split('/')[2]); await dialog.getByText('已付款，已发码。').waitFor({ timeout: 12000 }); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  // 第三张线下单：未生成付款链接的待付款单可关闭。
  await page.getByRole('button', { name: '订单中心', exact: true }).click(); await page.getByRole('button', { name: '创建线下订单', exact: true }).click();
  await dialog.getByLabel('业务订单编号').fill('BROWSER-ORDER-3'); await dialog.getByLabel('客户名称').fill('放弃付款客户');
  await dialog.getByLabel('授权截止时间').fill('2026-11-06T16:00'); await dialog.getByLabel('金额').fill('800');
  await dialog.getByRole('button', { name: '创建订单' }).click(); await dialog.getByText('线下订单已创建，待核款').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('row', { name: /BROWSER-ORDER-3/ }).getByRole('button', { name: '查看详情' }).click(); await page.getByRole('heading', { name: '订单详情' }).waitFor();
  // 原因选填（2026-11-12）：没选原因时按钮就能点，不选原因直接关闭订单。
  await page.getByRole('button', { name: '关闭订单', exact: true }).click(); assert.equal(await dialog.getByRole('button', { name: '关闭此订单' }).isDisabled(), false);
  await dialog.getByRole('button', { name: '关闭此订单' }).click(); await dialog.getByText('订单已关闭').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '关闭订单', exact: true }).count(), 0);
  // 待办数字跳转带上对应筛选。
  await page.getByRole('button', { name: '工作台', exact: true }).click(); await page.getByRole('button', { name: /七日内到期/ }).click();
  assert.equal(await page.getByRole('tab', { name: /^即将到期/ }).getAttribute('aria-selected'), 'true');
  // 生命周期页签写进网址：切到「未激活」后刷新仍是同一视图；整行点进详情有时间线，刷新后仍在详情，后退回到列表。
  await page.getByRole('tab', { name: /^未激活/ }).click(); await page.getByRole('row', { name: /浏览器验收客户/ }).waitFor();
  assert.match(page.url(), /#\/licenses\?state=unbound$/);
  // 剩余天数按服务器时间（夹具时钟 10 月 6 日）计算，与状态色块同一个时钟。
  await page.getByRole('row', { name: /浏览器验收客户/ }).getByText('还有 31 天').waitFor();
  await page.reload(); await page.getByRole('row', { name: /浏览器验收客户/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /^未激活/ }).getAttribute('aria-selected'), 'true');
  await page.getByRole('row', { name: /浏览器验收客户/ }).click(); await page.getByRole('heading', { name: '生命周期' }).waitFor();
  await page.reload(); await page.getByRole('heading', { name: '授权详情' }).waitFor(); await page.getByText('签发（销售）').waitFor();
  await page.goBack(); await page.getByRole('tab', { name: /^未激活/, selected: true }).waitFor();
  // 只有 1 名可用管理员时，人员页提示开通第二名，入口预选角色和原因，只需填用户名。
  await page.getByRole('button', { name: '人员管理', exact: true }).click(); await page.getByRole('button', { name: '开通第二名管理员' }).click();
  assert.equal((await dialog.getByRole('combobox', { name: '角色' }).innerText()).trim(), '管理员'); assert.equal(await dialog.locator('input[name="role"]').inputValue(), 'owner'); assert.equal(await dialog.getByRole('textbox', { name: '原因' }).inputValue(), '备用管理员');
  await dialog.getByLabel('用户名').fill('backup-admin'); await dialog.getByRole('button', { name: '生成开通凭据' }).click(); await dialog.getByTestId('secret').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('row', { name: /backup-admin/ }).getByText('待开通').waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('owner-desktop.png', shots)), fullPage: true });
  // 问题反馈：软件里提交的一条反馈出现在待办和列表里；详情能下载诊断包，结案必须写处理结论。
  const report = await fixture.submitFeedback('播放第 3 首时灯光没有跟上，OBS 画面正常');
  await page.getByRole('button', { name: '工作台', exact: true }).click(); await page.getByRole('button', { name: /待处理问题反馈/ }).click();
  await page.getByRole('row', { name: new RegExp(report.number) }).click(); await page.getByRole('heading', { name: '反馈详情' }).waitFor();
  await page.getByText('播放第 3 首时灯光没有跟上，OBS 画面正常').waitFor(); await page.getByText('微信 fixture').waitFor();
  // 浏览器下载不经过测试路由，这里用同一会话请求链接地址，核对文件名、类型和大小。
  const served = await page.evaluate(async href => { const response = await fetch(href); return { status: response.status, disposition: response.headers.get('content-disposition'), type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength }; },
    await page.getByRole('link', { name: '下载诊断包' }).getAttribute('href'));
  assert.deepEqual(served, { status: 200, disposition: `attachment; filename="${report.number}.tbdiag.gz"`, type: 'application/gzip', bytes: report.bytes });
  await page.getByRole('button', { name: '处理问题反馈', exact: true }).click();
  await pick(dialog, '处理状态', '关闭'); await dialog.getByRole('button', { name: '保存处理结果' }).click();
  await dialog.getByText('关闭前请写明处理结论').waitFor();
  await dialog.getByLabel('处理结论').fill('MA2 时间线 MTC 起始码偏了 2 帧，已改正'); await dialog.getByRole('button', { name: '保存处理结果' }).click();
  await dialog.getByText('反馈已更新').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByText('MA2 时间线 MTC 起始码偏了 2 帧，已改正').waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('owner-feedback.png', shots)), fullPage: true });
  // 软件更新：只有管理员可见；发布对话框带上所选候选的 manifest 摘要，结果以服务器发布脚本为准（此处不提交）。
  await page.getByRole('button', { name: '软件更新', exact: true }).click();
  await page.getByText('0.5.0-13f7e625898e', { exact: true }).waitFor();
  assert.equal(await page.getByText('0.4.29', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '发布更新', exact: true }).click();
  const publish = page.getByRole('dialog');
  assert.equal(await publish.locator('input[name="manifestSha256"]').inputValue(), 'b'.repeat(64));
  await publish.getByRole('button', { name: '发布到更新源' }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('owner-updates.png', shots)), fullPage: true });
  await publish.getByRole('button', { name: '关闭操作窗口' }).click();
  await context.close();
  for (const role of ['operations', 'finance', 'viewer']) {
    const { page, context } = await pageFor(role, role === 'viewer' ? 390 : 1440);
    // 工作台金额只给管理员和财务。
    await page.getByRole('heading', { name: '待办事项' }).waitFor();
    assert.equal(await page.getByText('累计净收款').count(), role === 'finance' ? 1 : 0);
    assert.equal(await page.getByRole('heading', { name: '收款趋势' }).count(), role === 'finance' ? 1 : 0);
    assert.equal(await page.getByRole('button', { name: '人员管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '软件更新', exact: true }).count(), 0);
    // 反馈带联系方式和诊断包，只有运营能看到入口。
    assert.equal(await page.getByRole('button', { name: '问题反馈', exact: true }).count(), role === 'operations' ? 1 : 0);
    assert.equal(await page.getByRole('button', { name: /待处理问题反馈/ }).count(), role === 'operations' ? 1 : 0);
    await page.getByRole('button', { name: '订单中心', exact: true }).click(); await page.getByRole('row', { name: /BROWSER-ORDER-1/ }).getByRole('button', { name: '查看详情' }).click(); await page.getByRole('heading', { name: '订单详情' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '重发领取凭据', exact: true }).count(), role === 'operations' ? 1 : 0);
    assert.equal(await page.getByRole('button', { name: '登记已办理的退款', exact: true }).count(), role === 'finance' ? 1 : 0);
    assert.equal((await page.locator('body').innerText()).includes('TBA-'), false);
    const dialog = page.getByRole('dialog');
    if (role === 'operations') {
      // Credential-invalidating actions name their consequence in red; close without executing.
      await page.getByRole('button', { name: '重发领取凭据', exact: true }).click();
      const confirm = dialog.getByRole('button', { name: '重发凭据' });
      assert.equal(await confirm.getAttribute('data-destructive'), 'true');
      await page.screenshot({ path: fileURLToPath(new URL('operations-destructive-dialog.png', shots)) });
      await dialog.getByRole('button', { name: '关闭操作窗口' }).click(); await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '创建售后工单', exact: true }).click();
      await dialog.getByLabel('问题描述').fill('浏览器测试工单');
      await dialog.getByRole('button', { name: '创建工单' }).click(); await dialog.getByText('售后工单已创建').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '售后工单', exact: true }).click(); await page.getByRole('button', { name: '查看详情' }).first().click(); await page.getByRole('button', { name: '处理工单', exact: true }).click();
      await pick(dialog, '处理状态', '关闭'); await dialog.getByLabel('授权处理结论').fill('已核对，不变更授权');
      await dialog.getByRole('button', { name: '保存处理结果' }).click(); await dialog.getByText('工单已更新').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
    }
    if (role === 'finance') {
      await page.getByRole('button', { name: '登记已办理的退款', exact: true }).click();
      await dialog.getByLabel('金额').fill('80'); await dialog.getByLabel('退款凭证编号').fill('BROWSER-REFUND-1'); await dialog.getByLabel('实际办理时间').fill('2026-10-05T00:00');
      await dialog.getByRole('button', { name: '登记退款' }).click(); await dialog.getByText('退款已登记').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '记录开票进度', exact: true }).click();
      await dialog.getByLabel('购买方抬头').fill('浏览器验收客户'); await dialog.getByRole('button', { name: '保存开票记录' }).click();
      await dialog.getByText('开票记录已保存').waitFor(); await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '财务记录', exact: true }).click(); await page.getByText('BROWSER-REFUND-1', { exact: true }).waitFor();
      // 工作台大字为净收款：线下 800 元加支付宝 800 元，扣除 80 元退款。
      await page.getByRole('button', { name: '工作台', exact: true }).click(); await page.locator('.balance-primary strong', { hasText: /^¥1520\.00$/ }).waitFor();
    }
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    await page.screenshot({ path: fileURLToPath(new URL(`${role}.png`, shots)), fullPage: true }); await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Console browser acceptance passed: real isolated enrollment/login, manual delivery, protected reveal, operations ticket closure, problem report download and closure, finance refund/invoice records, four roles, mobile layout. No production payments or credentials used.');
} finally { await browser.close(); await fixture.close(); }
