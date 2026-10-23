import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, ClipboardList, KeyRound, CircleAlert, MessagesSquare, Receipt, History, Users, ShieldCheck, LogOut, RefreshCw, ArrowLeft, ChevronLeft, ChevronRight, Download, Command, ArrowUpRight, ShieldAlert, CloudUpload } from 'lucide-react';
import { z } from 'zod';
import { detailSchema, pageSchema, permissions, sessionSchema, type ConsoleAction, type ConsoleResult, type ConsoleRow } from '../src/console-contract';
import { api, ApiError, errorMessage, messageSchema } from './api';
import { RevenueTrend } from './revenue-trend';
import { AuthView } from './auth-view';
import { ActionDialog } from './action-dialog';
import { actionNames, beijingTime, destructiveActions, display, forms, roleNames } from './forms';
import { DataTable, Fields, ServerClock, detailRow } from './table';
import { StepUpBadge, StepUpDialog, StepUpPrompt } from './step-up';
import { defaultFilter, detailRoutes, emptyFilter, readLocation, writeLocation, type Filter } from './location';

type Session = z.infer<typeof sessionSchema>;
type Page = z.infer<typeof pageSchema>;
type Detail = z.infer<typeof detailSchema>;
const navigation = [
  { key: 'overview', title: '工作台', icon: LayoutDashboard }, { key: 'orders', title: '订单中心', icon: ClipboardList },
  { key: 'licenses', title: '激活码与设备', icon: KeyRound }, { key: 'exceptions', title: '交付异常', icon: CircleAlert },
  { key: 'tickets', title: '售后工单', icon: MessagesSquare }, { key: 'finance', title: '财务记录', icon: Receipt },
  { key: 'audit', title: '操作日志', icon: History }, { key: 'users', title: '人员管理', icon: Users }, { key: 'updates', title: '软件更新', icon: CloudUpload }, { key: 'security', title: '安全设置', icon: ShieldCheck }
];
const columns: Record<string, string[]> = { orders: ['reference', 'customer', 'channel', 'amountFen', 'paymentStatus', 'state', 'created'], exceptions: ['reference', 'customer', 'channel', 'amountFen', 'state', 'deliveryError', 'channelRefundFen', 'reviewedRefundFen'], licenses: ['customer', 'status', 'source', 'useUntil', 'machineCode'], tickets: ['orderReference', 'category', 'state', 'note', 'created'], finance: ['orderId', 'category', 'amountFen', 'reference', 'state', 'created'], audit: ['at', 'operator', 'action', 'targetLabel', 'result', 'reason'], users: ['username', 'role', 'status'] };
const stateFilters: Record<string, { label: string; options: [string, string][] }> = {
  orders: { label: '状态', options: [['pending', '待付款'], ['paid', '已收款待交付'], ['fulfilled', '已交付'], ['refunded', '已全额退款'], ['closed', '已关闭'], ['expired', '已过期']] },
  tickets: { label: '状态', options: [['active', '未关闭'], ['open', '待处理'], ['processing', '处理中'], ['closed', '已关闭']] },
  finance: { label: '类别', options: [['refund', '退款'], ['invoice', '开票']] },
  audit: { label: '操作', options: Object.entries(actionNames) }
};
// 授权生命周期页签，状态定义与服务端 licenseRows 一致；计数来自列表 summary。
const lifecycle: [string, string][] = [['', '全部'], ['active', '生效中'], ['unbound', '未激活'], ['expiring', '即将到期'], ['expired', '已过期'], ['revoked', '已撤销']];
function ConsoleApp({ initial, signedOut }: { initial: Session; signedOut: () => void }) {
  const [start] = useState(() => readLocation(window.location.hash));
  const [session, setSession] = useState(initial); const [route, setRoute] = useState(start.route);
  const [clockOffset, setClockOffset] = useState(() => initial.now - Date.now()); const [stepUpOpen, setStepUpOpen] = useState(false);
  const applySession = useCallback((value: Session) => { setSession(value); setClockOffset(value.now - Date.now()); }, []);
  const reloadSession = () => { api('session', sessionSchema).then(applySession, (cause: unknown) => setError(errorMessage(cause))); };
  const [filters, setFilters] = useState<Record<string, Filter>>({ [start.route]: start.filter });
  const filter = useMemo(() => filters[route] ?? defaultFilter(route), [filters, route]);
  const [page, setPage] = useState(start.page); const [data, setData] = useState<Page | null>(null); const [detail, setDetail] = useState<Detail | null>(null); const [selected, setSelected] = useState<ConsoleRow | null>(start.id ? { id: start.id } : null);
  const [overview, setOverview] = useState<Detail | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ action: ConsoleAction['action']; row: ConsoleRow | null } | null>(null);
  const sequence = useRef(0); const [refresh, setRefresh] = useState(0);
  const query = new URLSearchParams({ ...filter, page: String(page) }).toString();
  const resource = route === 'exceptions' ? 'orders' : route;
  const load = useCallback(async () => {
    const revision = ++sequence.current; setBusy(true); setError('');
    try {
      if (route === 'security') { const value = await api('session', sessionSchema); if (sequence.current === revision) applySession(value); }
      else if (route === 'updates') { const value = await api('updates', detailSchema); if (sequence.current === revision) setDetail(value); }
      else if (selected && ['orders', 'licenses', 'tickets'].includes(resource)) { const value = await api(`${resource}/${String(selected.id)}`, detailSchema); if (sequence.current === revision) setDetail(value); }
      else if (route === 'overview') { const value = await api('overview', detailSchema); if (sequence.current === revision) setOverview(value); }
      else { const value = await api(`${route}?${query}`, pageSchema); if (sequence.current === revision) setData(value); }
    } catch (error) { if (sequence.current === revision) { setError(errorMessage(error)); if (error instanceof ApiError && error.code === 'SESSION_EXPIRED') signedOut(); } }
    finally { if (sequence.current === revision) setBusy(false); }
  }, [route, selected, resource, query, signedOut, applySession]);
  useEffect(() => { const tracker = sequence; void load(); return () => { tracker.current++; }; }, [load, refresh]);
  // 页面和详情的切换写入历史（可后退），筛选和页码只替换当前地址。
  const selectedId = selected && detailRoutes.has(route) ? String(selected.id) : null;
  const place = useRef(`${start.route}/${start.id ?? ''}`); const written = useRef(window.location.hash);
  useEffect(() => {
    const hash = writeLocation({ route, id: selectedId, filter, page }); const next = `${route}/${selectedId ?? ''}`;
    if (hash === window.location.hash) return;
    written.current = hash;
    if (next !== place.current) { place.current = next; window.location.hash = hash; } else window.history.replaceState(null, '', hash);
  }, [route, selectedId, filter, page]);
  useEffect(() => {
    const restore = () => {
      if (window.location.hash === written.current) return;
      const next = readLocation(window.location.hash); written.current = window.location.hash; place.current = `${next.route}/${next.id ?? ''}`;
      setRoute(next.route); setFilters(previous => ({ ...previous, [next.route]: next.filter })); setPage(next.page); setSelected(next.id ? { id: next.id } : null); setDetail(null); setData(null); setRefresh(value => value + 1);
    };
    window.addEventListener('hashchange', restore); return () => window.removeEventListener('hashchange', restore);
  }, []);
  function navigate(key: string, preset?: Partial<Filter>) {
    // 同页再次点击也要重新加载：清空数据后靠 refresh 触发 load。
    setRoute(key); setSelected(null); setDetail(null); setData(null); setOverview(null); setError(''); setPage(1); setRefresh(value => value + 1);
    if (preset) setFilters(previous => ({ ...previous, [key]: { ...emptyFilter, ...preset } }));
  }
  // 只签发一份时直接打开这张授权；签发多份特殊授权时打开订单看全部授权。其余操作只刷新当前页。
  const afterAction = useCallback((result?: ConsoleResult, action?: ConsoleAction['action']) => {
    if (result?.licenseId) { setRoute('licenses'); setSelected({ id: result.licenseId }); setDetail(null); }
    else if (action === 'grant' && result?.id) { setRoute('orders'); setSelected({ id: result.id }); setDetail(null); }
    setRefresh(value => value + 1);
  }, []);
  const can = (action: ConsoleAction['action']) => permissions[action].includes(session.user.role);
  const open = (action: ConsoleAction['action'], row: ConsoleRow | null = null) => setDialog({ action, row });
  const actionButton = (action: ConsoleAction['action'], row: ConsoleRow | null = null) => can(action) ? <button className={destructiveActions.has(action) ? 'danger-button' : ['set-expiry', 'create-order', 'grant', 'create-user'].includes(action) ? 'primary' : undefined} key={action} onClick={() => open(action, row)}>{forms[action].title}</button> : null;
  async function logout() { setBusy(true); try { await api('logout', messageSchema, {}, session.csrf); signedOut(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }
  // 表单里没有的筛选项（如授权页签的状态）沿用当前值。
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const value = new FormData(event.currentTarget); const field = (name: keyof Filter) => { const entry = value.get(name); return typeof entry === 'string' ? entry : value.has(name) ? '' : filter[name]; }; setFilters(previous => ({ ...previous, [route]: { q: field('q'), state: field('state'), channel: field('channel'), from: field('from'), to: field('to') } })); setPage(1); setRefresh(value => value + 1); }
  const title = navigation.find(item => item.key === route)?.title ?? '运营后台';
  const visibleNav = navigation.filter(item => !['users', 'audit', 'updates'].includes(item.key) || session.user.role === 'owner').filter(item => item.key !== 'finance' || ['owner', 'finance'].includes(session.user.role));
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('overview'); }}><span className="brand-icon"><Command size={21} /></span><span>团播联动台<small>运营管理工作台</small></span></a><nav aria-label="后台导航">{[{ label: '业务空间', keys: ['overview', 'orders', 'licenses', 'exceptions', 'tickets', 'finance'] }, { label: '管理', keys: ['audit', 'users', 'updates', 'security'] }].map(group => <div className="nav-group" key={group.label}><p className="nav-label">{group.label}</p>{visibleNav.filter(item => group.keys.includes(item.key)).map(item => <button key={item.key} aria-current={route === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><item.icon size={17} />{item.title}</button>)}</div>)}</nav><div className="account"><div className="avatar">{session.user.username.slice(0, 1).toUpperCase()}</div><span>{session.user.username}<small>{roleNames[session.user.role]}</small></span><button aria-label="退出登录" disabled={busy} onClick={() => { void logout(); }}><LogOut size={18} /></button></div></aside>
    <ServerClock.Provider value={clockOffset}><main className="workspace" aria-label={title}><h1 className="visually-hidden">{title}</h1><div className="workspace-tools"><StepUpBadge verifiedAt={session.verifiedAt} clockOffset={clockOffset} onVerify={() => setStepUpOpen(true)} /><button aria-label="刷新当前页面" title="刷新当前页面" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /><span>刷新</span></button></div>
      {error && <div role="alert" className="alert">{error}</div>}
      {busy && <p role="status" className="muted">正在读取…</p>}
      {route === 'overview' && overview && <>
        <div className="audience-summary"><div><span>累计客户</span><strong>{overview.item.customerCount ?? 0}<small>位</small></strong></div><div><span>已绑定授权</span><strong>{overview.item.boundLicenseCount ?? 0}<small>份</small></strong></div></div>
        {/* 金额仅返回给管理员和财务，其他角色的概览不含这些字段。 */}
        {overview.item.netFen !== undefined && <><section className="balance-summary" aria-label="收款概览"><div className="balance-primary"><p>累计净收款</p><strong>{display('netFen', overview.item.netFen ?? 0)}</strong><small>已扣除退款</small></div><Fields row={Object.fromEntries(['onlineFen', 'manualFen', 'refundFen'].map(key => [key, overview.item[key] ?? 0]))} /></section>
        <RevenueTrend rows={overview.related.filter(row => row.category === 'cashflow')} /></>}<div className="desk-columns"><section className="task-list"><div className="section-title"><h2>待办事项</h2></div>{[
          { key: 'pendingOrders', route: 'orders', title: '待付款与核款', preset: { state: 'pending' } },
          { key: 'deliveryPending', route: 'exceptions', title: '待完成交付', preset: {} },
          { key: 'refundReview', route: 'exceptions', title: '渠道退款待处理', hint: '决定撤销或保留授权', preset: {} },
          { key: 'openTickets', route: 'tickets', title: '待处理售后', preset: { state: 'active' } },
          { key: 'expiring', route: 'licenses', title: '七日内到期', preset: { state: 'expiring' } }
        ].map(task => <button className="task-row" key={task.key} onClick={() => navigate(task.route, task.preset)}><span><strong>{task.title}</strong>{task.hint && <small>{task.hint}</small>}</span><span className={Number(overview.item[task.key]) > 0 ? 'task-count has-items' : 'task-count'}>{overview.item[task.key] ?? 0}</span><ChevronRight size={16} /></button>)}</section>
        <section className="desk-shortcuts"><h2>开始处理</h2>{can('create-order') && <button onClick={() => open('create-order')}>创建线下订单<ArrowUpRight size={15} /></button>}{can('grant') && <button onClick={() => open('grant')}>签发内测 / 赠送授权<ArrowUpRight size={15} /></button>}<button onClick={() => navigate('licenses')}>管理激活码与期限<ArrowUpRight size={15} /></button></section></div>
        <details className="maintenance"><summary><span><ShieldCheck size={16} />运行与维护</span><span>服务{String(overview.item.service ?? '状态未知')} · 查看记录</span></summary><Fields row={Object.fromEntries(['service', 'backup', 'recovery'].map(key => [key, overview.item[key] ?? null]))} />{overview.related.some(row => row.category !== 'cashflow') && <DataTable rows={overview.related.filter(row => row.category !== 'cashflow')} fields={['name', 'state', 'checkedAt', 'detail']} />}</details>
      </>}
      {route === 'security' && <section className="panel security"><h2>二次验证</h2><StepUpPrompt key={session.verifiedAt} csrf={session.csrf} title="立即验证" hint="每枚验证码只能用一次；验证后 5 分钟内的敏感操作无需再输。" onVerified={reloadSession} /><p>最近验证：{beijingTime(session.verifiedAt)}</p><p className="muted">修改密码或更换验证器：由另一名管理员执行“重置人员认证”后重新开通。</p></section>}
      {route === 'updates' && detail && <>
        <section className="panel"><h2>更新源</h2><Fields row={detail.item} /><div className="actions">{detail.item.rollbackVersion && !detail.item.rollbackIssue && actionButton('rollback-update', { id: detail.item.rollbackVersion })}</div></section>
        <section className="panel"><h2>待发布版本</h2>{detail.related.length ? detail.related.map(row => <div key={String(row.id)}><Fields row={row} /><div className="actions">{!row.issue && actionButton('publish-update', row)}{actionButton('discard-update', row)}</div></div>)
          : <p className="muted">没有待发布的版本。构建机打好并签名的正式包上传后会出现在这里。</p>}</section>
      </>}
      {!['overview', 'security', 'updates'].includes(route) && <>
        {selected ? <><button className="back" onClick={() => { setSelected(null); setDetail(null); }}><ArrowLeft size={16} />返回列表</button>
          {route === 'users' ? <section className="panel"><h2>人员详情</h2><Fields row={detailRow(selected)} /><div className="actions">{actionButton('update-user', selected)}{actionButton('reset-user', selected)}</div></section> : detail && <>
            <section className="panel"><h2>{resource === 'licenses' ? '授权详情' : resource === 'tickets' ? '工单详情' : '订单详情'}</h2><Fields row={detailRow(detail.item)} /><div className="actions">
              {resource === 'orders' && <>{detail.item.state === 'pending' && detail.item.channel === 'manual' && actionButton('fulfill', detail.item)}{detail.item.state === 'pending' && detail.item.paymentStatus === 'pending' && ['manual', 'alipay'].includes(String(detail.item.channel)) && actionButton('payment-link', detail.item)}{detail.item.state === 'pending' && detail.item.paymentStatus === 'pending' && detail.item.channel === 'manual' && actionButton('close-order', detail.item)}{['alipay', 'wechat'].includes(String(detail.item.channel)) && actionButton('reconcile', detail.item)}{detail.item.paymentStatus === 'confirmed' && ['pending', 'paid'].includes(String(detail.item.state)) && actionButton('retry-delivery', detail.item)}{actionButton('delivery-access', detail.item)}{actionButton('revoke-delivery-access', detail.item)}{actionButton('create-ticket', detail.item)}{detail.item.paymentStatus === 'confirmed' && actionButton('refund', detail.item)}{detail.item.channel === 'alipay' && detail.item.paymentStatus === 'confirmed' && detail.item.state !== 'refunded' && actionButton('alipay-refund', detail.item)}{Number(detail.item.channelRefundFen) > Number(detail.item.reviewedRefundFen) && actionButton('refund-review', detail.item)}{actionButton('invoice', detail.item)}</>}
              {resource === 'licenses' && <>{actionButton('reveal', detail.item)}{detail.item.status !== 'revoked' && actionButton('set-expiry', detail.item)}{detail.item.status !== 'revoked' && actionButton('revoke', detail.item)}{detail.item.status === 'revoked' && actionButton('migrate', detail.item)}</>}
              {resource === 'tickets' && detail.item.state !== 'closed' && actionButton('update-ticket', detail.item)}
            </div></section>
            {detail.timeline && detail.timeline.length > 0 && <section className="panel"><h2>生命周期</h2><ol className="timeline">{detail.timeline.map((node, index) => <li key={index} className={node.inferred ? 'inferred' : undefined}><time>{beijingTime(String(node.at))}</time><strong>{String(node.event)}</strong>{node.detail !== null && node.detail !== undefined && <span>{String(node.detail)}</span>}{node.operator !== null && node.operator !== undefined && <small>{String(node.operator)}</small>}</li>)}</ol></section>}
            {detail.related.length > 0 && <section className="panel"><h2>{resource === 'orders' ? '关联授权' : resource === 'licenses' ? '续费记录' : '关联订单'}</h2><DataTable rows={detail.related} fields={resource === 'orders' ? ['customer', 'status', 'useUntil', 'machineCode'] : resource === 'licenses' ? ['id', 'useUntil', 'updatesUntil'] : ['reference', 'customer', 'state']} select={row => { setRoute(resource === 'orders' ? 'licenses' : 'orders'); setSelected(row); setDetail(null); }} /></section>}
            {detail.history.length > 0 && <section className="panel"><h2>操作记录</h2><DataTable rows={detail.history} fields={['at', 'operator', 'action', 'reason', 'result']} /></section>}
          </>}
        </> : <><div className="actions">{route === 'orders' && actionButton('create-order')}{route === 'licenses' && actionButton('grant')}{route === 'users' && actionButton('create-user')}{['orders', 'finance'].includes(route) && ['owner', 'finance'].includes(session.user.role) && <a className="button" href={`/console-api/export${route === 'finance' ? '/finance' : ''}?${query}`} download><Download size={16} />导出筛选结果</a>}</div>
          {route === 'licenses' && <div className="segmented" role="tablist" aria-label="授权生命周期">{lifecycle.map(([value, label]) => <button key={value || 'all'} role="tab" aria-selected={filter.state === value} onClick={() => { setFilters(previous => ({ ...previous, licenses: { ...filter, state: value } })); setPage(1); }}>{label}<span className="count">{data?.summary ? String(data.summary[value || 'all'] ?? 0) : ''}</span></button>)}</div>}
          {route !== 'users' && <form className="filters" key={route} onSubmit={search}><label>搜索<input name="q" defaultValue={filter.q} placeholder={route === 'audit' ? '对象、操作人或原因' : '编号、客户或相关记录'} /></label>{stateFilters[route] && <label>{stateFilters[route].label}<select name="state" defaultValue={filter.state}><option value="">全部</option>{stateFilters[route].options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}{['orders', 'exceptions'].includes(route) && <label>来源<select name="channel" defaultValue={filter.channel}><option value="">全部</option>{['manual', 'alipay', 'wechat', 'test', 'gift'].map(value => <option key={value} value={value}>{display('channel', value)}</option>)}</select></label>}{['orders', 'exceptions', 'finance'].includes(route) && <><label>{route === 'finance' ? '起日' : '创建起日'}<input type="date" name="from" defaultValue={filter.from} /></label><label>{route === 'finance' ? '止日' : '创建止日'}<input type="date" name="to" defaultValue={filter.to} /></label></>}<button type="submit" disabled={busy}>查询</button></form>}
          {route === 'users' && data && can('create-user') && data.items.filter(user => user.role === 'owner' && user.status === 'enabled').length < 2 && <div className="callout" role="note"><ShieldAlert size={20} aria-hidden="true" /><div><strong>只有 1 名可用的管理员</strong><p>验证器丢失或忘记密码时将无法登录后台，只能上服务器手工处理。再开通一名管理员备用，平时不用。</p></div><button className="primary" onClick={() => open('create-user', { role: 'owner', reason: '备用管理员' })}>开通第二名管理员</button></div>}
          {route === 'exceptions' && <p className="muted">已收款未交付，或渠道退款后待决定授权去留的订单。</p>}
          {route === 'finance' && data?.summary && <p className="finance-summary">退款合计 <strong>{display('refundFen', data.summary.refundFen ?? 0)}</strong>（{String(data.summary.refundCount ?? 0)} 笔）· 开票记录 {String(data.summary.invoiceCount ?? 0)} 条</p>}
          {data && data.items.length ? <DataTable rows={data.items} fields={columns[route] ?? []} {...(['orders', 'licenses', 'tickets', 'exceptions', 'users'].includes(route) ? { select: (row: ConsoleRow) => { setSelected(row); setDetail(null); } } : route === 'audit' ? { select: (row: ConsoleRow) => { setRoute(String(row.targetType)); setSelected({ id: row.target ?? null }); setDetail(null); }, canSelect: (row: ConsoleRow) => row.targetType !== null } : {})} /> : !busy && <div className="empty"><ClipboardList size={32} /><h2>暂无记录</h2></div>}
          {data && route !== 'users' && <div className="pagination"><button aria-label="上一页" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page} 页</span><button disabled={!data.hasMore || busy} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16} /></button></div>}
        </>}
      </>}
    </main></ServerClock.Provider>
    {stepUpOpen && <StepUpDialog csrf={session.csrf} close={() => setStepUpOpen(false)} onVerified={() => { setStepUpOpen(false); reloadSession(); }} />}
    {dialog && <ActionDialog key={`${dialog.action}:${String(dialog.row?.id ?? '')}`} action={dialog.action} row={dialog.row} csrf={session.csrf} verifiedAt={session.verifiedAt} clockOffset={clockOffset} syncSession={reloadSession} close={() => setDialog(null)} changed={afterAction} />}
  </div>;
}
function App() {
  const [session, setSession] = useState<Session | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const signedOut = useCallback(() => setSession(null), []);
  useEffect(() => { let live = true; void api('session', sessionSchema).then(value => { if (live) setSession(value); }, error => { if (live && !(error instanceof ApiError && error.code === 'SESSION_EXPIRED')) setError(errorMessage(error)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  if (loading) return <main className="auth-shell"><p role="status">正在检查登录状态…</p></main>;
  return session ? <ConsoleApp initial={session} signedOut={signedOut} /> : <>{error && <p className="alert" role="alert">{error}</p>}<AuthView onLogin={value => { setSession(value); setError(''); }} /></>;
}
const root = document.getElementById('root');
if (!root) throw new Error('缺少管理界面根节点');
createRoot(root).render(<StrictMode><App /></StrictMode>);
