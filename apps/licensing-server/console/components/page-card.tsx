import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card, CardContent, CardHeader } from './ui/card';

/** 页面上的一个区块：带边框的卡片，标题是 h2，右边可放一句小字或按钮。 */
export function PageCard({ title, aside, children, className, cardClassName, contentClassName, label }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string | undefined; cardClassName?: string | undefined; contentClassName?: string | undefined; label?: string | undefined;
}) {
  return <section className={cn('min-w-0', className)} aria-label={label}>
    <Card className={cn('h-full', cardClassName)}>
      {title !== undefined && <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base leading-snug font-medium">{title}</h2>
        {aside}
      </CardHeader>}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  </section>;
}
