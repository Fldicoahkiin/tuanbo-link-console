import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { detailSchema, pageSchema, permissions, sessionSchema, type ConsoleAction, type ConsoleResult, type ConsoleRow } from '../src/console-contract';
import { api, errorMessage, messageSchema, onSessionExpired } from './api';
import { notify } from './components/toaster';
import { defaultFilter, detailRoutes, emptyFilter, readLocation, writeLocation, type Filter } from './location';
import { navigation, visibleNavigation } from './navigation';
import { ActionDialog } from './action-dialog';
import { StepUpBadge, StepUpDialog } from './step-up';
import { ServerClock } from './table';
import { cn } from './lib/utils';
import { AppShell } from './shell/app-shell';
import { OverviewPage } from './pages/overview';
import { RecordDetail } from './pages/record-detail';
import { RecordList } from './pages/record-list';
import { SecurityPage } from './pages/security';
import { UpdatesPage } from './pages/updates';
import { DetailSkeleton, LoadError, OverviewSkeleton } from './pages/page-state';

export type Session = z.infer<typeof sessionSchema>;
export type Page = z.infer<typeof pageSchema>;
export type Detail = z.infer<typeof detailSchema>;
export type ActionName = ConsoleAction['action'];
export type DialogState = { action: ActionName; row: ConsoleRow | null };

