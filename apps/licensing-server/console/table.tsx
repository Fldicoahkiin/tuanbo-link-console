import { createContext, useContext } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ConsoleRow } from '../src/console-contract';
import { CopyButton } from './components/copy-button';
import { StatusBadge } from './components/status-badge';
import { Button } from './components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
import { beijingTime, display, labels } from './forms';
import { cn } from './lib/utils';

const chipFields = new Set(['state', 'paymentStatus', 'status']);
// 列表里的长文字：限制宽度、超出省略，悬停看全文。
const longCells = new Set(['note', 'summary', 'reason', 'deliveryError', 'detail', 'targetLabel']);
// 详情里的长文字：占满一行、允许换行；摘要这类没有空格的长串任意处断开。
const wideFields = new Set(['description', 'note', 'conclusion', 'resolution', 'deliveryError', 'summary', 'attachmentIssue', 'rollbackIssue', 'autoPublish', 'issue', 'manifestSha256']);
const unbrokenFields = new Set(['manifestSha256', 'machineCode', 'reporterMachine']);
// 编号、机器码这类长串占两列。
const doubleFields = new Set(['id', 'machineCode', 'reporterMachine']);
// 详情页不显示未发生的事项（无退款、无工单、无错误、未绑定），编号放最后。
const optionalFields = new Set(['deliveryError', 'openTickets', 'refundedFen', 'channelRefundFen', 'reviewedRefundFen', 'paymentReference', 'receivedAt',
  'machineCode', 'leaseUntil', 'lastIssuedAt', 'license_id', 'conclusion',
  'contact', 'reporterMachine', 'licenseId', 'attachmentBytes', 'attachmentAt', 'attachmentIssue', 'resolution', 'envObs', 'envMa2', 'envPlayback']);
// 原订单编号与「业务订单号」重复，详情页不再单列。
const hiddenFields = new Set(['orderId']);

/** 详情里要显示的字段：去掉没发生的事项和重复的编号，编号放最后。 */
export function detailRow(row: ConsoleRow): ConsoleRow {
  const { id, ...rest } = row;
  const shown = Object.entries(rest).filter(([key, value]) => !hiddenFields.has(key) && (!optionalFields.has(key) || value !== null && value !== 0 && value !== ''));
  return { ...Object.fromEntries(shown), ...(id === undefined ? {} : { id }) };
}

/** 服务器时间减本机时间；剩余天数和状态色块按同一个（服务器）时钟计算。 */
export const ServerClock = createContext(0);

/** 到期时间按剩余天数显示，悬停看北京时间。 */
function remaining(value: string, clockOffset: number): string {
  const left = Date.parse(value) - (Date.now() + clockOffset);
  if (left > 0) return `还有 ${Math.max(1, Math.ceil(left / 86400000))} 天`;
  const past = Math.floor(-left / 86400000);
  return past === 0 ? '今天已过期' : `已过期 ${past} 天`;
}

const isMoney = (field: string) => field.endsWith('Fen');

function Cell({ field, value }: { field: string; value: ConsoleRow[string] | undefined }) {
  const cell = value ?? null;
  const clockOffset = useContext(ServerClock);
  if (chipFields.has(field)) return <StatusBadge field={field} value={cell} />;
  if (field === 'useUntil') return typeof cell === 'string' ? <span title={beijingTime(cell)}>{remaining(cell, clockOffset)}</span> : <span>永久</span>;
  if (field === 'machineCode') {
    return typeof cell === 'string'
      ? <span className="font-mono text-xs" title={cell}>{`${cell.replace(/^TB1-/, '').slice(0, 8)}…`}</span>
      : <span className="text-muted-foreground">未绑定</span>;
  }
  const text = display(field, cell);
  if (longCells.has(field)) return <span className="block max-w-64 truncate max-md:max-w-none max-md:whitespace-normal max-md:break-words" title={text}>{text}</span>;
  return <span>{text}</span>;
}

