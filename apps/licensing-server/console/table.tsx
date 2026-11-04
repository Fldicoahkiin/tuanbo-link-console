import { createContext, useContext, useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { ConsoleRow } from '../src/console-contract';
import { beijingTime, display, labels } from './forms';

const chipFields = new Set(['state', 'paymentStatus', 'status']);
// 详情页不显示未发生的事项（无退款、无工单、无错误、未绑定），编号放最后。
const optionalFields = new Set(['deliveryError', 'openTickets', 'refundedFen', 'channelRefundFen', 'reviewedRefundFen', 'paymentReference', 'receivedAt', 'machineCode', 'leaseUntil', 'lastIssuedAt', 'license_id', 'conclusion',
  'contact', 'reporterMachine', 'licenseId', 'attachmentBytes', 'attachmentAt', 'attachmentIssue', 'resolution', 'envObs', 'envMa2', 'envPlayback']);
// 原订单编号与「业务订单号」重复，详情页不再单列。
const hiddenFields = new Set(['orderId']);
export function detailRow(row: ConsoleRow): ConsoleRow {
  const { id, ...rest } = row;
  return { ...Object.fromEntries(Object.entries(rest).filter(([key, value]) => !hiddenFields.has(key) && (!optionalFields.has(key) || value !== null && value !== 0 && value !== ''))), ...(id === undefined ? {} : { id }) };
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
function Cell({ field, value }: { field: string; value: ConsoleRow[string] | undefined }) {
  const cell = value ?? null; const clockOffset = useContext(ServerClock);
  if (chipFields.has(field)) return <span className={`status-badge status-${String(cell)}`}>{display(field, cell)}</span>;
  if (field === 'useUntil') return typeof cell === 'string' ? <span title={beijingTime(cell)}>{remaining(cell, clockOffset)}</span> : <span>永久</span>;
  if (field === 'machineCode') return <span title={typeof cell === 'string' ? cell : undefined}>{typeof cell === 'string' ? `${cell.replace(/^TB1-/, '').slice(0, 8)}…` : '未绑定'}</span>;
  return <span>{display(field, cell)}</span>;
}
export function DataTable({ rows, fields, select, canSelect }: { rows: ConsoleRow[]; fields: string[]; select?: (row: ConsoleRow) => void; canSelect?: (row: ConsoleRow) => boolean }) {
  const selectable = (row: ConsoleRow) => select !== undefined && (canSelect?.(row) ?? true);
  return <div className="table-wrap"><table><thead><tr>{fields.map(key => <th key={key}>{labels[key] ?? key}</th>)}{select && <th><span className="visually-hidden">操作</span></th>}</tr></thead><tbody>{rows.map((row, index) =>
    // 整行可点进详情；行末按钮保留给键盘和读屏。
    <tr key={String(row.id ?? index)} className={selectable(row) ? 'clickable' : undefined} onClick={selectable(row) ? () => select?.(row) : undefined}>
      {fields.map(key => <td key={key} data-label={labels[key] ?? key}><Cell field={key} value={row[key]} /></td>)}
      {select && <td className="row-open">{selectable(row) && <button aria-label="查看详情" title="查看详情" onClick={event => { event.stopPropagation(); select(row); }}><ChevronRight size={16} /></button>}</td>}
    </tr>)}</tbody></table></div>;
}
export function Fields({ row }: { row: ConsoleRow }) {
  const [copied, setCopied] = useState(false);
  return <dl className="details">{Object.entries(row).map(([key, value]) => <div key={key} data-field={key}><dt>{labels[key] ?? key}</dt><dd>{key === 'id' && typeof value === 'string'
    ? <span className="identifier-copy"><code>{value}</code><button aria-label="复制编号" title={copied ? '已复制' : '复制编号'} onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}><Copy size={14} /></button></span>
    : chipFields.has(key) ? <span className={`status-badge status-${String(value)}`}>{display(key, value)}</span> : display(key, value)}</dd></div>)}</dl>;
}
