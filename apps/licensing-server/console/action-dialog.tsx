import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { CircleAlert, TriangleAlert, X } from 'lucide-react';
import QRCode from 'qrcode';
import { actionSchema, detailSchema, resultSchema, sensitiveActions, type ConsoleAction, type ConsoleResult, type ConsoleRow } from '../src/console-contract';
import { api, errorMessage, ApiError } from './api';
import { destructiveActions, forms, initialValues, toActionInput, validateFields } from './forms';
import { StepUpPrompt, stepUpRemaining } from './step-up';
import { FormField, fieldId } from './components/forms/form-field';
import { ResultView } from './components/forms/result-view';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { FieldGroup } from './components/ui/field';
import { Spinner } from './components/ui/spinner';

type Command = { operationId: string; input: ConsoleAction };

/** 对话框副标题：客户名 · 业务编号；人员显示用户名。 */
function subject(row: ConsoleRow): string {
  const parts = [row.customer, row.reference ?? row.orderReference].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length ? parts.join(' · ') : typeof (row.username ?? row.id) === 'string' ? String(row.username ?? row.id) : '';
}

/**
 * 所有写操作共用的对话框：填表 → （需要时）二次验证 → 提交 → 结果。
 * 同一次操作始终用同一个编号（operationId）：结果未知时只能查询或按原编号重试，二次验证通过后也按原编号继续。
 * syncSession：验证通过或服务端判定验证已过期时重新读取会话，让页头倒计时与服务端一致。
 */
