import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, ShoppingCart, KeyRound } from 'lucide-react';
import { z } from 'zod';
import { purchaseCatalogResponseSchema, purchaseReceiptSchema, purchaseRequestSchema, type LicenseClaims, type PurchaseCatalogResponse, type PurchaseReceipt } from '@tb/schema';
import { Button, Card, Field, Notice, Select, TextInput } from '../ui';

const money = (fen: number): string => `¥${(fen / 100).toFixed(2)}`;
const recordsSchema = z.array(purchaseReceiptSchema).max(100);
const ended = (record: PurchaseReceipt): boolean => record.order?.state === 'closed' || record.order?.state === 'expired';

export function PurchaseSettings({ runtimeActive, onSelectCode, license, stacked = false }: { runtimeActive: boolean; stacked?: boolean; onSelectCode: (code: string) => void; license?: LicenseClaims | null }): JSX.Element {
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
  const [renewing, setRenewing] = useState(false);
  const canRenew = license?.kind === 'subscription' && Boolean(license.online);
  const offers = catalog?.offers.filter(item => !renewing || item.kind === 'subscription') ?? [];
  const offer = offers.find(item => item.id === offerId);
  const unresolved = records.some(record => !record.rejected && record.delivery?.state !== 'fulfilled' && !ended(record));
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
    setCatalog(value); setOfferId(value.offers.find(item => !renewing || item.kind === 'subscription')?.id ?? ''); setQuantity(1);
  };
  const create = async (): Promise<void> => {
    if (!offer || !confirmed || unresolved || !ready) return;
    if (renewing && (!canRenew || !license)) throw new Error('本机订阅信息不可用，请先刷新授权状态');
    await window.tbLink.createPurchase(purchaseRequestSchema.parse({ offerId: offer.id, revision: offer.revision,
      quotedUnitAmountFen: offer.unitAmountFen, quantity: renewing ? 1 : quantity,
      customer: renewing ? license?.customer : customer, customerType: renewing ? license?.online?.customerType : customerType,
      ...(renewing ? { renewalLicenseId: license?.licenseId } : {}) }));
    setConfirmed(false); setMessage(`${renewing ? '续费' : '购买'}订单已创建，找回订单用的凭据已加密保存在这台电脑上。请在下面的订单里打开支付宝付款页。`);
  };
  return <section aria-label="购买与订单" className="settings-stack">
    <header className="settings-subsection-header"><h3>购买与订单</h3><Button variant="secondary" size="sm" icon={ShoppingCart} disabled={busy} onClick={() => void run(loadCatalog)}>查看可售授权</Button></header>
    <p className="settings-lead">不用注册账号。付款后回到这里查询并领取激活码，再选一个激活码激活这台电脑。企业订单每台电脑用一个单独的激活码。下面显示的是上次查询的结果，点“查询”可以更新付款和授权状态。</p>
    {catalog && !catalog.available ? <Notice>暂未开放购买，请联系售后。已有的订单仍然可以查询。</Notice> : null}
    {catalog?.available ? <form onSubmit={event => { event.preventDefault(); void run(create); }}>
      <fieldset className="settings-fieldset" disabled={busy || !ready || unresolved}>
        <Field stacked={stacked} label="购买方式">{props => <Select {...props} aria-label="购买方式" value={renewing ? 'renewal' : 'new'} onChange={event => {
          const renewal = event.target.value === 'renewal'; setRenewing(renewal); setConfirmed(false); setQuantity(1);
          setOfferId(catalog.offers.find(item => !renewal || item.kind === 'subscription')?.id ?? '');
        }}><option value="new">购买新授权</option><option value="renewal" disabled={!canRenew}>续费本机订阅</option></Select>}</Field>
        <Field stacked={stacked} label="授权商品">{props => <Select {...props} aria-label="授权商品" value={offerId} onChange={event => { setOfferId(event.target.value); setQuantity(1); setConfirmed(false); }}>{offers.map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.unitAmountFen)} / 台</option>)}</Select>}</Field>
        {renewing && !offers.length ? <p role="status">目前没有可以续费的订阅商品，请联系售后。</p> : null}
        <Field stacked={stacked} label="购买主体">{props => <Select {...props} aria-label="购买主体" disabled={renewing} value={renewing ? license?.online?.customerType ?? '' : customerType} onChange={event => { setCustomerType(z.enum(['personal', 'company']).parse(event.target.value)); setConfirmed(false); }}><option value="personal">个人</option><option value="company">企业</option></Select>}</Field>
        <Field stacked={stacked} label="授权客户名称">{props => <TextInput {...props} aria-label="授权客户名称" required maxLength={160} readOnly={renewing} value={renewing ? license?.customer ?? '' : customer} onChange={event => { setCustomer(event.target.value); setConfirmed(false); }} autoComplete="off" placeholder={customerType === 'company' ? '公司名称' : '显示在授权里的称呼'} />}</Field>
        <Field stacked={stacked} label="机器数量">{props => <TextInput {...props} aria-label="机器数量" type="number" required min={1} max={offer?.maxQuantity ?? 1} step={1} readOnly={renewing} value={renewing ? 1 : Number.isNaN(quantity) ? '' : quantity} onChange={event => { setQuantity(event.target.valueAsNumber); setConfirmed(false); }} />}</Field>
        {offer ? <p>含税总价 {renewing ? money(offer.unitAmountFen) : Number.isInteger(quantity) && quantity > 0 ? money(offer.unitAmountFen * quantity) : '—'}。{offer.kind === 'perpetual' ? '买断永久使用' : `使用 ${offer.useDays} 天`}，升级服务 {offer.updatesDays} 天；{renewing ? '续费会保留剩余时长；已到期的从确认收款时开始算' : '从首次确认收款并交付时开始算'}，每天按 24 小时计算。每次启动需要联网验证，换电脑需要办理迁移。</p> : null}
        {renewing ? <p>只延长这台电脑原来的订阅，激活码和绑定的电脑都不变，也不会自动扣款。付款后先查询结果，再点上面的“联网验证授权”更新本机期限。</p> : null}
        <label className="settings-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已确认价格、电脑数量和授权期限</label>
        <div className="settings-actions-row"><Button type="submit" variant="primary" icon={ShoppingCart} disabled={!offer || !confirmed || (renewing ? !canRenew : !customer.trim())}>{renewing ? '创建续费订单' : '创建购买订单'}</Button></div>
      </fieldset>
    </form> : null}
    {unresolved ? <Notice tone="warning">还有没确认结果的购买。关过付款页或遇到网络错误的话，请恢复原订单，不要重复付款。付款入口已过期又没付款的，点“查询付款并领取”，确认原订单已关闭后就可以重新购买。</Notice> : null}
    {!ready ? <div className="settings-actions-row"><Button variant="secondary" disabled={busy} onClick={() => void run(() => Promise.resolve())}>重新读取购买记录</Button></div> : null}
    {ready && records.length === 0 ? <p>本机暂无购买记录。</p> : null}
    {[...records].reverse().map(record => <PurchaseRecord key={record.localId} stacked={stacked} record={record} busy={busy} runtimeActive={runtimeActive} run={run} onMessage={setMessage} onSelectCode={onSelectCode} />)}
    {records.length ? <p className="settings-footnote">领取凭据从下单起七天内有效，已加密保存在这台电脑上。换电脑、重装系统或凭据过期时，请带上购买记录联系售后找回。查询不会自动激活或绑定电脑。</p> : null}
    {message ? <Notice tone="success">{message}</Notice> : null}
    {error ? <Notice tone="error">{error}</Notice> : null}
  </section>;
}

