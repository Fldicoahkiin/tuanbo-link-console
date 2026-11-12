import { useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { consolePolicy } from '../src/console-contract';
import { api, ApiError, errorMessage, messageSchema } from './api';
import { cn } from './lib/utils';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { FieldLabel } from './components/ui/field';
import { Input } from './components/ui/input';

/** 二次验证有效期，和服务端一样读 consolePolicy。 */
const stepUpWindow = consolePolicy.stepUpMs;
export const stepUpMinutes = consolePolicy.stepUpMs / 60000;
export const stepUpRemaining = (verifiedAt: number, clockOffset: number) => verifiedAt + stepUpWindow - (Date.now() + clockOffset);

/** 6 位验证码：调出数字键盘，输满自动提交；输错时抖动并清空。恢复码是次要入口，点了才换成普通输入框。 */
export function OneTimeCode({ label = '验证器验证码', allowRecovery, recoverySubmit, onComplete, failures, disabled, autoFocus }: {
  label?: string; allowRecovery: boolean; recoverySubmit?: string; onComplete: (code: string) => void; failures: number; disabled: boolean; autoFocus?: boolean;
}) {
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!failures) return;
    setValue('');
    const field = input.current;
    if (!field) return;
    // 先去掉再加上，连续输错也能再抖一次。
    field.classList.remove('animate-shake');
    void field.offsetWidth;
    field.classList.add('animate-shake');
    field.focus();
  }, [failures]);
  return <div className="flex flex-col items-start gap-2">
    {recovery
      ? <>
        <FieldLabel htmlFor={id}>恢复码</FieldLabel>
        <div className="flex w-full gap-2">
          <Input ref={input} id={id} name="code" className="h-9" value={value} onChange={event => setValue(event.target.value.trim())}
            autoComplete="off" spellCheck={false} required minLength={6} maxLength={100} disabled={disabled} autoFocus />
          {recoverySubmit && <Button type="submit" size="lg" className="max-sm:h-10" disabled={disabled}>{recoverySubmit}</Button>}
        </div>
      </>
      : <>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input ref={input} id={id} name="code" value={value} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={disabled} autoFocus={autoFocus}
          className="h-10 w-40 pl-[0.6em] text-center font-mono text-lg tracking-[0.5em] md:text-lg"
          onChange={event => {
            const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
            setValue(digits);
            if (digits.length === 6) onComplete(digits);
          }} />
      </>}
    {allowRecovery && <Button type="button" variant="link" size="sm" className="h-auto px-0" disabled={disabled} onClick={() => { setRecovery(!recovery); setValue(''); }}>
      {recovery ? '改用验证器验证码' : '改用恢复码'}
    </Button>}
  </div>;
}

/**
 * 敏感操作前的验证层：验证通过后由调用方自动继续原操作。
 * plain 只给 StepUpDialog 用：对话框自己有标题，这里就不再画边框和标题。
 */
export function StepUpPrompt({ csrf, onVerified, onCancel, title = '需要二次验证', hint = `敏感操作需在 ${stepUpMinutes} 分钟内验证过，验证后自动继续。`, plain = false }: {
  csrf: string; onVerified: () => void; onCancel?: () => void; title?: string; hint?: string; plain?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState(0);
  async function verify(code: string) {
    setBusy(true);
    setError('');
    try {
      await api('verify', messageSchema, { code }, csrf);
      onVerified();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === 'INVALID_CODE' ? '验证码不对或已用过，请输入下一枚' : errorMessage(cause));
      setFailures(count => count + 1);
    } finally {
      setBusy(false);
    }
  }
  return <form aria-label="二次验证" className={cn('flex flex-col gap-3', !plain && 'rounded-lg border bg-muted/50 p-4')}
    onSubmit={event => {
      event.preventDefault();
      const code = new FormData(event.currentTarget).get('code');
      if (typeof code === 'string') void verify(code);
    }}>
    {!plain && <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-primary" aria-hidden="true" />{title}</p>}
    {!plain && <p className="text-sm text-muted-foreground">{hint}</p>}
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    <OneTimeCode allowRecovery recoverySubmit="验证" onComplete={code => { void verify(code); }} failures={failures} disabled={busy} autoFocus />
    {onCancel && <Button type="button" variant="ghost" size="sm" className="-ml-2.5 self-start" disabled={busy} onClick={onCancel}>取消</Button>}
  </form>;
}

/** 页头常驻状态：有效时显示还剩多久，未验证时可点击提前验证。 */
export function StepUpBadge({ verifiedAt, clockOffset, onVerify }: { verifiedAt: number; clockOffset: number; onVerify: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = stepUpRemaining(verifiedAt, clockOffset);
  if (left <= 0) {
    return <Button variant="outline" size="sm" title={`点击提前验证，之后 ${stepUpMinutes} 分钟内敏感操作无需再输验证码`} onClick={onVerify}>
      <ShieldCheck aria-hidden="true" />二次验证：未验证
    </Button>;
  }
  const seconds = Math.ceil(left / 1000);
  const rest = seconds >= 60 ? `还剩 ${Math.ceil(seconds / 60)} 分钟` : `还剩 ${seconds} 秒`;
  return <Badge variant="secondary" className="h-7 gap-1.5 rounded-lg bg-success/10 px-2.5 text-success" title={`${stepUpMinutes} 分钟内的敏感操作无需再输验证码`}>
    <ShieldCheck aria-hidden="true" />二次验证：有效（{rest}）
  </Badge>;
}

/** 从页头标签提前验证。 */
export function StepUpDialog({ csrf, onVerified, close }: { csrf: string; onVerified: () => void; close: () => void }) {
  const hint = `验证后 ${stepUpMinutes} 分钟内的敏感操作无需再输验证码。`;
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent showCloseButton={false} className="gap-4 sm:max-w-sm">
      <div className="flex flex-col gap-2 pr-8">
        <DialogTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" aria-hidden="true" />提前验证</DialogTitle>
        <DialogDescription>{hint}</DialogDescription>
      </div>
      <StepUpPrompt csrf={csrf} title="提前验证" hint={hint} onVerified={onVerified} plain />
      <DialogClose render={<Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" />} aria-label="关闭">
        <X aria-hidden="true" />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