export function ActionDialog({ action, row, csrf, verifiedAt, clockOffset, syncSession, close, changed }: {
  action: ConsoleAction['action']; row: ConsoleRow | null; csrf: string; verifiedAt: number; clockOffset: number; syncSession: () => void; close: () => void; changed: (result?: ConsoleResult, action?: ConsoleAction['action']) => void;
}) {
  const spec = forms[action];
  const prefix = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConsoleResult | null>(null);
  // 结果未知（网络中断或服务端未确认）的原操作：只能先查询，或按原编号重试。
  const [unknown, setUnknown] = useState<Command | null>(null);
  // 等待二次验证的原操作：验证通过后自动按原编号发出，表单内容不丢。
  const [awaiting, setAwaiting] = useState<Command | null>(null);
  const [values, setValues] = useState(() => initialValues(action, spec.fields, row));
  // 失去过焦点的字段，和点过提交以后的全部字段，才显示错误。
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  // actionSchema 把关时发现的问题：按字段标「格式不对」，对不上字段的放在表单顶部。
  const [schemaErrors, setSchemaErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const errors = { ...validateFields(spec.fields, values), ...schemaErrors };

  const [qr, setQr] = useState('');
  useEffect(() => {
    if (result?.paymentUrl) QRCode.toDataURL(result.paymentUrl, { width: 200, margin: 1 }).then(setQr, () => setError('二维码生成失败，请复制链接发给客户。'));
  }, [result?.paymentUrl]);
  // 付款链接弹窗打开期间每 5 秒读一次本地订单状态（不调支付宝），到账即提示。
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    const order = result?.paymentUrl ? result.id : undefined;
    if (!order || paid) return;
    const timer = window.setInterval(() => {
      api(`orders/${order}`, detailSchema).then(detail => { if (detail.item.paymentStatus === 'confirmed') { setPaid(true); changed(); } }, (cause: unknown) => setError(errorMessage(cause)));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [result, paid, changed]);
  // 激活码显示 60 秒后换成一句话，不再留在页面上。
  const hideSecret = useCallback(() => setResult(value => value ? { ...(value.id ? { id: value.id } : {}), message: '激活码已隐藏。' } : null), []);

  function change(key: string, value: string) {
    setValues(previous => ({ ...previous, [key]: value }));
    setSchemaErrors(previous => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }
  function focusFirstError(found: Record<string, string>) {
    const first = spec.fields.find(field => found[field.key]);
    if (first) document.getElementById(fieldId(prefix, first.key))?.focus();
  }

  async function send(command: Command) {
    setBusy(true);
    setError('');
    setAwaiting(null);
    try {
      const value = await api('commands', resultSchema, command, csrf);
      setResult(value);
      setUnknown(null);
      changed(value, action);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'STEP_UP_REQUIRED') { setAwaiting(command); syncSession(); return; }
      setError(errorMessage(cause));
      // 已知的拒绝没有副作用，改表单后重新提交即可；未知结果必须先查询原操作。
      setUnknown(cause instanceof ApiError && !['INTERNAL_ERROR', 'OPERATION_PENDING'].includes(cause.code) ? null : command);
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setFormError('');
    const found = validateFields(spec.fields, values);
    if (Object.keys(found).length) { focusFirstError(found); return; }
    const parsed = actionSchema.safeParse(toActionInput(action, row, spec.fields, values));
    if (!parsed.success) {
      const byField: Record<string, string> = {};
      let stray = false;
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && spec.fields.some(field => field.key === key && field.type !== 'hidden')) byField[key] = '格式不对';
        else stray = true;
      }
      setSchemaErrors(byField);
      if (stray) setFormError('有内容不符合要求，请检查后再提交。');
      focusFirstError(byField);
      return;
    }
    setSchemaErrors({});
    const command = { operationId: crypto.randomUUID(), input: parsed.data };
    // 超过二次验证有效期（consolePolicy.stepUpMs）未验证时先弹验证层，避免往返一次被拒。
    if (sensitiveActions.has(action) && stepUpRemaining(verifiedAt, clockOffset) <= 0) { setAwaiting(command); return; }
    void send(command);
  }
  async function query() {
    if (!unknown) return;
    setBusy(true);
    setError('');
    try {
      setResult(await api(`operations/${unknown.operationId}`, resultSchema));
      setUnknown(null);
      changed();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || Boolean(unknown) || Boolean(awaiting);
  const destructive = destructiveActions.has(action);
  const about = row ? subject(row) : '';
  return <Dialog open disablePointerDismissal onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-md">
      <div className="flex flex-col gap-1.5 pr-8">
        <DialogTitle className="leading-snug">{spec.title}</DialogTitle>
        {about && <p className="text-xs text-muted-foreground">{about}</p>}
        {!result && spec.note && <DialogDescription className="mt-1">{spec.note}</DialogDescription>}
      </div>
      {awaiting && <StepUpPrompt csrf={csrf} onVerified={() => { syncSession(); void send(awaiting); }} onCancel={() => setAwaiting(null)} />}
      {error && <Alert variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>}
      {result
        ? <ResultView result={result} qr={qr} paid={paid} onHideSecret={hideSecret} onDone={close} />
        : <form noValidate className="flex flex-col gap-4" onSubmit={submit}>
          {formError && <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>}
          <FieldGroup className="gap-4">
            {spec.fields.map(field => <FormField key={field.key} field={field} id={fieldId(prefix, field.key)} value={values[field.key] ?? ''} disabled={locked} clockOffset={clockOffset}
              error={submitted || touched.has(field.key) ? errors[field.key] : undefined}
              onChange={value => change(field.key, value)} onBlur={() => setTouched(previous => previous.has(field.key) ? previous : new Set(previous).add(field.key))} />)}
          </FieldGroup>
          {unknown && <Alert className="border-warning/40 bg-warning/10 text-warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-col gap-3 text-foreground">
              <p>结果未确认。请先查询原操作结果，再决定是否重试。</p>
              <span className="flex flex-wrap gap-2">
                <Button type="button" className="h-9" disabled={busy} onClick={() => { void query(); }}>查询结果</Button>
                <Button type="button" variant="outline" className="h-9" disabled={busy} onClick={() => { void send(unknown); }}>按原编号重试</Button>
              </span>
            </AlertDescription>
          </Alert>}
          {!awaiting && !unknown && <Button type="submit" size="lg" disabled={busy} data-destructive={destructive ? 'true' : undefined}
            className={destructive ? 'w-full bg-destructive text-white hover:bg-destructive/90 max-sm:h-10' : 'w-full max-sm:h-10'}>
            {busy ? <><Spinner aria-hidden="true" />正在处理…</> : spec.submit}
          </Button>}
        </form>}
      <DialogClose render={<Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" />} aria-label="关闭操作窗口" disabled={busy}>
        <X aria-hidden="true" />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
