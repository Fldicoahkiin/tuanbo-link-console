import { useState } from 'react';
import type { ConsoleRow } from '../src/console-contract';
import { PageCard } from './components/page-card';
import { cn } from './lib/utils';
import { Label } from './components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';

const money = (fen: number) => `¥${(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 工作台的收款趋势：近 30 天每日收款（实线）和退款（虚线），手画 SVG，不引图表库。 */
export function RevenueTrend({ rows, className }: { rows: ConsoleRow[]; className?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const aside = <span className="text-muted-foreground text-xs">近 30 天 · 北京时间</span>;
  const last = rows[rows.length - 1];
  if (!last) {
    return <PageCard title="收款趋势" aside={aside} className={className}>
      <p className="text-muted-foreground py-8 text-center text-sm">暂无数据</p>
    </PageCard>;
  }
  const current = rows.find(row => row.day === selected) ?? last;
  const maximum = Math.max(100, ...rows.flatMap(row => [Number(row.incomeFen), Number(row.refundFen)]));
  const x = (index: number) => 58 + index * 704 / Math.max(1, rows.length - 1);
  const y = (value: number) => 166 - value / maximum * 134;
  const points = (key: string) => rows.map((row, index) => `${x(index)},${y(Number(row[key]))}`).join(' ');
  const days = rows.map(row => ({ value: String(row.day), label: String(row.day) }));
  return <PageCard title="收款趋势" aside={aside} className={className} contentClassName="flex flex-col gap-3" label="近 30 天每日收款和退款">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-live="polite">
        <span className="text-muted-foreground tabular-nums">{String(current.day)}</span>
        <span className="flex items-center gap-1.5">
          <span className={cn('bg-primary size-2 rounded-full')} aria-hidden="true" />
          收款 <strong className="font-semibold tabular-nums">{money(Number(current.incomeFen))}</strong>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="border-warning h-0 w-3 border-t-2 border-dashed" aria-hidden="true" />
          退款 <strong className="font-semibold tabular-nums">{money(Number(current.refundFen))}</strong>
        </span>
      </div>
      <svg viewBox="0 0 790 200" role="img" aria-label="蓝线为每日收款，虚线为每日退款" className="h-auto w-full">
        {[0, 0.5, 1].map(fraction => <g key={fraction}>
          <line x1="58" x2="762" y1={y(maximum * fraction)} y2={y(maximum * fraction)} stroke="var(--border)" />
          <text x="48" y={y(maximum * fraction) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
            {(maximum * fraction / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
          </text>
        </g>)}
        <polyline points={points('incomeFen')} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={points('refundFen')} fill="none" stroke="var(--warning)" strokeWidth="2" strokeDasharray="5 4" />
        {rows.map((row, index) => <g key={String(row.day)}>
          <rect x={x(index) - 10} y="20" width="20" height="151" fill="transparent" onPointerEnter={() => setSelected(String(row.day))} onClick={() => setSelected(String(row.day))}>
            <title>{String(row.day)}：收款 {money(Number(row.incomeFen))}；退款 {money(Number(row.refundFen))}</title>
          </rect>
          {[0, 7, 14, 21, 29].includes(index) && <text x={x(index)} y="190" textAnchor="middle" className="fill-muted-foreground text-[11px]">{String(row.day).slice(5)}</text>}
        </g>)}
      </svg>
      <div className="flex items-center gap-2">
        <Label htmlFor="trend-day" className="text-muted-foreground text-sm font-normal">查询日期</Label>
        <Select items={days} value={String(current.day)} onValueChange={value => { if (typeof value === 'string') setSelected(value); }}>
          <SelectTrigger id="trend-day" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {days.map(day => <SelectItem key={day.value} value={day.value}>{day.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
  </PageCard>;
}
