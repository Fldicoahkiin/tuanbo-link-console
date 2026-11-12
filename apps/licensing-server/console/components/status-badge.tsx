import { display } from '../forms';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const tones: Record<Tone, string> = {
  success: 'bg-success/10 text-success', warning: 'bg-warning/10 text-warning', danger: 'bg-destructive/10 text-destructive', info: 'bg-primary/10 text-primary', neutral: 'bg-muted text-muted-foreground'
};
// 绿：正常或办完了；黄：等人处理；红：已失效或被拒；蓝：进行中；灰：结束了、不用管。没列出的值按灰色显示。
const toneOf: Record<string, Tone> = {
  active: 'success', fulfilled: 'success', confirmed: 'success', enabled: 'success', issued: 'success', received: 'success', success: 'success',
  pending: 'warning', paid: 'warning', open: 'warning', expiring: 'warning', 'not-enrolled': 'warning', waiting: 'warning', requested: 'warning',
  processing: 'info', unbound: 'info',
  revoked: 'danger', refunded: 'danger', rejected: 'danger', denied: 'danger', missing: 'danger',
  expired: 'neutral', closed: 'neutral', disabled: 'neutral', 'not-applicable': 'neutral', none: 'neutral', removed: 'neutral'
};

/** 状态色块：订单状态、付款状态、授权状态、处理状态都用它，文字来自 forms.ts 的 display()。 */
export function StatusBadge({ field, value, className }: { field: string; value: string | number | boolean | null; className?: string }) {
  return <Badge variant="secondary" className={cn(tones[toneOf[String(value)] ?? 'neutral'], value === 'revoked' && 'line-through', className)}>{display(field, value)}</Badge>;
}
