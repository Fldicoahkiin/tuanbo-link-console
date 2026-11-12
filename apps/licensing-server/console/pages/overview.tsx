import { ArrowUpRight, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import type { ConsoleRow } from '../../src/console-contract';
import { PageCard } from '../components/page-card';
import { Button } from '../components/ui/button';
import { display, labels } from '../forms';
import { cn } from '../lib/utils';
import type { Filter } from '../location';
import { overviewTasks } from '../navigation';
import { RevenueTrend } from '../revenue-trend';
import { DataTable, Fields } from '../table';
import type { ActionName, Detail } from '../console-app';

type OverviewProps = {
  overview: Detail;
  can: (action: ActionName) => boolean;
  open: (action: ActionName) => void;
  navigate: (key: string, preset?: Partial<Filter>) => void;
};

function Figure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return <div className="flex min-w-0 flex-col gap-1">
    <span className="text-muted-foreground text-xs">{label}</span>
    <span className="text-base font-semibold tabular-nums">{value}{unit && <span className="text-muted-foreground ml-0.5 text-xs font-normal">{unit}</span>}</span>
  </div>;
}

/** 工作台：待办和入口在最上面，金额（管理员、财务才有）在下面，运行与维护默认收起。 */
export function OverviewPage({ overview, can, open, navigate }: OverviewProps) {
  const item = overview.item;
  // 反馈数只返回给管理员和运营，其他角色不显示这一行。
  const tasks = overviewTasks.filter(task => item[task.key] !== undefined);
  const checks = overview.related.filter(row => row.category !== 'cashflow');
  const shortcut = 'h-10 w-full justify-between px-3 font-normal';
  return <div className="flex flex-col gap-6">
    <div className="grid gap-6 lg:grid-cols-3">
      <PageCard title="待办事项" className="lg:col-span-2" cardClassName="pb-0" contentClassName="px-0">
        <ul className="flex flex-col divide-y border-t">
          {tasks.map(task => {
            const count = Number(item[task.key] ?? 0);
            return <li key={task.key}>
              <button type="button" onClick={() => navigate(task.route, task.preset)}
                className="hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">{task.title}</span>
                  {task.hint && <span className="text-muted-foreground text-xs">{task.hint}</span>}
                </span>
                <span className={cn('text-base tabular-nums', count > 0 ? 'text-primary font-semibold' : 'text-muted-foreground')}>{String(item[task.key] ?? 0)}</span>
                <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              </button>
            </li>;
          })}
        </ul>
      </PageCard>
      <PageCard title="开始处理" contentClassName="flex flex-col gap-2">
        {can('create-order') && <Button variant="outline" className={shortcut} onClick={() => open('create-order')}>创建线下订单<ArrowUpRight aria-hidden="true" /></Button>}
        {can('grant') && <Button variant="outline" className={shortcut} onClick={() => open('grant')}>签发内测 / 赠送授权<ArrowUpRight aria-hidden="true" /></Button>}
        <Button variant="outline" className={shortcut} onClick={() => navigate('licenses')}>管理激活码与期限<ArrowUpRight aria-hidden="true" /></Button>
        <div className="mt-3 grid grid-cols-2 gap-4 border-t pt-4">
          <Figure label="累计客户" value={String(item.customerCount ?? 0)} unit="位" />
          <Figure label="已绑定授权" value={String(item.boundLicenseCount ?? 0)} unit="份" />
        </div>
      </PageCard>
    </div>
    {/* 金额仅返回给管理员和财务，其他角色的概览不含这些字段。 */}
    {item.netFen !== undefined && <div className="grid gap-6 lg:grid-cols-3">
      <PageCard title="收款概览" label="收款概览" contentClassName="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-sm">累计净收款</span>
          <strong data-testid="net-income" className="text-3xl font-semibold tabular-nums">{display('netFen', item.netFen ?? 0)}</strong>
          <span className="text-muted-foreground text-xs">已扣除退款</span>
        </div>
        <div className="grid grid-cols-3 gap-3 border-t pt-4">
          {(['onlineFen', 'manualFen', 'refundFen'] as const).map(key => <Figure key={key} label={labels[key] ?? key} value={display(key, item[key] ?? 0)} />)}
        </div>
      </PageCard>
      <RevenueTrend className="lg:col-span-2" rows={overview.related.filter(row => row.category === 'cashflow')} />
    </div>}
    <Maintenance item={item} checks={checks} />
  </div>;
}

function Maintenance({ item, checks }: { item: ConsoleRow; checks: ConsoleRow[] }) {
  return <details className="group bg-card ring-foreground/10 rounded-xl ring-1">
    <summary className="hover:bg-muted/50 flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
      <ShieldCheck className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 font-medium">运行与维护</span>
      <span className="text-muted-foreground text-xs">服务{String(item.service ?? '状态未知')} · 查看记录</span>
      <ChevronDown className="text-muted-foreground size-4 shrink-0 group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div className="flex flex-col gap-4 border-t p-4">
      <Fields row={Object.fromEntries(['service', 'backup', 'recovery'].map(key => [key, item[key] ?? null]))} />
      {checks.length > 0 && <DataTable rows={checks} fields={['name', 'state', 'checkedAt', 'detail']} />}
    </div>
  </details>;
}
