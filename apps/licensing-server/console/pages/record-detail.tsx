import { ArrowLeft, Download } from 'lucide-react';
import type { ConsoleRow } from '../../src/console-contract';
import { PageCard } from '../components/page-card';
import { StatusBadge } from '../components/status-badge';
import { Button, buttonVariants } from '../components/ui/button';
import { beijingTime, display } from '../forms';
import { cn } from '../lib/utils';
import { DataTable, Fields, detailRow } from '../table';
import type { ActionName, Detail } from '../console-app';
import { DetailActions } from './detail-actions';
import { DetailSkeleton } from './page-state';

const titles: Record<string, string> = { orders: '订单详情', licenses: '授权详情', tickets: '工单详情', feedback: '反馈详情', users: '人员详情' };
// 标题旁边显示的主要状态。
const statusFields: Record<string, string[]> = { orders: ['state', 'paymentStatus'], licenses: ['status'], tickets: ['state'], feedback: ['state'], users: ['status'] };
const relatedTitles: Record<string, string> = { orders: '关联授权', licenses: '续费记录', feedback: '同一台电脑的其他反馈', tickets: '关联订单' };
const relatedFields: Record<string, string[]> = {
  orders: ['customer', 'status', 'useUntil', 'machineCode'],
  licenses: ['id', 'useUntil', 'updatesUntil'],
  feedback: ['number', 'category', 'state', 'summary', 'created'],
  tickets: ['reference', 'customer', 'state']
};
// 点关联记录跳到哪个页面的详情。
const relatedRoute = (resource: string) => resource === 'orders' ? 'licenses' : resource === 'feedback' ? 'feedback' : 'orders';

type DetailProps = {
  route: string;
  resource: string;
  selected: ConsoleRow;
  detail: Detail | null;
  can: (action: ActionName) => boolean;
  open: (action: ActionName, row: ConsoleRow) => void;
  back: () => void;
  openRecord: (route: string, row: ConsoleRow) => void;
};

/** 授权的生命周期：竖排时间线，推算出来的节点用虚线圆点和灰字。 */
function Timeline({ nodes }: { nodes: ConsoleRow[] }) {
  return <ol className="flex flex-col">
    {nodes.map((node, index) => <li key={index} className="relative flex gap-3 pb-5 last:pb-0">
      {index < nodes.length - 1 && <span className="bg-border absolute top-4 bottom-0 left-[5px] w-px" aria-hidden="true" />}
      <span className={cn('relative mt-1.5 size-[11px] shrink-0 rounded-full border-2', node.inferred ? 'border-muted-foreground/60 bg-background border-dashed' : 'border-primary bg-background')} aria-hidden="true" />
      <div className={cn('flex min-w-0 flex-col gap-0.5', node.inferred && 'text-muted-foreground')}>
        <span className="text-sm font-medium">{String(node.event)}</span>
        {node.detail !== null && node.detail !== undefined && <span className="text-sm break-words">{String(node.detail)}</span>}
        <span className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
          {node.operator !== null && node.operator !== undefined && <span>{String(node.operator)}</span>}
          <time className="tabular-nums">{beijingTime(String(node.at))}</time>
        </span>
      </div>
    </li>)}
  </ol>;
}

/** 详情页：返回、标题和状态、基本信息、操作、生命周期、关联记录、操作记录。人员没有详情接口，用列表里那一行。 */
export function RecordDetail({ route, resource, selected, detail, can, open, back, openRecord }: DetailProps) {
  const item = route === 'users' ? selected : detail?.item;
  const backButton = <div><Button variant="ghost" className="-ml-2.5 max-sm:h-9" onClick={back}><ArrowLeft aria-hidden="true" />返回列表</Button></div>;
  if (!item) return <div className="flex flex-col gap-4">{backButton}<DetailSkeleton /></div>;
  const download = resource === 'feedback' && item.attachment === 'received'
    ? <a className={cn(buttonVariants({ variant: 'outline' }), 'max-sm:h-10')} href={`/console-api/feedback/${String(item.id)}/diagnostic`} download><Download aria-hidden="true" />下载诊断包</a>
    : undefined;
  // 标题旁的状态：两个状态显示成同样的字（订单没付款时状态和付款状态都是「待付款」）就只留一个。
  const badges = (statusFields[resource] ?? []).filter(field => item[field] !== undefined)
    .filter((field, index, all) => all.findIndex(other => display(other, item[other] ?? null) === display(field, item[field] ?? null)) === index);
  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-3">
      {backButton}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{titles[resource] ?? '订单详情'}</h2>
        {badges.map(field => <StatusBadge key={field} field={field} value={item[field] ?? null} />)}
      </div>
    </div>
    <PageCard title="基本信息"><Fields row={detailRow(item)} /></PageCard>
    <DetailActions resource={resource} item={item} can={can} open={open} extra={download} />
    {detail && route !== 'users' && <>
      {detail.timeline && detail.timeline.length > 0 && <PageCard title="生命周期"><Timeline nodes={detail.timeline} /></PageCard>}
      {detail.related.length > 0 && <PageCard title={relatedTitles[resource] ?? '关联订单'}>
        <DataTable rows={detail.related} fields={relatedFields[resource] ?? relatedFields.tickets ?? []} select={row => openRecord(relatedRoute(resource), row)} />
      </PageCard>}
      {detail.history.length > 0 && <PageCard title="操作记录">
        <DataTable rows={detail.history} fields={['at', 'operator', 'action', 'reason', 'result']} />
      </PageCard>}
    </>}
  </div>;
}
