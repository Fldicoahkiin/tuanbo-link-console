import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, ShoppingCart, KeyRound } from 'lucide-react';
import { z } from 'zod';
import { purchaseCatalogResponseSchema, purchaseReceiptSchema, purchaseRequestSchema, type PurchaseCatalogResponse, type PurchaseReceipt } from '@tb/schema';
import { Button } from './Button';

const money = (fen: number): string => `¥${(fen / 100).toFixed(2)}`;
const recordsSchema = z.array(purchaseReceiptSchema).max(100);

export function PurchaseSettings({ runtimeActive, onSelectCode }: { runtimeActive: boolean; onSelectCode: (code: string) => void }): JSX.Element {
  const [catalog, setCatalog] = useState<PurchaseCatalogResponse | null>(null);
  const [records, setRecords] = useState<PurchaseReceipt[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [offerId, setOfferId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [customer, setCustomer] = useState('');
  const [customerType, setCustomerType] = useState<'personal' | 'company'>('personal');
  const [confirmed, setConfirmed] = useState(false);
  const offer = catalog?.offers.find(item => item.id === offerId);
  const unresolved = records.some(record => !record.rejected && record.delivery?.state !== 'fulfilled');
  useEffect(() => {
    let alive = true;
    void window.tbLink.listPurchases().then(value => {
      const parsed = recordsSchema.parse(value);
      if (alive) { setRecords(parsed); setReady(true); }
    }).catch((failure: unknown) => { if (alive) setError(`读取购买记录失败：${failure instanceof Error ? failure.message : String(failure)}`); });
    return () => { alive = false; };
  }, []);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      try { setRecords(recordsSchema.parse(await window.tbLink.listPurchases())); setReady(true); }
      catch (failure) { setReady(false); setError(previous => `${previous}${previous ? '；' : ''}读取购买记录失败：${failure instanceof Error ? failure.message : String(failure)}`); }
      running.current = false; setBusy(false);
    }
  };
  const loadCatalog = async (): Promise<void> => {
    setCatalog(null); setConfirmed(false);
    const value = purchaseCatalogResponseSchema.parse(await window.tbLink.getPurchaseCatalog());
    setCatalog(value); setOfferId(value.offers[0]?.id ?? ''); setQuantity(1);
  };
  const create = async (): Promise<void> => {
    if (!offer || !confirmed || unresolved || !ready) return;
    await window.tbLink.createPurchase(purchaseRequestSchema.parse({ offerId: offer.id, revision: offer.revision,
      quotedUnitAmountFen: offer.unitAmountFen, quantity, customer, customerType }));
    setConfirmed(false); setMessage('订单已创建，领取凭据已加密保存在本机。请从下方订单打开支付宝付款页。');
  };
  return <section aria-label="购买与订单" className="settings-section">
    <div className="device-section-heading"><h3>购买与订单</h3><Button className="secondary-button" disabled={busy} onClick={() => void run(loadCatalog)}><ShoppingCart />查看可售授权</Button></div>
    <p className="settings-note">无需注册账户。付款后返回这里查询并领取激活码，再选择一枚激活本机。企业订单每台电脑使用独立激活码。下方保留上次查询结果，点击查询更新付款与授权状态。</p>
    {catalog && !catalog.available ? <p role="status">购买尚未开放，请联系发行方。已有订单仍可查询。</p> : null}
    {catalog?.available ? <form onSubmit={event => { event.preventDefault(); void run(create); }}>
      <fieldset className="purchase-fields" disabled={busy || !ready || unresolved}>
        <label className="settings-path-row"><span>授权商品</span><select aria-label="授权商品" value={offerId} onChange={event => { setOfferId(event.target.value); setQuantity(1); setConfirmed(false); }}>{catalog.offers.map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.unitAmountFen)} / 台</option>)}</select></label>
        <label className="settings-path-row"><span>购买主体</span><select aria-label="购买主体" value={customerType} onChange={event => { setCustomerType(z.enum(['personal', 'company']).parse(event.target.value)); setConfirmed(false); }}><option value="personal">个人</option><option value="company">企业</option></select></label>
        <label className="settings-path-row"><span>授权客户名称</span><input aria-label="授权客户名称" required maxLength={160} value={customer} onChange={event => { setCustomer(event.target.value); setConfirmed(false); }} autoComplete="off" placeholder={customerType === 'company' ? '公司名称' : '显示在授权中的称呼'} /></label>
        <label className="settings-path-row"><span>机器数量</span><input aria-label="机器数量" type="number" required min={1} max={offer?.maxQuantity ?? 1} step={1} value={Number.isNaN(quantity) ? '' : quantity} onChange={event => { setQuantity(event.target.valueAsNumber); setConfirmed(false); }} /></label>
        {offer ? <p className="settings-note">含税总价 {Number.isInteger(quantity) && quantity > 0 ? money(offer.unitAmountFen * quantity) : '—'}。{offer.kind === 'perpetual' ? '买断永久使用' : `使用 ${offer.useDays} 天`}，升级服务 {offer.updatesDays} 天；首次核款交付时起算，每天为 24 小时。每次启动需联网验证，换机需办理迁移。</p> : null}
        <label className="purchase-confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对价格、机器数量与授权期限</label>
        <div className="settings-header-actions"><Button type="submit" className="primary-button" disabled={!offer || !confirmed || !customer.trim()}><ShoppingCart />创建购买订单</Button></div>
      </fieldset>
    </form> : null}
    {unresolved ? <p className="settings-note">还有待核对的购买。若关闭过付款页或遇到网络错误，请恢复原订单，不要重复付款。</p> : null}
    {!ready ? <Button className="secondary-button" disabled={busy} onClick={() => void run(() => Promise.resolve())}>重新读取购买记录</Button> : null}
    {ready && records.length === 0 ? <p className="settings-note">本机暂无购买记录。</p> : null}
    {[...records].reverse().map(record => <article key={record.localId} className="settings-section" aria-label={`购买记录 ${record.order?.id ?? record.localId}`}>
      <h4>{record.order?.offer.name ?? record.request.offerId}</h4>
      <p>{record.rejected ? '未建单，请重新查看商品' : record.delivery?.state === 'fulfilled' ? '已付款，可领取激活码' : record.order?.state === 'fulfilled' ? '已付款，待领取' : record.order ? '待付款或核对' : '结果待确认，请恢复原订单'}</p>
      <p className="settings-note">{new Date(record.createdAt).toLocaleString('zh-CN')} · {record.request.quantity} 台 · {money(record.order?.amountFen ?? record.request.quotedUnitAmountFen * record.request.quantity)}</p>
      <label className="settings-path-row"><span>{record.order ? '订单编号' : '本机购买编号'}</span><input aria-label="购买编号" value={record.order?.id ?? record.localId} readOnly onFocus={event => event.currentTarget.select()} /></label>
      {!record.rejected ? <div className="settings-header-actions">
        <Button className="secondary-button" disabled={busy} onClick={() => void run(async () => { await window.tbLink.refreshPurchase(record.localId); setMessage('已查询原订单。待付状态不代表渠道已确认未付款。'); })}><RefreshCw />{record.order ? '查询付款并领取' : '恢复原订单'}</Button>
        {record.order?.state === 'pending' && record.delivery?.state !== 'fulfilled' ? <Button className="primary-button" disabled={busy || !record.order.payable} onClick={() => void run(async () => { await window.tbLink.openPurchasePayment(record.localId); setMessage('已打开系统浏览器。完成付款后返回此处查询并领取。'); })}><ExternalLink />打开支付宝付款页</Button> : null}
      </div> : null}
      {record.delivery?.state === 'fulfilled' ? <>
        <p className="settings-note">使用期限：{record.delivery.useUntil ? new Date(record.delivery.useUntil).toLocaleString('zh-CN') : '永久'}；升级服务截止：{new Date(record.delivery.updatesUntil).toLocaleString('zh-CN')}。</p>
        {record.delivery.licenses.map((license, index) => <div key={license.id}>
          <label className="settings-path-row"><span>激活码 {index + 1}</span><input aria-label={`激活码 ${index + 1}`} readOnly type="password" value={license.code ?? ''} placeholder={license.revoked ? '已撤销' : ''} onFocus={event => event.currentTarget.select()} /></label>
          <div className="settings-header-actions">
            <Button className="secondary-button" disabled={busy || runtimeActive || !license.code} onClick={() => { if (license.code) { onSelectCode(license.code); setMessage('已填入上方激活码栏，请确认后点击“激活本机”。'); } }}><KeyRound />填入本机激活栏</Button>
            <Button className="secondary-button" disabled={busy || !license.code} onClick={() => void run(async () => { await window.tbLink.copyPurchaseCode(record.localId, license.id); setMessage(`已复制第 ${index + 1} 枚激活码。`); })}><Copy />复制激活码</Button>
          </div>
        </div>)}
      </> : null}
    </article>)}
    {records.length ? <p className="settings-note">领取凭据从建单起有效七天，已加密保存在本机。更换电脑、重装或凭据过期时，请凭购买记录联系发行方核实恢复。查询不会自动激活或绑定机器。</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className="device-error" role="alert">{error}</p> : null}
  </section>;
}