// 窄屏（md 以下）每条记录一块：表头只留给读屏，每格一行「字段名 · 值」，字段名来自 data-label。
const cardRow = 'max-md:flex max-md:flex-col max-md:py-2';
const cardCell = 'max-md:flex max-md:h-auto max-md:items-start max-md:justify-between max-md:gap-3 max-md:py-1 max-md:text-right max-md:whitespace-normal max-md:break-all'
  + ' max-md:before:text-muted-foreground max-md:before:w-22 max-md:before:shrink-0 max-md:before:text-left max-md:before:text-xs max-md:before:leading-5'
  + ' max-md:before:break-normal max-md:before:content-[attr(data-label)]';

/** 列表：整行可点进详情，行末的「查看详情」按钮给键盘和读屏用；宽表格在自己的框里横向滚动，窄屏每条记录一块。 */
export function DataTable({ rows, fields, select, canSelect }: {
  rows: ConsoleRow[]; fields: string[]; select?: (row: ConsoleRow) => void; canSelect?: (row: ConsoleRow) => boolean;
}) {
  const selectable = (row: ConsoleRow) => select !== undefined && (canSelect?.(row) ?? true);
  return <div className="w-full min-w-0 rounded-lg border md:overflow-x-auto">
    <Table className="max-md:block">
      <TableHeader className="bg-muted/50 max-md:sr-only">
        <TableRow className="hover:bg-transparent">
          {fields.map(key => <TableHead key={key} className={cn('text-muted-foreground h-9 px-3 text-xs font-normal', isMoney(key) && 'text-right')}>{labels[key] ?? key}</TableHead>)}
          {select && <TableHead className="w-10 px-2"><span className="sr-only">操作</span></TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody className="max-md:block">
        {rows.map((row, index) => {
          const clickable = selectable(row);
          return <TableRow key={String(row.id ?? index)} className={cn(cardRow, clickable ? 'cursor-pointer' : 'hover:bg-transparent')} onClick={clickable ? () => select?.(row) : undefined}>
            {fields.map(key => <TableCell key={key} data-label={labels[key] ?? key} className={cn('h-11 px-3', cardCell, isMoney(key) && 'text-right tabular-nums')}><Cell field={key} value={row[key]} /></TableCell>)}
            {select && <TableCell className="w-10 px-2 text-right max-md:flex max-md:h-auto max-md:w-auto max-md:justify-end max-md:py-0">
              {clickable && <Button variant="ghost" size="icon-sm" aria-label="查看详情" title="查看详情" onClick={event => { event.stopPropagation(); select(row); }}>
                <ChevronRight aria-hidden="true" />
              </Button>}
            </TableCell>}
          </TableRow>;
        })}
      </TableBody>
    </Table>
  </div>;
}

function Value({ field, value }: { field: string; value: ConsoleRow[string] }) {
  if (field === 'id' && typeof value === 'string') {
    return <span className="flex items-start gap-1">
      <code className="font-mono text-xs leading-6 break-all">{value}</code>
      <CopyButton value={value} label="复制编号" variant="ghost" size="icon-xs" className="mt-0.5" />
    </span>;
  }
  if (chipFields.has(field)) return <StatusBadge field={field} value={value} />;
  return <>{display(field, value)}</>;
}

/** 详情的字段列表：手机两列、平板三列、桌面四列；长文字占满一行。 */
export function Fields({ row, className }: { row: ConsoleRow; className?: string }) {
  return <dl className={cn('grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-4', className)}>
    {Object.entries(row).map(([key, value]) => <div key={key} data-field={key} className={cn('flex min-w-0 flex-col gap-1', wideFields.has(key) && 'col-span-full', doubleFields.has(key) && 'col-span-2')}>
      <dt className="text-muted-foreground text-xs">{labels[key] ?? key}</dt>
      <dd className={cn('text-sm', unbrokenFields.has(key) ? 'font-mono text-xs break-all' : 'break-words', isMoney(key) && 'tabular-nums')}>
        <Value field={key} value={value} />
      </dd>
    </div>)}
  </dl>;
}
