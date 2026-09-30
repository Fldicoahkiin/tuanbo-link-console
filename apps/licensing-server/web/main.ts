import QRCode from 'qrcode';
import { z } from 'zod';
import { purchaseRequestSchema, paymentChannelSchema, type PurchaseCatalogResponse } from '../../../packages/schema/src/purchase';
import { WebPurchaseClient, type WebReceipt } from './purchase-client';

function element<T extends HTMLElement>(id: string, type: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof type)) throw new Error(`页面缺少 ${id}`);
  return value;
}
const channelInput = element('payment-channel', HTMLSelectElement);
const wechatPanel = element('wechat-payment', HTMLDivElement);
const wechatQr = element('wechat-qr', HTMLCanvasElement);
let paymentExpiry: ReturnType<typeof setTimeout> | undefined;
function clearPayment(): void {
  clearTimeout(paymentExpiry); wechatPanel.hidden = true; wechatQr.width = 0;
  pay.hidden = true; pay.removeAttribute('href');
}
const form = element('purchase-form', HTMLFormElement);
const offerInput = element('offer', HTMLSelectElement);
const planOptions = element('plan-options', HTMLDivElement);
const quantity = element('quantity', HTMLInputElement);
const customer = element('customer', HTMLInputElement);
const customerType = element('customer-type', HTMLSelectElement);
const error = element('error', HTMLParagraphElement);
const orderPanel = element('order', HTMLElement);
const orderState = element('order-state', HTMLParagraphElement);
const orderSummary = element('order-summary', HTMLParagraphElement);
const catalogStatus = element('catalog-status', HTMLParagraphElement);
const pay = element('pay', HTMLAnchorElement);
const query = element('query', HTMLButtonElement);
const submit = element('submit-order', HTMLButtonElement);
const download = element('export', HTMLButtonElement);
const finish = element('finish', HTMLButtonElement);
const discard = element('discard', HTMLButtonElement);
const codes = element('codes', HTMLUListElement);
const deliveryState = element('delivery-state', HTMLParagraphElement);
const importInput = element('import', HTMLInputElement);
const client = new WebPurchaseClient({ getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) });
let catalog: PurchaseCatalogResponse | null = null;
let saved = false;
let busy = false;
let storageReady = false;
const money = (fen: number): string => `¥${(fen / 100).toFixed(2)}`;
const selectedOffer = () => catalog?.offers.find(offer => offer.id === offerInput.value);

function updateQuote(): void {
  const offer = selectedOffer();
  if (!offer) return;
  quantity.max = String(offer.maxQuantity);
  element('offer-detail', HTMLParagraphElement).textContent = `使用 ${offer.useDays} 天，更新权益 ${offer.updatesDays} 天。${money(offer.unitAmountFen)} / 台。按天计算，自核款发码起算。`;
  const count = quantity.valueAsNumber;
  element('total', HTMLElement).textContent = Number.isInteger(count) && count >= 1 && count <= offer.maxQuantity ? money(count * offer.unitAmountFen) : '请检查数量';
  planOptions.querySelectorAll<HTMLButtonElement>('button[data-offer]').forEach(button => {
    const selected = button.dataset.offer === offer.id;
    button.setAttribute('aria-pressed', String(selected));
    const state = button.querySelector('.plan-state');
    if (state) state.textContent = selected ? '已选择' : '选择套餐';
  });
}

