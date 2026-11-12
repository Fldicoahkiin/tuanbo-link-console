import { useEffect, useState } from 'react';
import { CircleCheck, ExternalLink } from 'lucide-react';
import type { ConsoleResult } from '../../../src/console-contract';
import { beijingTime } from '../../forms';
import { cn } from '../../lib/utils';
import { CopyButton } from '../copy-button';
import { Button, buttonVariants } from '../ui/button';
import { Spinner } from '../ui/spinner';

/** 激活码、凭据显示多少秒后自动隐藏。 */
const secretSeconds = 60;

/** 提交成功后的结果：一句话、有效期、激活码或凭据（倒计时隐藏）、付款二维码（等客户付款），最下面「完成」。 */
export function ResultView({ result, qr, paid, onHideSecret, onDone }: {
  result: ConsoleResult; qr: string; paid: boolean; onHideSecret: () => void; onDone: () => void;
}) {
  return <div className="flex flex-col gap-4">
    <div role="status" className="flex items-start gap-2">
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      <p className="text-sm">{result.message}</p>
    </div>
    {result.expiresAt && <p className="text-sm text-muted-foreground">有效期至 {beijingTime(result.expiresAt)}</p>}
    {result.secret && <Secret value={result.secret} onHide={onHideSecret} />}
    {result.paymentUrl && paid && <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">已付款，已发码。</p>}
    {result.paymentUrl && !paid && <Payment url={result.paymentUrl} qr={qr} />}
    <Button size="lg" className="w-full max-sm:h-10" onClick={onDone}>完成</Button>
  </div>;
}

/** 激活码或凭据：等宽、可选中，旁边复制，下面倒计时，到 0 由上层换成「激活码已隐藏。」。 */
function Secret({ value, onHide }: { value: string; onHide: () => void }) {
  const [left, setLeft] = useState(secretSeconds);
  useEffect(() => {
    // 按到点的时刻算，不数跳了几次：标签页在后台时浏览器会把定时器放慢，数次数会让激活码留得比 60 秒久。
    const deadline = Date.now() + secretSeconds * 1000;
    const timer = window.setInterval(() => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (left === 0) onHide(); }, [left, onHide]);
  return <div className="flex flex-col gap-2">
    <div className="flex items-start gap-2">
      <pre data-testid="secret" className="min-w-0 flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-sm break-all whitespace-pre-wrap select-all">{value}</pre>
      <CopyButton value={value} size="default" className="h-9">复制</CopyButton>
    </div>
    <p className="text-xs text-muted-foreground tabular-nums">{left} 秒后自动隐藏</p>
  </div>;
}

/** 支付宝付款链接：二维码给客户扫，或复制链接发过去；上层每 5 秒查一次订单。 */
function Payment({ url, qr }: { url: string; qr: string }) {
  return <div className="flex flex-col items-center gap-3 rounded-lg border p-4">
    {qr && <img src={qr} width={200} height={200} alt="支付宝付款二维码" className="size-50" />}
    <div className="flex w-full flex-wrap justify-center gap-2">
      <CopyButton value={url} size="default" className="h-9">复制链接</CopyButton>
      <a className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} href={url} target="_blank" rel="noreferrer">
        <ExternalLink aria-hidden="true" />打开付款页
      </a>
    </div>
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner aria-hidden="true" />客户付款后这里会自动提示
    </p>
  </div>;
}
