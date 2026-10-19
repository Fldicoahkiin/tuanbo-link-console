import { useState } from 'react';
import type { ConsoleRow } from '../src/console-contract';

const money = (fen: number) => `¥${(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function RevenueTrend({ rows }: { rows: ConsoleRow[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!rows.length) return <section className="revenue-trend"><h2>收款趋势</h2><p className="muted">暂无趋势数据，请刷新页面。</p></section>;
  const current = rows.find(row => row.day === selected) ?? rows[rows.length - 1]!;
  const maximum = Math.max(100, ...rows.flatMap(row => [Number(row.incomeFen), Number(row.refundFen)]));
  const x = (index: number) => 58 + index * 704 / Math.max(1, rows.length - 1);
  const y = (value: number) => 166 - value / maximum * 134;
  const points = (key: string) => rows.map((row, index) => `${x(index)},${y(Number(row[key]))}`).join(' ');
  return <section className="revenue-trend" aria-label="近 30 天每日收款和退款">
    <div className="section-title"><h2>收款趋势</h2><span>近 30 天 · 北京时间</span></div>
    <div className="trend-readout" aria-live="polite"><span>{String(current.day)}</span><span className="income-key">收款 <strong>{money(Number(current.incomeFen))}</strong></span><span className="refund-key">退款 <strong>{money(Number(current.refundFen))}</strong></span></div>
    <svg viewBox="0 0 790 200" role="img" aria-label="蓝线为每日收款，虚线为每日退款">
      {[0, .5, 1].map(fraction => <g key={fraction}><line x1="58" x2="762" y1={y(maximum * fraction)} y2={y(maximum * fraction)} stroke="#eceef1" /><text x="48" y={y(maximum * fraction) + 4} textAnchor="end">{(maximum * fraction / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</text></g>)}
      <polyline points={points('incomeFen')} fill="none" stroke="#0067d9" strokeWidth="2" strokeLinejoin="round" />
      <polyline points={points('refundFen')} fill="none" stroke="#a66b39" strokeWidth="2" strokeDasharray="5 4" />
      {rows.map((row, index) => <g key={String(row.day)}><rect x={x(index) - 10} y="20" width="20" height="151" fill="transparent" onPointerEnter={() => setSelected(String(row.day))} onClick={() => setSelected(String(row.day))}><title>{String(row.day)}：收款 {money(Number(row.incomeFen))}；退款 {money(Number(row.refundFen))}</title></rect>{[0, 7, 14, 21, 29].includes(index) && <text x={x(index)} y="190" textAnchor="middle">{String(row.day).slice(5)}</text>}</g>)}
    </svg>
    <div className="trend-footer"><p>按实际确认日期汇总；收款额不等于利润。</p><label>查询日期<select value={String(current.day)} onChange={event => setSelected(event.target.value)}>{rows.map(row => <option key={String(row.day)} value={String(row.day)}>{String(row.day)}</option>)}</select></label></div>
  </section>;
}
