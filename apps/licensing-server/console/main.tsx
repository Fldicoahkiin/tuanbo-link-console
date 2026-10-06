import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, ClipboardList, KeyRound, CircleAlert, MessagesSquare, Receipt, History, Users, ShieldCheck, LogOut, RefreshCw, ArrowLeft, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { z } from 'zod';
import { detailSchema, pageSchema, permissions, sessionSchema, type ConsoleAction, type ConsoleRow } from '../src/console-contract';
import { api, ApiError, errorMessage, messageSchema } from './api';
import { AuthView } from './auth-view';
import { ActionDialog } from './action-dialog';
import { display, forms, labels, roleNames } from './forms';

type Session = z.infer<typeof sessionSchema>;
type Page = z.infer<typeof pageSchema>;
type Detail = z.infer<typeof detailSchema>;
const navigation = [
  { key: 'overview', title: '工作台', icon: LayoutDashboard }, { key: 'orders', title: '订单中心', icon: ClipboardList },
  { key: 'licenses', title: '激活码与设备', icon: KeyRound }, { key: 'exceptions', title: '交付异常', icon: CircleAlert },
  { key: 'tickets', title: '售后工单', icon: MessagesSquare }, { key: 'finance', title: '财务记录', icon: Receipt },
  { key: 'audit', title: '操作日志', icon: History }, { key: 'users', title: '人员管理', icon: Users }, { key: 'security', title: '安全设置', icon: ShieldCheck }
];
const columns: Record<string, string[]> = { orders: ['reference', 'customer', 'channel', 'amountFen', 'paymentStatus', 'state', 'created'], exceptions: ['reference', 'customer', 'channel', 'amountFen', 'deliveryError'], licenses: ['customer', 'id', 'source', 'bound', 'revoked', 'useUntil'], tickets: ['orderReference', 'category', 'state', 'note', 'created'], finance: ['orderId', 'category', 'amountFen', 'reference', 'state', 'created'], audit: ['at', 'operator', 'action', 'target', 'result', 'reason'], users: ['username', 'role', 'enabled', 'enrolled'] };
function DataTable({ rows, fields, select }: { rows: ConsoleRow[]; fields: string[]; select?: (row: ConsoleRow) => void }) {
  return <div className="table-wrap"><table><thead><tr>{fields.map(key => <th key={key}>{labels[key] ?? key}</th>)}{select && <th>操作</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{fields.map(key => <td key={key} data-label={labels[key] ?? key}><span>{display(key, row[key] ?? null)}</span></td>)}{select && <td data-label="操作"><button onClick={() => select(row)}>查看详情</button></td>}</tr>)}</tbody></table></div>;
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
  const actionButton = (action: ConsoleAction['action'], row: ConsoleRow | null = null) => can(action) ? <button key={action} onClick={() => open(action, row)}>{forms[action].title}</button> : null;
  async function logout() { setBusy(true); try { await api('logout', messageSchema, {}, session.csrf); signedOut(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; setBusy(true); setError('');
    try { const data = new FormData(form); const result = await api('verify', messageSchema, { code: data.get('code') }, session.csrf); form.reset(); setSession(await api('session', sessionSchema)); setError(result.message); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const value = new FormData(event.currentTarget); const field = (name: string) => { const entry = value.get(name); return typeof entry === 'string' ? entry : ''; }; setFilters(previous => ({ ...previous, [route]: { q: field('q'), state: field('state'), channel: field('channel'), from: field('from'), to: field('to') } })); setPage(1); setRefresh(value => value + 1); }
  const title = navigation.find(item => item.key === route)?.title ?? '运营后台';
  const visibleNav = navigation.filter(item => !['users', 'audit'].includes(item.key) || session.user.role === 'owner').filter(item => item.key !== 'finance' || ['owner', 'finance'].includes(session.user.role));
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('overview'); }}><ShieldCheck size={23} /><span>团播联动台<small>运营管理</small></span></a><nav aria-label="后台导航">{visibleNav.map(item => <button key={item.key} aria-current={route === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><item.icon size={18} />{item.title}</button>)}</nav><div className="account"><span>{session.user.username}<small>{roleNames[session.user.role]}</small></span><button aria-label="退出登录" disabled={busy} onClick={() => { void logout(); }}><LogOut size={18} /></button></div></aside>
    <main className="workspace"><header className="page-header"><div><p className="eyebrow">团播联动台 / 运营管理</p><h1>{title}</h1></div><button disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} />刷新</button></header>
      {error && <div role="alert" className="alert">{error}</div>}
      {busy && <p role="status" className="muted">正在读取…</p>}
      {route === 'overview' && overview && <><div className="metrics">{['pendingOrders', 'deliveryPending', 'openTickets', 'expiring'].map(key => <article key={key}><span>{labels[key]}</span><strong>{overview.item[key] ?? 0}</strong></article>)}</div><section className="panel"><h2>收款与退款</h2><p className="muted">累计已确认记录，金额以人民币展示；特殊授权不计入。人工退款登记不等同渠道退款回执。</p><Fields row={Object.fromEntries(['onlineFen', 'manualFen', 'refundFen'].map(key => [key, overview.item[key] ?? 0]))} /></section><section className="panel"><h2>运行与维护</h2><Fields row={Object.fromEntries(['service', 'backup', 'recovery'].map(key => [key, overview.item[key] ?? null]))} />{overview.related.length > 0 && <DataTable rows={overview.related} fields={['name', 'state', 'checkedAt', 'detail']} />}</section></>}
      {route === 'security' && <section className="panel security"><h2>二次验证</h2><p className="muted">发码、核款、查看完整激活码及权限变更需要最近五分钟内完成验证。验证码使用一次后，请等待下一枚。</p><form onSubmit={event => { void verify(event); }}><label>验证器验证码或恢复码<input name="code" required autoComplete="one-time-code" /></label><button className="primary" disabled={busy}>验证</button></form><p>最近验证：{new Date(session.verifiedAt).toLocaleString('zh-CN')}</p><p>空闲 30 分钟或登录满 8 小时后，需要重新登录。</p><p className="muted">修改密码或重新绑定验证器，请由另一名负责人执行“重置人员认证”，随后用新开通凭据设置。恢复码仅在开通时显示。</p></section>}
      {!['overview', 'security'].includes(route) && <>
        {selected ? <><button className="back" onClick={() => { setSelected(null); setDetail(null); }}><ArrowLeft size={16} />返回列表</button>
          {route === 'users' ? <section className="panel"><Fields row={selected} /><div className="actions">{actionButton('update-user', selected)}{actionButton('reset-user', selected)}</div></section> : detail && <>
            <section className="panel"><h2>{resource === 'licenses' ? '授权详情' : resource === 'tickets' ? '工单详情' : '订单详情'}</h2><Fields row={detail.item} /><div className="actions">
              {resource === 'orders' && <>{detail.item.state === 'pending' && detail.item.channel === 'manual' && actionButton('fulfill', detail.item)}{['alipay', 'wechat'].includes(String(detail.item.channel)) && actionButton('reconcile', detail.item)}{detail.item.paymentStatus === 'confirmed' && detail.item.state !== 'fulfilled' && actionButton('retry-delivery', detail.item)}{actionButton('delivery-access', detail.item)}{actionButton('revoke-delivery-access', detail.item)}{actionButton('create-ticket', detail.item)}{detail.item.paymentStatus === 'confirmed' && actionButton('refund', detail.item)}{actionButton('invoice', detail.item)}</>}
              {resource === 'licenses' && <>{actionButton('reveal', detail.item)}{!detail.item.revoked && actionButton('revoke', detail.item)}{detail.item.revoked && actionButton('migrate', detail.item)}</>}
              {resource === 'tickets' && detail.item.state !== 'closed' && actionButton('update-ticket', detail.item)}
            </div></section>
            {detail.related.length > 0 && <section className="panel"><h2>{resource === 'orders' ? '关联授权' : resource === 'licenses' ? '续费记录' : '关联订单'}</h2><DataTable rows={detail.related} fields={resource === 'orders' ? ['id', 'customer', 'bound', 'revoked', 'useUntil'] : resource === 'licenses' ? ['id', 'useUntil', 'updatesUntil'] : ['reference', 'customer', 'state']} select={row => { setRoute(resource === 'orders' ? 'licenses' : 'orders'); setSelected(row); setDetail(null); }} /></section>}
            {detail.history.length > 0 && <section className="panel"><h2>对象操作记录（最近 100 条）</h2><DataTable rows={detail.history} fields={['at', 'operator', 'action', 'reason', 'result']} /></section>}
          </>}
        </> : <><div className="actions">{route === 'orders' && actionButton('create-order')}{route === 'licenses' && actionButton('grant')}{route === 'users' && actionButton('create-user')}{route === 'orders' && ['owner', 'finance'].includes(session.user.role) && <a className="button" href={`/console-api/export?${query}`} download><Download size={16} />导出筛选结果</a>}</div>
          {route !== 'users' && <form className="filters" key={route} onSubmit={search}><label>搜索<input name="q" defaultValue={filter.q} placeholder="编号、客户或相关记录" /></label>{['orders', 'licenses', 'tickets'].includes(route) && <label>状态<select name="state" defaultValue={filter.state}><option value="">全部</option>{(route === 'orders' ? [['pending', '待交付'], ['fulfilled', '已交付']] : route === 'licenses' ? [['bound', '已绑定'], ['unbound', '未绑定'], ['revoked', '已撤销']] : [['open', '待处理'], ['processing', '处理中'], ['closed', '已关闭']]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}{['orders', 'exceptions'].includes(route) && <><label>来源<select name="channel" defaultValue={filter.channel}><option value="">全部</option>{['manual', 'alipay', 'wechat', 'test', 'gift'].map(value => <option key={value} value={value}>{display('channel', value)}</option>)}</select></label><label>创建起日<input type="date" name="from" defaultValue={filter.from} /></label><label>创建止日<input type="date" name="to" defaultValue={filter.to} /></label></>}<button type="submit" disabled={busy}>查询</button></form>}
          {route === 'exceptions' && <p className="muted">这里仅列出已确认收款但尚未交付的订单。修复原因后可显式补发，不要求客户重付。</p>}
          {data && data.items.length ? <DataTable rows={data.items} fields={columns[route] ?? []} {...(['orders', 'licenses', 'tickets', 'exceptions', 'users'].includes(route) ? { select: (row: ConsoleRow) => { setSelected(row); setDetail(null); } } : {})} /> : !busy && <div className="empty"><ClipboardList size={32} /><h2>暂无符合条件的记录</h2><p>调整筛选条件，或通过上方入口创建记录。</p></div>}
          {data && route !== 'users' && <div className="pagination"><button aria-label="上一页" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page} 页 · 每页最多 50 条</span><button disabled={!data.hasMore || busy} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16} /></button></div>}
        </>}
      </>}
      <footer>每台电脑独立授权 · 退款与开票由人工办理 · 所有写操作均记录审计</footer>
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