function renderReceipt(receipt: WebReceipt | null): void {
  orderPanel.hidden = receipt === null;
  query.hidden = !receipt?.orderId;
  channelInput.disabled = busy || receipt !== null;
  if (receipt) channelInput.value = receipt.version === 2 ? 'wechat' : 'alipay';
  form.hidden = !storageReady || receipt !== null || !catalog?.available;
  if (receipt) {
    orderSummary.textContent = `${receipt.request.customer} · ${receipt.request.quantity} 台 · ${money(receipt.request.quantity * receipt.request.quotedUnitAmountFen)}${receipt.orderId ? ` · 订单号 ${receipt.orderId}` : ''}`;
  }
  submit.disabled = !saved || busy;
  planOptions.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    button.disabled = busy || receipt !== null || !catalog?.available;
    if (receipt) {
      const offer = catalog?.offers.find(candidate => candidate.id === button.dataset.offer);
      const selected = offer?.id === receipt.request.offerId && offer.revision === receipt.request.revision && offer.unitAmountFen === receipt.request.quotedUnitAmountFen;
      button.setAttribute('aria-pressed', String(selected));
      const state = button.querySelector('.plan-state');
      if (state) state.textContent = selected ? '本单套餐' : '当前在售套餐';
    }
  });
  discard.hidden = !receipt?.discardable || receipt.orderId !== null;
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true; error.hidden = true;
  const controls = Array.from(document.querySelectorAll('button, input, select')).filter((item): item is HTMLButtonElement | HTMLInputElement | HTMLSelectElement => item instanceof HTMLButtonElement || item instanceof HTMLInputElement || item instanceof HTMLSelectElement);
  const states = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try { await action(); }
  catch (failure) {
    if (!catalog) {
      catalogStatus.textContent = '套餐读取未完成，请检查连接后重新读取。';
      planOptions.textContent = '套餐暂时无法加载，请在下方重新读取。';
    }
    error.textContent = failure instanceof TypeError ? '连接失败，请保留订单凭据，恢复或查询原单后再操作。' : failure instanceof z.ZodError ? '资料格式或服务返回内容不正确。请保留订单凭据并联系支持。' : failure instanceof Error ? failure.message : '操作未完成，请保留凭据并查询原订单';
    error.hidden = false;
  } finally {
    controls.forEach((control, index) => { control.disabled = states[index] ?? false; });
    busy = false;
    renderReceipt(client.receipt);
  }
}

async function loadCatalog(): Promise<void> {
  catalog = null;
  form.hidden = true;
  planOptions.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'plan-loading'; loading.textContent = '正在加载月付与年付套餐';
  planOptions.append(loading);
  catalogStatus.textContent = '正在读取可售套餐…';
  const channel = client.receipt?.version === 2 ? 'wechat' : client.receipt ? 'alipay' : paymentChannelSchema.parse(channelInput.value);
  channelInput.value = channel;
  const response = await client.catalog(channel);
  const offers = response.offers.filter(offer => offer.kind === 'subscription');
  catalog = { ...response, offers, available: response.available && offers.length > 0 };
  offerInput.replaceChildren(...offers.map(offer => {
    const option = document.createElement('option'); option.value = offer.id; option.textContent = `${offer.name} · ${money(offer.unitAmountFen)} / 台`; return option;
  }));
  planOptions.replaceChildren(...offers.map(offer => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'plan'; button.dataset.offer = offer.id;
    button.setAttribute('aria-pressed', 'false');
    const name = document.createElement('span'); name.className = 'plan-name';
    name.textContent = offer.useDays === 30 ? '月付授权' : offer.useDays === 365 ? '年付授权' : offer.name;
    const price = document.createElement('span'); price.className = 'plan-price';
    price.textContent = `¥${(offer.unitAmountFen / 100).toLocaleString('zh-CN')}`;
    const unit = document.createElement('span'); unit.className = 'plan-unit'; unit.textContent = `/ ${offer.useDays} 天 / 台`;
    const detail = document.createElement('span'); detail.className = 'plan-detail';
    detail.textContent = `全部功能，含 ${offer.updatesDays} 天更新权益`;
    const state = document.createElement('span'); state.className = 'plan-state';
    state.textContent = '选择套餐';
    button.append(name, price, unit, detail, state);
    button.addEventListener('click', () => { if (!busy && !client.receipt) { offerInput.value = offer.id; updateQuote(); } });
    return button;
  }));
  if (!catalog.available) {
    const unavailable = document.createElement('p'); unavailable.className = 'plan-loading';
    unavailable.textContent = '暂未开放购买，已有订单可以继续恢复和查询。'; planOptions.replaceChildren(unavailable);
  }
  const restoredOffer = client.receipt?.request.offerId;
  if (restoredOffer && offers.some(offer => offer.id === restoredOffer)) offerInput.value = restoredOffer;
  catalogStatus.textContent = catalog.available ? '选择套餐和电脑数量，随后保存订单凭据。' : `${channel === 'wechat' ? '微信' : '支付宝'}暂未开放购买。已有订单仍可恢复和查询，也可切换支付方式查看。`;
  updateQuote();
}

