import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { notify } from './toaster';

/** 复制一段文字。成功后图标变成对勾两秒并出提示；浏览器不让复制时说明怎么办。只给图标时必须传 label（读屏和悬停提示用）。 */
export function CopyButton({ value, label = '复制', children, variant = 'outline', size, className }: {
  value: string; label?: string; children?: ReactNode; variant?: 'outline' | 'ghost' | 'secondary'; size?: 'default' | 'sm' | 'icon-sm' | 'icon-xs'; className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2000); return () => window.clearTimeout(timer); }, [copied]);
  const copy = () => { navigator.clipboard.writeText(value).then(() => { setCopied(true); notify.success('已复制'); }, () => notify.error('没有复制成功', '浏览器不允许自动复制，请手动选中后复制。')); };
  return <Button type="button" variant={variant} size={size ?? (children ? 'default' : 'icon-sm')} className={className} aria-label={children ? undefined : label} title={children ? undefined : label} onClick={copy}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{children}
  </Button>;
}
