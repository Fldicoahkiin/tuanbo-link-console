import type { ReactNode } from 'react';
import type { ConsoleRow } from '../../src/console-contract';
import { PageCard } from '../components/page-card';
import { Button } from '../components/ui/button';
import { destructiveActions, forms } from '../forms';
import type { ActionName } from '../console-app';

type Group = { label?: string; entries: { action: ActionName; show: boolean }[] };

// 每个按钮出现的条件与改版前 main.tsx 逐条相同，只是按用途分了组。
function orderGroups(item: ConsoleRow): Group[] {
  const pending = item.state === 'pending';
  const unpaid = item.paymentStatus === 'pending';
  const confirmed = item.paymentStatus === 'confirmed';
  const channel = String(item.channel);
  return [
    { label: '收款与交付', entries: [
      { action: 'fulfill', show: pending && item.channel === 'manual' },
      { action: 'payment-link', show: pending && unpaid && ['manual', 'alipay'].includes(channel) },
      { action: 'reconcile', show: ['alipay', 'wechat'].includes(channel) },
      { action: 'retry-delivery', show: confirmed && ['pending', 'paid'].includes(String(item.state)) },
      { action: 'delivery-access', show: true },
      { action: 'revoke-delivery-access', show: true }
    ] },
    { label: '售后与财务', entries: [
      { action: 'create-ticket', show: true },
      { action: 'refund', show: confirmed },
      { action: 'alipay-refund', show: item.channel === 'alipay' && confirmed && item.state !== 'refunded' },
      { action: 'refund-review', show: Number(item.channelRefundFen) > Number(item.reviewedRefundFen) },
      { action: 'invoice', show: true }
    ] },
    { label: '结束', entries: [{ action: 'close-order', show: pending && unpaid && item.channel === 'manual' }] }
  ];
}

function licenseGroups(item: ConsoleRow): Group[] {
  const revoked = item.status === 'revoked';
  return [
    { label: '查看与调整', entries: [
      { action: 'reveal', show: true },
      { action: 'set-expiry', show: !revoked },
      { action: 'migrate', show: revoked }
    ] },
    { label: '停用', entries: [{ action: 'revoke', show: !revoked }] }
  ];
}

const groupsOf: Record<string, (item: ConsoleRow) => Group[]> = {
  orders: orderGroups,
  licenses: licenseGroups,
  tickets: item => [{ entries: [{ action: 'update-ticket', show: item.state !== 'closed' }] }],
  feedback: () => [{ entries: [{ action: 'update-feedback', show: true }] }],
  users: () => [{ entries: [{ action: 'update-user', show: true }, { action: 'reset-user', show: true }] }]
};

// 每页最多一个主按钮：按顺序取第一个出现的；会让凭据失效的操作始终是红色，不当主按钮。
const primaryOrder: Record<string, ActionName[]> = {
  orders: ['fulfill', 'retry-delivery', 'refund-review'],
  licenses: ['reveal'],
  tickets: ['update-ticket'],
  feedback: ['update-feedback'],
  users: ['update-user']
};

/** 详情页的「操作」卡片：按用途分组，每个操作仍是直接看得见的按钮；没有按钮的组和卡片不显示。 */
export function DetailActions({ resource, item, can, open, extra }: {
  resource: string; item: ConsoleRow; can: (action: ActionName) => boolean; open: (action: ActionName, row: ConsoleRow) => void; extra?: ReactNode;
}) {
  const groups = (groupsOf[resource]?.(item) ?? [])
    .map(group => ({ label: group.label, actions: group.entries.filter(entry => entry.show && can(entry.action)).map(entry => entry.action) }))
    .filter(group => group.actions.length > 0);
  if (!groups.length && !extra) return null;
  const shown = groups.flatMap(group => group.actions);
  const primary = (primaryOrder[resource] ?? []).find(action => shown.includes(action) && !destructiveActions.has(action));
  const variant = (action: ActionName) => destructiveActions.has(action) ? 'destructive' : action === primary ? 'default' : 'outline';
  return <PageCard title="操作" contentClassName="flex flex-col gap-4">
    {groups.map((group, index) => <div key={group.label ?? index} className="flex flex-col gap-2">
      {group.label && <p className="text-muted-foreground text-xs">{group.label}</p>}
      <div className="flex flex-wrap gap-2">
        {index === 0 && extra}
        {group.actions.map(action => <Button key={action} variant={variant(action)} className="max-sm:h-10" onClick={() => open(action, item)}>{forms[action].title}</Button>)}
      </div>
    </div>)}
    {!groups.length && <div className="flex flex-wrap gap-2">{extra}</div>}
  </PageCard>;
}
