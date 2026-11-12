import { ChevronLeft, ChevronRight, Download, Inbox, Plus, ShieldAlert } from 'lucide-react';
import type { ConsoleRole, ConsoleRow } from '../../src/console-contract';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button, buttonVariants } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { display, forms } from '../forms';
import { cn } from '../lib/utils';
import type { Filter } from '../location';
import { columns, lifecycle, pageNotes } from '../navigation';
import { DataTable } from '../table';
import type { ActionName, Page } from '../console-app';
import { ListFilters } from './list-filters';
import { ListSkeleton } from './page-state';

type ListProps = {
  route: string;
  data: Page | null;
  filter: Filter;
  query: string;
  page: number;
  busy: boolean;
  role: ConsoleRole;
  setPage: (update: (value: number) => number) => void;
  can: (action: ActionName) => boolean;
  open: (action: ActionName, row?: ConsoleRow | null) => void;
  applyForm: (form: HTMLFormElement, override?: Partial<Filter>) => void;
  setLifecycle: (state: string) => void;
  openRecord: (route: string, row: ConsoleRow) => void;
};

const createActions: Record<string, ActionName> = { orders: 'create-order', licenses: 'grant', users: 'create-user' };

/** 列表页：说明、筛选和操作、生命周期页签、表格、翻页。 */
export function RecordList(props: ListProps) {
  const { route, data, filter, query, page, busy, role, setPage, can, open, applyForm, setLifecycle, openRecord } = props;
  const create = createActions[route];
  const exportable = ['orders', 'finance'].includes(route) && ['owner', 'finance'].includes(role);
  const filtered = Object.values(filter).some(Boolean);
  const select = ['orders', 'licenses', 'tickets', 'feedback', 'exceptions', 'users'].includes(route)
    ? { select: (row: ConsoleRow) => openRecord(route, row) }
    : route === 'audit'
      ? { select: (row: ConsoleRow) => openRecord(String(row.targetType), { id: row.target ?? null }), canSelect: (row: ConsoleRow) => row.targetType !== null }
      : {};
  const owners = data?.items.filter(user => user.role === 'owner' && user.status === 'enabled').length ?? 0;
  // 提醒开通第二名管理员时，提醒里的按钮是主按钮，「添加人员」退为普通按钮。
  const backupNeeded = route === 'users' && data !== null && can('create-user') && owners < 2;
  return <div className="flex flex-col gap-4">
    {pageNotes[route] && <p className="text-muted-foreground text-sm">{pageNotes[route]}</p>}
    {route === 'licenses' && <Tabs value={filter.state || 'all'} onValueChange={value => setLifecycle(value === 'all' ? '' : String(value))}>
      <div className="max-w-full overflow-x-auto">
        <TabsList aria-label="授权生命周期" className="h-9">
          {lifecycle.map(([value, label]) => <TabsTrigger key={value || 'all'} value={value || 'all'} className="px-2.5">
            {label}
            <span className="text-muted-foreground text-xs font-normal tabular-nums">{data?.summary ? String(data.summary[value || 'all'] ?? 0) : ''}</span>
          </TabsTrigger>)}
        </TabsList>
      </div>
    </Tabs>}
    <div className="flex flex-wrap-reverse items-end justify-between gap-3">
      {route !== 'users' ? <ListFilters key={route} route={route} filter={filter} busy={busy} applyForm={applyForm} /> : null}
      {(create && can(create) || exportable) && <div className="ml-auto flex flex-wrap gap-2">
        {create && can(create) && <Button variant={backupNeeded ? 'outline' : 'default'} className="max-sm:h-10" onClick={() => open(create)}><Plus aria-hidden="true" />{forms[create].title}</Button>}
        {exportable && <a className={cn(buttonVariants({ variant: 'outline' }), 'max-sm:h-10')} href={`/console-api/export${route === 'finance' ? '/finance' : ''}?${query}`} download>
          <Download aria-hidden="true" />导出筛选结果
        </a>}
      </div>}
    </div>
    {backupNeeded && <Alert role="note" className="border-warning/30 bg-warning/5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <span className="text-warning shrink-0"><ShieldAlert className="size-5" aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <AlertTitle>只有 1 名可用的管理员</AlertTitle>
        <AlertDescription>验证器丢失或忘记密码时将无法登录后台，只能上服务器手工处理。再开通一名管理员备用，平时不用。</AlertDescription>
      </div>
      <Button className="max-sm:h-10" onClick={() => open('create-user', { role: 'owner', reason: '备用管理员' })}>开通第二名管理员</Button>
    </Alert>}
    {route === 'finance' && data?.summary && <p className="text-sm">
      退款合计 <strong className="font-semibold tabular-nums">{display('refundFen', data.summary.refundFen ?? 0)}</strong>
      （{String(data.summary.refundCount ?? 0)} 笔）· 开票记录 {String(data.summary.invoiceCount ?? 0)} 条
    </p>}
    {!data ? <ListSkeleton /> : data.items.length ? <DataTable rows={data.items} fields={columns[route] ?? []} {...select} />
      : <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Inbox aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>暂无记录</EmptyTitle>
          {filtered && <EmptyDescription>换个筛选条件试试</EmptyDescription>}
        </EmptyHeader>
      </Empty>}
    {data && route !== 'users' && <div className="flex items-center justify-end gap-2">
      <Button variant="outline" size="sm" className="max-sm:h-9" aria-label="上一页" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}>
        <ChevronLeft aria-hidden="true" />上一页
      </Button>
      <span className="text-muted-foreground px-1 text-sm tabular-nums">第 {page} 页</span>
      <Button variant="outline" size="sm" className="max-sm:h-9" disabled={!data.hasMore || busy} onClick={() => setPage(value => value + 1)}>
        下一页<ChevronRight aria-hidden="true" />
      </Button>
    </div>}
  </div>;
}
