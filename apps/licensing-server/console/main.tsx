import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, ClipboardList, KeyRound, CircleAlert, MessagesSquare, Receipt, History, Users, ShieldCheck, LogOut, RefreshCw, ArrowLeft, ChevronLeft, ChevronRight, Download, Command, ArrowUpRight } from 'lucide-react';
import { z } from 'zod';
import { detailSchema, pageSchema, permissions, sessionSchema, type ConsoleAction, type ConsoleRow } from '../src/console-contract';
import { api, ApiError, errorMessage, messageSchema } from './api';
import { RevenueTrend } from './revenue-trend';
import { AuthView } from './auth-view';
import { ActionDialog } from './action-dialog';
import { destructiveActions, display, forms, labels, roleNames } from './forms';

type Session = z.infer<typeof sessionSchema>;
type Page = z.infer<typeof pageSchema>;
type Detail = z.infer<typeof detailSchema>;
const navigation = [
  { key: 'overview', title: '工作台', icon: LayoutDashboard }, { key: 'orders', title: '订单中心', icon: ClipboardList },
  { key: 'licenses', title: '激活码与设备', icon: KeyRound }, { key: 'exceptions', title: '交付异常', icon: CircleAlert },
  { key: 'tickets', title: '售后工单', icon: MessagesSquare }, { key: 'finance', title: '财务记录', icon: Receipt },
  { key: 'audit', title: '操作日志', icon: History }, { key: 'users', title: '人员管理', icon: Users }, { key: 'security', title: '安全设置', icon: ShieldCheck }
];
const columns: Record<string, string[]> = { orders: ['reference', 'customer', 'channel', 'amountFen', 'paymentStatus', 'state', 'created'], exceptions: ['reference', 'customer', 'channel', 'amountFen', 'state', 'deliveryError', 'channelRefundFen', 'reviewedRefundFen'], licenses: ['customer', 'id', 'source', 'bound', 'revoked', 'useUntil'], tickets: ['orderReference', 'category', 'state', 'note', 'created'], finance: ['orderId', 'category', 'amountFen', 'reference', 'state', 'created'], audit: ['at', 'operator', 'action', 'target', 'result', 'reason'], users: ['username', 'role', 'enabled', 'enrolled'] };
function DataTable({ rows, fields, select }: { rows: ConsoleRow[]; fields: string[]; select?: (row: ConsoleRow) => void }) {
  return <div className="table-wrap"><table><thead><tr>{fields.map(key => <th key={key}>{labels[key] ?? key}</th>)}{select && <th>操作</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{fields.map(key => <td key={key} data-label={labels[key] ?? key}><span className={['state', 'paymentStatus', 'revoked', 'bound'].includes(key) ? `status-badge status-${String(row[key])}` : undefined}>{display(key, row[key] ?? null)}</span></td>)}{select && <td data-label="操作"><button onClick={() => select(row)}>查看详情</button></td>}</tr>)}</tbody></table></div>;
}
function Fields({ row }: { row: ConsoleRow }) { return <dl className="details">{Object.entries(row).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{display(key, value)}</dd></div>)}</dl>; }
function ConsoleApp({ initial, signedOut }: { initial: Session; signedOut: () => void }) {
  const [session, setSession] = useState(initial); const [route, setRoute] = useState('overview');
  const [filters, setFilters] = useState<Record<string, { q: string; state: string; channel: string; from: string; to: string }>>({});
  const filter = filters[route] ?? { q: '', state: '', channel: '', from: '', to: '' };
  const [page, setPage] = useState(1); const [data, setData] = useState<Page | null>(null); const [detail, setDetail] = useState<Detail | null>(null); const [selected, setSelected] = useState<ConsoleRow | null>(null);
  const [overview, setOverview] = useState<Detail | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ action: ConsoleAction['action']; row: ConsoleRow | null } | null>(null);
  const sequence = useRef(0); const [refresh, setRefresh] = useState(0);
  const query = new URLSearchParams({ ...filter, page: String(page) }).toString();
  const resource = route === 'exceptions' ? 'orders' : route;
  const load = useCallback(async () => {
    const revision = ++sequence.current; setBusy(true); setError('');
    try {
      if (route === 'security') { const value = await api('session', sessionSchema); if (sequence.current === revision) setSession(value); }
      else if (selected && ['orders', 'licenses', 'tickets'].includes(resource)) { const value = await api(`${resource}/${String(selected.id)}`, detailSchema); if (sequence.current === revision) setDetail(value); }
      else if (route === 'overview') { const value = await api('overview', detailSchema); if (sequence.current === revision) setOverview(value); }
      else { const value = await api(`${route}?${query}`, pageSchema); if (sequence.current === revision) setData(value); }
    } catch (error) { if (sequence.current === revision) { setError(errorMessage(error)); if (error instanceof ApiError && error.code === 'SESSION_EXPIRED') signedOut(); } }
    finally { if (sequence.current === revision) setBusy(false); }
  }, [route, selected, resource, query, signedOut]);
  useEffect(() => { const tracker = sequence; void load(); return () => { tracker.current++; }; }, [load, refresh]);
  function navigate(key: string) { setRoute(key); setSelected(null); setDetail(null); setData(null); setError(''); setPage(1); }
  const can = (action: ConsoleAction['action']) => permissions[action].includes(session.user.role);
  const open = (action: ConsoleAction['action'], row: ConsoleRow | null = null) => setDialog({ action, row });
  const actionButton = (action: ConsoleAction['action'], row: ConsoleRow | null = null) => can(action) ? <button className={destructiveActions[action] ? 'danger-button' : ['set-expiry', 'create-order', 'grant', 'create-user'].includes(action) ? 'primary' : undefined} key={action} onClick={() => open(action, row)}>{forms[action].title}</button> : null;
  async function logout() { setBusy(true); try { await api('logout', messageSchema, {}, session.csrf); signedOut(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; setBusy(true); setError('');
    try { const data = new FormData(form); const result = await api('verify', messageSchema, { code: data.get('code') }, session.csrf); form.reset(); setSession(await api('session', sessionSchema)); setError(result.message); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const value = new FormData(event.currentTarget); const field = (name: string) => { const entry = value.get(name); return typeof entry === 'string' ? entry : ''; }; setFilters(previous => ({ ...previous, [route]: { q: field('q'), state: field('state'), channel: field('channel'), from: field('from'), to: field('to') } })); setPage(1); setRefresh(value => value + 1); }
  const title = navigation.find(item => item.key === route)?.title ?? '运营后台';
  const visibleNav = navigation.filter(item => !['users', 'audit'].includes(item.key) || session.user.role === 'owner').filter(item => item.key !== 'finance' || ['owner', 'finance'].includes(session.user.role));
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('overview'); }}><span className="brand-icon"><Command size={21} /></span><span>团播联动台<small>运营管理工作台</small></span></a><nav aria-label="后台导航">{[{ label: '业务空间', keys: ['overview', 'orders', 'licenses', 'exceptions', 'tickets', 'finance'] }, { label: '管理', keys: ['audit', 'users', 'security'] }].map(group => <div className="nav-group" key={group.label}><p className="nav-label">{group.label}</p>{visibleNav.filter(item => group.keys.includes(item.key)).map(item => <button key={item.key} aria-current={route === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><item.icon size={17} />{item.title}</button>)}</div>)}</nav><div className="account"><div className="avatar">{session.user.username.slice(0, 1).toUpperCase()}</div><span>{session.user.username}<small>{roleNames[session.user.role]}</small></span><button aria-label="退出登录" disabled={busy} onClick={() => { void logout(); }}><LogOut size={18} /></button></div></aside>
    <main className="workspace" aria-label={title}><h1 className="visually-hidden">{title}</h1><div className="workspace-tools"><button aria-label="刷新当前页面" title="刷新当前页面" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /><span>刷新</span></button></div>
      {error && <div role="alert" className="alert">{error}</div>}
      {busy && <p role="status" className="muted">正在读取…</p>}
      {route === 'overview' && overview && <>
        <div className="audience-summary"><div><span>累计客户</span><strong>{overview.item.customerCount ?? 0}<small>位</small></strong></div><div><span>已绑定授权</span><strong>{overview.item.boundLicenseCount ?? 0}<small>份</small></strong></div><p>客户按已交付订单的名称与类型去重，含内测与赠送；已绑定不代表在线。</p></div>
        <section className="balance-summary" aria-label="收款概览"><div className="balance-primary"><p>累计净收款 <span>人民币</span></p><strong>{display('netFen', overview.item.netFen ?? 0)}</strong><small>已扣除退款 · 不含赠送及内测</small></div><Fields row={Object.fromEntries(['onlineFen', 'manualFen', 'refundFen'].map(key => [key, overview.item[key] ?? 0]))} /></section>
        <RevenueTrend rows={overview.related.filter(row => row.category === 'cashflow')} /><div className="desk-columns"><section className="task-list"><div className="section-title"><h2>待办事项</h2><span>当前业务状态</span></div>{[
          { key: 'pendingOrders', route: 'orders', title: '待付款与核款', hint: '查看订单，核对实际到账情况' },
          { key: 'deliveryPending', route: 'exceptions', title: '待完成交付', hint: '已确认收款，尚未完成发码' },
          { key: 'refundReview', route: 'exceptions', title: '渠道退款待处理', hint: '支付宝已退款，决定撤销或保留授权' },
          { key: 'openTickets', route: 'tickets', title: '待处理售后', hint: '跟进换机、退款与客户问题' },
          { key: 'expiring', route: 'licenses', title: '七日内到期', hint: '查看授权期限，安排续费跟进' }
        ].map(task => <button className="task-row" key={task.key} onClick={() => navigate(task.route)}><span><strong>{task.title}</strong><small>{task.hint}</small></span><span className={Number(overview.item[task.key]) > 0 ? 'task-count has-items' : 'task-count'}>{overview.item[task.key] ?? 0}</span><ChevronRight size={16} /></button>)}</section>
        <section className="desk-shortcuts"><h2>开始处理</h2>{can('create-order') && <button onClick={() => open('create-order')}>创建线下订单<ArrowUpRight size={15} /></button>}{can('grant') && <button onClick={() => open('grant')}>签发内测 / 赠送授权<ArrowUpRight size={15} /></button>}<button onClick={() => navigate('licenses')}>管理激活码与期限<ArrowUpRight size={15} /></button><p>支付宝订单可在订单详情原路退款；其他退款与开票由人工办理并登记。</p></section></div>
        <details className="maintenance"><summary><span><ShieldCheck size={16} />运行与维护</span><span>服务{String(overview.item.service ?? '状态未知')} · 查看记录</span></summary><Fields row={Object.fromEntries(['service', 'backup', 'recovery'].map(key => [key, overview.item[key] ?? null]))} />{overview.related.some(row => row.category !== 'cashflow') && <DataTable rows={overview.related.filter(row => row.category !== 'cashflow')} fields={['name', 'state', 'checkedAt', 'detail']} />}</details>
      </>}
      {route === 'security' && <section className="panel security"><h2>二次验证</h2><p className="muted">发码、核款、查看完整激活码及权限变更需要最近五分钟内完成验证。验证码使用一次后，请等待下一枚。</p><form onSubmit={event => { void verify(event); }}><label>验证器验证码或恢复码<input name="code" required autoComplete="one-time-code" /></label><button className="primary" disabled={busy}>验证</button></form><p>最近验证：{new Date(session.verifiedAt).toLocaleString('zh-CN')}</p><p>空闲 30 分钟或登录满 8 小时后，需要重新登录。</p><p className="muted">修改密码或重新绑定验证器，请由另一名负责人执行“重置人员认证”，随后用新开通凭据设置。恢复码仅在开通时显示。</p></section>}
      {!['overview', 'security'].includes(route) && <>
        {selected ? <><button className="back" onClick={() => { setSelected(null); setDetail(null); }}><ArrowLeft size={16} />返回列表</button>
          {route === 'users' ? <section className="panel"><Fields row={selected} /><div className="actions">{actionButton('update-user', selected)}{actionButton('reset-user', selected)}</div></section> : detail && <>
            <section className="panel"><h2>{resource === 'licenses' ? '授权详情' : resource === 'tickets' ? '工单详情' : '订单详情'}</h2><Fields row={detail.item} /><div className="actions">
              {resource === 'orders' && <>{detail.item.state === 'pending' && detail.item.channel === 'manual' && actionButton('fulfill', detail.item)}{['alipay', 'wechat'].includes(String(detail.item.channel)) && actionButton('reconcile', detail.item)}{detail.item.paymentStatus === 'confirmed' && ['pending', 'paid'].includes(String(detail.item.state)) && actionButton('retry-delivery', detail.item)}{actionButton('delivery-access', detail.item)}{actionButton('revoke-delivery-access', detail.item)}{actionButton('create-ticket', detail.item)}{detail.item.paymentStatus === 'confirmed' && actionButton('refund', detail.item)}{detail.item.channel === 'alipay' && detail.item.paymentStatus === 'confirmed' && detail.item.state !== 'refunded' && actionButton('alipay-refund', detail.item)}{Number(detail.item.channelRefundFen) > Number(detail.item.reviewedRefundFen) && actionButton('refund-review', detail.item)}{actionButton('invoice', detail.item)}</>}
              {resource === 'licenses' && <>{actionButton('reveal', detail.item)}{!detail.item.revoked && actionButton('set-expiry', detail.item)}{!detail.item.revoked && actionButton('revoke', detail.item)}{detail.item.revoked && actionButton('migrate', detail.item)}</>}
              {resource === 'tickets' && detail.item.state !== 'closed' && actionButton('update-ticket', detail.item)}
            </div></section>
            {detail.related.length > 0 && <section className="panel"><h2>{resource === 'orders' ? '关联授权' : resource === 'licenses' ? '续费记录' : '关联订单'}</h2><DataTable rows={detail.related} fields={resource === 'orders' ? ['id', 'customer', 'bound', 'revoked', 'useUntil'] : resource === 'licenses' ? ['id', 'useUntil', 'updatesUntil'] : ['reference', 'customer', 'state']} select={row => { setRoute(resource === 'orders' ? 'licenses' : 'orders'); setSelected(row); setDetail(null); }} /></section>}
            {detail.history.length > 0 && <section className="panel"><h2>对象操作记录（最近 100 条）</h2><DataTable rows={detail.history} fields={['at', 'operator', 'action', 'reason', 'result']} /></section>}
          </>}
        </> : <><div className="actions">{route === 'orders' && actionButton('create-order')}{route === 'licenses' && actionButton('grant')}{route === 'users' && actionButton('create-user')}{route === 'orders' && ['owner', 'finance'].includes(session.user.role) && <a className="button" href={`/console-api/export?${query}`} download><Download size={16} />导出筛选结果</a>}</div>
          {route !== 'users' && <form className="filters" key={route} onSubmit={search}><label>搜索<input name="q" defaultValue={filter.q} placeholder="编号、客户或相关记录" /></label>{['orders', 'licenses', 'tickets'].includes(route) && <label>状态<select name="state" defaultValue={filter.state}><option value="">全部</option>{(route === 'orders' ? [['pending', '待付款'], ['paid', '已收款待交付'], ['fulfilled', '已交付'], ['refunded', '已全额退款'], ['closed', '已关闭'], ['expired', '已过期']] : route === 'licenses' ? [['bound', '已绑定'], ['unbound', '未绑定'], ['revoked', '已撤销']] : [['open', '待处理'], ['processing', '处理中'], ['closed', '已关闭']]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}{['orders', 'exceptions'].includes(route) && <><label>来源<select name="channel" defaultValue={filter.channel}><option value="">全部</option>{['manual', 'alipay', 'wechat', 'test', 'gift'].map(value => <option key={value} value={value}>{display('channel', value)}</option>)}</select></label><label>创建起日<input type="date" name="from" defaultValue={filter.from} /></label><label>创建止日<input type="date" name="to" defaultValue={filter.to} /></label></>}<button type="submit" disabled={busy}>查询</button></form>}
          {route === 'exceptions' && <p className="muted">这里列出已确认收款但尚未交付的订单，以及渠道退款尚未处理授权的订单（部分退款、续费订单退款、支付宝后台直接退款）。补发不要求客户重付；在订单中“处理渠道退款”撤销或保留授权后出列。</p>}
          {data && data.items.length ? <DataTable rows={data.items} fields={columns[route] ?? []} {...(['orders', 'licenses', 'tickets', 'exceptions', 'users'].includes(route) ? { select: (row: ConsoleRow) => { setSelected(row); setDetail(null); } } : {})} /> : !busy && <div className="empty"><ClipboardList size={32} /><h2>暂无符合条件的记录</h2><p>调整筛选条件，或通过上方入口创建记录。</p></div>}
          {data && route !== 'users' && <div className="pagination"><button aria-label="上一页" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page} 页 · 每页最多 50 条</span><button disabled={!data.hasMore || busy} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16} /></button></div>}
        </>}
      </>}
      <footer>每台电脑独立授权 · 支付宝订单可原路退款，开票由人工办理 · 所有写操作均记录审计</footer>
    </main>
    {dialog && <ActionDialog key={`${dialog.action}:${String(dialog.row?.id ?? '')}`} action={dialog.action} row={dialog.row} csrf={session.csrf} close={() => setDialog(null)} changed={() => setRefresh(value => value + 1)} />}
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