function exportReceipt(): void {
  const receipt = client.receipt;
  if (!receipt) throw new Error('没有可导出的订单凭据');
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `团播联动台-订单凭据-${receipt.orderId ?? receipt.createdAt.replaceAll(/[:.]/g, '-')}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  saved = true;
  orderState.textContent = '请确认文件已保存到你的电脑，然后创建或恢复原订单。';
}

async function readDelivery(reconcile = false): Promise<void> {
  codes.replaceChildren(); finish.hidden = true;
  const delivery = await client.delivery(reconcile);
  if (delivery.state === 'pending') {
    if (delivery.paymentConfirmed) {
      clearPayment(); submit.hidden = true;
      orderState.textContent = '付款已确认，无需再次付款。';
      deliveryState.textContent = '授权尚未交付，请保留订单号并联系支持处理。'; return;
    }
    deliveryState.textContent = '服务端尚未确认到账。如已付款，请稍后点击查询；不要重复付款。'; return;
  }
  clearPayment(); submit.hidden = true;
  orderState.textContent = '订单已交付，无需再次付款。';
  deliveryState.textContent = `付款已核实。使用期限至 ${delivery.useUntil ? new Date(delivery.useUntil).toLocaleString('zh-CN') : '永久'}；更新权益至 ${new Date(delivery.updatesUntil).toLocaleString('zh-CN')}。请保存以下激活码并在软件中激活。`;
  codes.replaceChildren(...delivery.licenses.map((license, index) => {
    const li = document.createElement('li'); const label = document.createElement('div'); label.textContent = `第 ${index + 1} 台电脑`;
    const code = document.createElement('code'); code.textContent = license.revoked ? '该授权已撤销，请联系支持' : license.code;
    li.append(label, code); return li;
  }));
  finish.hidden = false;
}

async function submitOrder(): Promise<void> {
  clearPayment();
  const result = await client.submit();
  renderReceipt(client.receipt); query.hidden = false;
  orderState.textContent = result.state === 'fulfilled' ? '此订单已交付，请领取并保存激活码。' : result.payable ? `订单已创建。请于 ${new Date(result.expiresAt).toLocaleString('zh-CN')} 前付款。` : '付款入口已失效或暂停。请查询原订单；如已付款，请勿重复购买。';
  if (result.paymentUrl && result.payable) {
    if (client.receipt?.version === 2) {
      await QRCode.toCanvas(wechatQr, result.paymentUrl, { width: 240, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      wechatPanel.hidden = false;
    } else { pay.href = result.paymentUrl; pay.hidden = false; }
    const expire = () => { clearPayment(); orderState.textContent = '付款入口已过期，请查询原订单；如已付款，请勿重复购买。'; };
    const remaining = Date.parse(result.expiresAt) - Date.now();
    if (remaining <= 0) expire(); else paymentExpiry = setTimeout(expire, remaining);
  }
  if (result.state === 'fulfilled') await readDelivery();
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void run(() => {
    const offer = selectedOffer(); if (!offer) throw new Error('请重新读取可售套餐');
    client.prepare(purchaseRequestSchema.parse({ offerId: offer.id, revision: offer.revision, quotedUnitAmountFen: offer.unitAmountFen,
      quantity: quantity.valueAsNumber, customer: customer.value, customerType: customerType.value }), paymentChannelSchema.parse(channelInput.value));
    saved = false; submit.hidden = false; query.hidden = true; finish.hidden = true;
    orderState.textContent = '尚未提交订单，也未发起付款。请先下载专属订单凭据。';
    return Promise.resolve();
  });
});
channelInput.addEventListener('change', () => { if (!client.receipt) void run(loadCatalog); });
offerInput.addEventListener('change', updateQuote);
quantity.addEventListener('input', updateQuote);
element('reload', HTMLButtonElement).addEventListener('click', () => { void run(loadCatalog); });
download.addEventListener('click', () => { void run(() => { exportReceipt(); return Promise.resolve(); }); });
submit.addEventListener('click', () => { if (saved) void run(submitOrder); });
query.addEventListener('click', () => { void run(() => readDelivery(true)); });
discard.addEventListener('click', () => { void run(async () => {
  client.discard(); saved = false; clearPayment(); await loadCatalog();
}); });
finish.addEventListener('click', () => { void run(async () => {
  await client.finish(); codes.replaceChildren(); deliveryState.textContent = ''; saved = false;
  await loadCatalog();
}); });
importInput.addEventListener('change', () => { void run(async () => {
  const file = importInput.files?.[0]; if (!file) return;
  if (file.size > 32768) throw new Error('订单凭据文件超过大小限制');
  client.importReceipt(await file.text()); storageReady = true; saved = true;
  clearPayment();
  codes.replaceChildren(); deliveryState.textContent = ''; submit.hidden = false; query.hidden = true; finish.hidden = true;
  orderState.textContent = '已载入凭据。点击恢复原单后查询付款和交付状态。';
}); });
void run(async () => {
  client.restore(); storageReady = true;
  if (client.receipt) orderState.textContent = '已恢复当前标签页的订单记录。请保存凭据，再恢复同一笔订单。';
  await loadCatalog();
});