/** 后台的状态和取数：当前视图、网址同步、读取、权限。界面交给 ConsoleView。 */
export function useConsoleState(initial: Session, signedOut: () => void) {
  const [start] = useState(() => readLocation(window.location.hash));
  const [session, setSession] = useState(initial);
  const [route, setRoute] = useState(start.route);
  const [clockOffset, setClockOffset] = useState(() => initial.now - Date.now());
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const applySession = useCallback((value: Session) => { setSession(value); setClockOffset(value.now - Date.now()); }, []);
  const reloadSession = () => { api('session', sessionSchema).then(applySession, (cause: unknown) => setError(errorMessage(cause))); };
  const [filters, setFilters] = useState<Record<string, Filter>>({ [start.route]: start.filter });
  const filter = useMemo(() => filters[route] ?? defaultFilter(route), [filters, route]);
  const [page, setPage] = useState(start.page);
  const [data, setData] = useState<Page | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<ConsoleRow | null>(start.id ? { id: start.id } : null);
  const [overview, setOverview] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const sequence = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const query = new URLSearchParams({ ...filter, page: String(page) }).toString();
  const resource = route === 'exceptions' ? 'orders' : route;
  // 读取只看选中的编号：人员详情读完列表后换成同一个人的新一行，编号不变就不会再读一次。
  const selectedKey = selected ? String(selected.id) : null;
  // 登录过期由 api() 统一通知：提示一次并回到登录页（同时失败的几个请求只提示一次）。
  const expired = useRef(false);
  useEffect(() => onSessionExpired(() => {
    if (expired.current) return;
    expired.current = true;
    notify.error('登录已过期', '请重新登录。');
    signedOut();
  }), [signedOut]);
  const load = useCallback(async () => {
    const revision = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      if (route === 'security') {
        const value = await api('session', sessionSchema);
        if (sequence.current === revision) applySession(value);
      } else if (route === 'updates') {
        const value = await api('updates', detailSchema);
        if (sequence.current === revision) setDetail(value);
      } else if (selectedKey !== null && ['orders', 'licenses', 'tickets', 'feedback'].includes(resource)) {
        const value = await api(`${resource}/${selectedKey}`, detailSchema);
        if (sequence.current === revision) setDetail(value);
      } else if (route === 'overview') {
        const value = await api('overview', detailSchema);
        if (sequence.current === revision) setOverview(value);
      } else {
        const value = await api(`${route}?${query}`, pageSchema);
        if (sequence.current === revision) {
          setData(value);
          // 人员没有单独的详情接口，详情用列表里的那一行：换成新读到的同一个人；这个人不在了就回到列表。
          if (route === 'users' && selectedKey !== null) setSelected(value.items.find(row => String(row.id) === selectedKey) ?? null);
        }
      }
    } catch (cause) {
      if (sequence.current === revision) setError(errorMessage(cause));
    } finally {
      if (sequence.current === revision) setBusy(false);
    }
  }, [route, selectedKey, resource, query, applySession]);
  useEffect(() => {
    const tracker = sequence;
    void load();
    return () => { tracker.current++; };
  }, [load, refresh]);
  // 页面和详情的切换写入历史（可后退），筛选和页码只替换当前地址。
  const selectedId = selected && detailRoutes.has(route) ? String(selected.id) : null;
  const place = useRef(`${start.route}/${start.id ?? ''}`);
  const written = useRef(window.location.hash);
  useEffect(() => {
    const hash = writeLocation({ route, id: selectedId, filter, page });
    const next = `${route}/${selectedId ?? ''}`;
    if (hash === window.location.hash) return;
    written.current = hash;
    if (next !== place.current) {
      place.current = next;
      window.location.hash = hash;
    } else window.history.replaceState(null, '', hash);
  }, [route, selectedId, filter, page]);
  useEffect(() => {
    const restore = () => {
      if (window.location.hash === written.current) return;
      const next = readLocation(window.location.hash);
      written.current = window.location.hash;
      place.current = `${next.route}/${next.id ?? ''}`;
      setRoute(next.route);
      setFilters(previous => ({ ...previous, [next.route]: next.filter }));
      setPage(next.page);
      setSelected(next.id ? { id: next.id } : null);
      setDetail(null);
      setData(null);
      setRefresh(value => value + 1);
    };
    window.addEventListener('hashchange', restore);
    return () => window.removeEventListener('hashchange', restore);
  }, []);
  function navigate(key: string, preset?: Partial<Filter>) {
    // 同页再次点击也要重新加载：清空数据后靠 refresh 触发 load。
    setRoute(key);
    setSelected(null);
    setDetail(null);
    setData(null);
    setOverview(null);
    setError('');
    setPage(1);
    setRefresh(value => value + 1);
    if (preset) setFilters(previous => ({ ...previous, [key]: { ...emptyFilter, ...preset } }));
  }
  // 只签发一份时直接打开这张授权；签发多份特殊授权时打开订单看全部授权。其余操作只刷新当前页。
  const afterAction = useCallback((result?: ConsoleResult, action?: ActionName) => {
    if (result?.licenseId) {
      setRoute('licenses');
      setSelected({ id: result.licenseId });
      setDetail(null);
    } else if (action === 'grant' && result?.id) {
      setRoute('orders');
      setSelected({ id: result.id });
      setDetail(null);
    }
    setRefresh(value => value + 1);
  }, []);
  const can = (action: ActionName) => permissions[action].includes(session.user.role);
  const open = (action: ActionName, row: ConsoleRow | null = null) => setDialog({ action, row });
  async function logout() {
    setBusy(true);
    try {
      await api('logout', messageSchema, {}, session.csrf);
      signedOut();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  // 表单里没有的筛选项（如授权页签的状态）沿用当前值；下拉选了立刻生效，用 override 带上刚选的值。
  function applyForm(form: HTMLFormElement, override: Partial<Filter> = {}) {
    const value = new FormData(form);
    const field = (name: keyof Filter) => {
      const entry = value.get(name);
      return typeof entry === 'string' ? entry : value.has(name) ? '' : filter[name];
    };
    const next = { q: field('q'), state: field('state'), channel: field('channel'), from: field('from'), to: field('to'), ...override };
    setFilters(previous => ({ ...previous, [route]: next }));
    setPage(1);
    setRefresh(value => value + 1);
  }
  // 授权生命周期页签：只换状态，其余筛选不动。
  function setLifecycle(state: string) {
    setFilters(previous => ({ ...previous, licenses: { ...filter, state } }));
    setPage(1);
  }
  // 详情里点关联记录、操作日志点对象：换到对应页面的详情。
  function openRecord(nextRoute: string, row: ConsoleRow) {
    setRoute(nextRoute);
    setSelected(row);
    setDetail(null);
  }
  function back() {
    setSelected(null);
    setDetail(null);
  }
  const title = navigation.find(item => item.key === route)?.title ?? '运营后台';
  return {
    session, route, title, filter, query, page, setPage, data, detail, selected, overview, busy, error, dialog, setDialog, clockOffset,
    stepUpOpen, setStepUpOpen, reloadSession, resource, navigate, afterAction, can, open, logout, applyForm, setLifecycle, openRecord, back,
    reload: () => setRefresh(value => value + 1)
  };
}
export type ConsoleState = ReturnType<typeof useConsoleState>;
/** 后台：状态和取数在 useConsoleState，这里只按当前视图挑页面交给外壳。 */
export function ConsoleApp({ initial, signedOut }: { initial: Session; signedOut: () => void }) {
  const state = useConsoleState(initial, signedOut);
  const { session, route, title, detail, selected, overview, data, busy, error, dialog, clockOffset, can, open } = state;
  // 这个视图已经有内容时，重新读取只把内容调淡；还没有内容时显示骨架。
  const hasContent = route === 'overview' ? overview !== null : route === 'security' ? true : route === 'updates' ? detail !== null
    : selected ? route === 'users' || detail !== null : data !== null;
  let content: ReactNode = null;
  if (error && !hasContent) content = null;
  else if (route === 'overview') content = overview ? <OverviewPage overview={overview} can={can} open={open} navigate={state.navigate} /> : <OverviewSkeleton />;
  else if (route === 'security') content = <SecurityPage session={session} reloadSession={state.reloadSession} />;
  else if (route === 'updates') content = detail ? <UpdatesPage detail={detail} can={can} open={open} /> : <DetailSkeleton />;
  else if (selected) {
    content = <RecordDetail route={route} resource={state.resource} selected={selected} detail={detail} can={can} open={open} back={state.back} openRecord={state.openRecord} />;
  } else {
    content = <RecordList route={route} data={data} filter={state.filter} query={state.query} page={state.page} busy={busy} role={session.user.role}
      setPage={state.setPage} can={can} open={open} applyForm={state.applyForm} setLifecycle={state.setLifecycle} openRecord={state.openRecord} />;
  }
  const stepUp = <StepUpBadge verifiedAt={session.verifiedAt} clockOffset={clockOffset} onVerify={() => state.setStepUpOpen(true)} />;
  return <ServerClock.Provider value={clockOffset}>
    <AppShell items={visibleNavigation(session.user.role)} route={route} title={title} username={session.user.username} role={session.user.role} busy={busy}
      navigate={state.navigate} logout={() => { void state.logout(); }} reload={state.reload} stepUp={stepUp}>
      <p role="status" className="sr-only">{busy ? '正在读取…' : ''}</p>
      <div className="flex flex-col gap-6">
        {error && <LoadError message={error} retry={state.reload} />}
        <div aria-busy={busy || undefined} className={cn('min-w-0', busy && hasContent && 'opacity-60')}>{content}</div>
      </div>
    </AppShell>
    {state.stepUpOpen && <StepUpDialog csrf={session.csrf} close={() => state.setStepUpOpen(false)} onVerified={() => { state.setStepUpOpen(false); state.reloadSession(); }} />}
    {dialog && <ActionDialog key={`${dialog.action}:${String(dialog.row?.id ?? '')}`} action={dialog.action} row={dialog.row} csrf={session.csrf} verifiedAt={session.verifiedAt}
      clockOffset={clockOffset} syncSession={state.reloadSession} close={() => state.setDialog(null)} changed={state.afterAction} />}
  </ServerClock.Provider>;
}