/** One purchase made on this computer: its state, the next step, and the codes once delivered. */
function PurchaseRecord({ record, busy, runtimeActive, run, onMessage, onSelectCode, stacked }: {
  stacked: boolean;
  record: PurchaseReceipt;
  busy: boolean;
  runtimeActive: boolean;
  run: (operation: () => Promise<void>) => Promise<void>;
  onMessage: (message: string) => void;
  onSelectCode: (code: string) => void;
}): JSX.Element {
  const state = record.rejected ? '订单没有创建成功，请重新查看商品' : ended(record) ? '原订单已关闭，未收款；可以重新购买' : record.delivery?.state === 'fulfilled' ? record.request.renewalLicenseId ? '续费已完成，请联网验证原授权' : '已付款，可领取激活码'
    : record.delivery?.paymentConfirmed ? '付款已确认，授权还在处理中，请联系售后，不需要再付款' : record.order?.state === 'fulfilled' ? '已付款，请查询并领取' : record.order ? '待付款或待确认' : '结果待确认，请恢复原订单';
  return <Card level={3} title={record.order?.offer.name ?? record.request.offerId} description={state} aria-label={`购买记录 ${record.order?.id ?? record.localId}`}>
    <p>{new Date(record.createdAt).toLocaleString('zh-CN')} · {record.request.quantity} 台 · {money(record.order?.amountFen ?? record.request.quotedUnitAmountFen * record.request.quantity)}</p>
    <Field stacked={stacked} label={record.order ? '订单编号' : '本机购买编号'}>{props => <TextInput {...props} aria-label="购买编号" value={record.order?.id ?? record.localId} readOnly onFocus={event => event.currentTarget.select()} />}</Field>
    {!record.rejected ? <div className="settings-actions-row">
      <Button variant="secondary" icon={RefreshCw} disabled={busy} onClick={() => void run(async () => { await window.tbLink.refreshPurchase(record.localId); onMessage('已查询原订单。显示“待付款”不代表支付渠道确认你没有付款。'); })}>{record.order ? '查询付款并领取' : '恢复原订单'}</Button>
      {record.order?.state === 'pending' && record.delivery?.state !== 'fulfilled' ? <Button variant="primary" icon={ExternalLink} disabled={busy || !record.order.payable} onClick={() => void run(async () => { await window.tbLink.openPurchasePayment(record.localId); onMessage('已在浏览器里打开付款页。付款完成后回到这里查询并领取。'); })}>打开支付宝付款页</Button> : null}
    </div> : null}
    {record.delivery?.state === 'fulfilled' ? <>
      <p>使用期限：{record.delivery.useUntil ? new Date(record.delivery.useUntil).toLocaleString('zh-CN') : '永久'}；升级服务截止：{new Date(record.delivery.updatesUntil).toLocaleString('zh-CN')}。</p>
      {record.request.renewalLicenseId ? <p>这笔订单用来延长原订阅，不会另发激活码。原授权已被撤销的话，请联系售后。</p> : record.delivery.licenses.map((license, index) => <div className="settings-subsection" key={license.id}>
        <Field stacked={stacked} label={`激活码 ${index + 1}`}>{props => <TextInput {...props} aria-label={`激活码 ${index + 1}`} readOnly type="password" value={license.code ?? ''} placeholder={license.revoked ? '已撤销' : ''} onFocus={event => event.currentTarget.select()} />}</Field>
        <div className="settings-actions-row">
          <Button variant="secondary" icon={KeyRound} disabled={busy || runtimeActive || !license.code} onClick={() => { if (license.code) { onSelectCode(license.code); onMessage('已填到上面的激活码栏，确认无误后点“激活本机”。'); } }}>填入本机激活栏</Button>
          <Button variant="secondary" icon={Copy} disabled={busy || !license.code} onClick={() => void run(async () => { await window.tbLink.copyPurchaseCode(record.localId, license.id); onMessage(`已复制第 ${index + 1} 个激活码。`); })}>复制激活码</Button>
        </div>
      </div>)}
    </> : null}
  </Card>;
}
