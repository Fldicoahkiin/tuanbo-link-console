import { useEffect, useRef, useState, type FormEvent } from 'react';
import { X, Copy, ExternalLink } from 'lucide-react';
import QRCode from 'qrcode';
import { actionSchema, detailSchema, resultSchema, sensitiveActions, type ConsoleAction, type ConsoleResult, type ConsoleRow } from '../src/console-contract';
import { api, errorMessage, ApiError } from './api';
import { beijingTime, destructiveActions, forms, type Field } from './forms';
import { StepUpPrompt, stepUpRemaining } from './step-up';

type Command = { operationId: string; input: ConsoleAction };
const other = '__other';
/** 对话框副标题：客户名 · 业务编号；人员显示用户名。 */
function subject(row: ConsoleRow): string {
  const parts = [row.customer, row.reference ?? row.orderReference].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length ? parts.join(' · ') : typeof (row.username ?? row.id) === 'string' ? String(row.username ?? row.id) : '';
}
function fieldError(field: Field, element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  if (element.validity.valueMissing) return `请填写${field.label.replace(/（.*）$/, '')}`;
  if (element.validity.rangeUnderflow || element.validity.rangeOverflow || element.validity.stepMismatch) return field.type === 'money' ? '金额至少 0.01 元，最多两位小数' : '超出允许范围';
  if (element.validity.badInput || element.validity.typeMismatch || element.validity.patternMismatch) return '格式不对';
  return '';
}
function Input({ action, field, row, touched, onTouch, errors }: { action: ConsoleAction['action']; field: Field; row: ConsoleRow | null; touched: boolean; onTouch: () => void; errors: Record<string, string> }) {
  // 预设项可由入口预先选好（如「开通第二名管理员」预选「备用管理员」）。
  const [choice, setChoice] = useState(() => field.options?.some(([value]) => value === row?.[field.key]) ? String(row?.[field.key]) : '');
  if (field.type === 'hidden') return <input type="hidden" name={field.key} value={String(row?.[field.key] ?? '')} />;
  const required = !field.optional; const error = touched ? errors[field.key] : '';
  const common = { name: field.key, required, onBlur: onTouch, 'aria-invalid': Boolean(error) || undefined };
  const defaultValue = action === 'set-expiry' && field.key === 'useUntil' && typeof row?.useUntil === 'string' ? new Date(Date.parse(row.useUntil) + 8 * 3600000).toISOString().slice(0, 16)
    : field.key === 'quantity' ? 1 : field.type === 'money' && action === 'fulfill' && typeof row?.amountFen === 'number' ? row.amountFen / 100 : undefined;
  let control;
  if (field.type === 'select') control = <select {...common} defaultValue={String(row?.[field.key] ?? field.options?.[0]?.[0] ?? '')}>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>;
  // 这个下拉不交给 React 管值（defaultValue）：浏览器先发 input 再发 change，表单在 input 时重新校验并重画，受控的下拉会在两个事件之间被改回旧值，选了又弹回「请选择」。
  else if (field.type === 'preset') control = <><select {...common} defaultValue={choice} onChange={event => setChoice(event.target.value)}>{required ? <option value="" disabled>请选择</option> : <option value="">不写</option>}{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value={other}>其他</option></select>
    {choice === other && <input name={`${field.key}Other`} required maxLength={field.maxLength ?? 500} placeholder="请写明" aria-label={`${field.label}（其他）`} autoComplete="off" />}</>;
  else if (field.type === 'textarea') control = <textarea {...common} maxLength={field.maxLength ?? 500} rows={2} />;
  else if (field.type === 'money') control = <span className="money-input"><input {...common} type="number" inputMode="decimal" step="0.01" min="0.01" defaultValue={defaultValue} autoComplete="off" /><span aria-hidden="true">元</span></span>;
  else control = <input {...common} type={field.type ?? 'text'} step={field.type === 'number' ? '1' : undefined} min={field.type === 'number' ? '1' : undefined} max={field.key === 'quantity' ? 100 : undefined} maxLength={field.type ? undefined : field.maxLength ?? 160} defaultValue={defaultValue} autoComplete="off" />;
  return <label className={error ? 'has-error' : undefined}>{field.label}{control}{error && <span className="field-error">{error}</span>}</label>;
}

/** syncSession：验证通过或服务端判定验证已过期时重新读取会话，让页头倒计时与服务端一致。 */
export function ActionDialog({ action, row, csrf, verifiedAt, clockOffset, syncSession, close, changed }: {
  action: ConsoleAction['action']; row: ConsoleRow | null; csrf: string; verifiedAt: number; clockOffset: number; syncSession: () => void; close: () => void; changed: (result?: ConsoleResult, action?: ConsoleAction['action']) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null); const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<ConsoleResult | null>(null);
  // 结果未知（网络中断或服务端未确认）的原操作：只能先查询，或按原编号重试。
  const [unknown, setUnknown] = useState<Command | null>(null);
  // 等待二次验证的原操作：验证通过后自动按原编号发出，表单内容不丢。
  const [awaiting, setAwaiting] = useState<Command | null>(null);
  const [valid, setValid] = useState(false); const [errors, setErrors] = useState<Record<string, string>>({}); const [touched, setTouched] = useState<Set<string>>(new Set());
  const spec = forms[action];
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (!result?.secret) return; const timer = window.setTimeout(() => setResult(value => value ? { ...(value.id ? { id: value.id } : {}), message: '激活码已隐藏。' } : null), 60000); return () => window.clearTimeout(timer); }, [result?.secret]);
  const [qr, setQr] = useState('');
  useEffect(() => { if (result?.paymentUrl) QRCode.toDataURL(result.paymentUrl, { width: 200, margin: 1 }).then(setQr, () => setError('二维码生成失败，请复制链接发给客户。')); }, [result?.paymentUrl]);
  // 付款链接弹窗打开期间每 5 秒读一次本地订单状态（不调支付宝），到账即提示。
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    const order = result?.paymentUrl ? result.id : undefined; if (!order || paid) return;
    const timer = window.setInterval(() => { api(`orders/${order}`, detailSchema).then(detail => { if (detail.item.paymentStatus === 'confirmed') { setPaid(true); changed(); } }, (cause: unknown) => setError(errorMessage(cause))); }, 5000);
    return () => window.clearInterval(timer);
  }, [result, paid, changed]);
  const copy = (text: string) => { void navigator.clipboard.writeText(text).then(() => setError('已复制。'), () => setError('浏览器拒绝复制，请手动选择复制。')); };
  function validate() {
    const form = formRef.current; if (!form) return;
    setValid(form.checkValidity());
    setErrors(Object.fromEntries(spec.fields.map(field => { const element = form.elements.namedItem(field.key); return [field.key, element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? fieldError(field, element) : '']; })));
  }
  useEffect(validate, [spec.fields]);
  async function send(command: Command) {
    setBusy(true); setError(''); setAwaiting(null);
    try { const value = await api('commands', resultSchema, command, csrf); setResult(value); setUnknown(null); changed(value, action); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'STEP_UP_REQUIRED') { setAwaiting(command); syncSession(); return; }
      setError(errorMessage(cause));
      // 已知的拒绝没有副作用，改表单后重新提交即可；未知结果必须先查询原操作。
      setUnknown(cause instanceof ApiError && !['INTERNAL_ERROR', 'OPERATION_PENDING'].includes(cause.code) ? null : command);
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const value: Record<string, unknown> = { action, ...(row?.id ? { id: row.id } : {}) };
    for (const field of spec.fields) {
      const entry = data.get(field.key); let raw = typeof entry === 'string' ? entry : '';
      if (field.type === 'preset' && raw === other) { const written = data.get(`${field.key}Other`); raw = typeof written === 'string' ? written : ''; }
      value[field.key] = field.type === 'money' ? Math.round(Number(raw) * 100) : field.type === 'number' ? Number(raw) : field.type === 'datetime-local' ? new Date(`${raw}+08:00`).toISOString() : field.key === 'enabled' ? raw === 'true' : field.key === 'licenseId' ? raw || null : raw;
    }
    const parsed = actionSchema.safeParse(value);
    if (!parsed.success) { setError('请检查标红的字段。'); return; }
    const command = { operationId: crypto.randomUUID(), input: parsed.data };
    // 超过二次验证有效期（consolePolicy.stepUpMs）未验证时先弹验证层，避免往返一次被拒。
    if (sensitiveActions.has(action) && stepUpRemaining(verifiedAt, clockOffset) <= 0) { setAwaiting(command); return; }
    void send(command);
  }
  async function query() {
    if (!unknown) return; setBusy(true); setError('');
    try { setResult(await api(`operations/${unknown.operationId}`, resultSchema)); setUnknown(null); changed(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  const locked = busy || Boolean(unknown) || Boolean(awaiting);
  return <dialog ref={dialog} className="action-dialog" aria-label={spec.title} onCancel={event => { if (busy) event.preventDefault(); else close(); }}>
    <header><div><h2>{spec.title}</h2>{row && subject(row) && <p className="dialog-subject">{subject(row)}</p>}</div><button aria-label="关闭操作窗口" disabled={busy} onClick={close}><X size={18} /></button></header>
    {!result && spec.note && <p className="dialog-note">{spec.note}</p>}
    {awaiting && <StepUpPrompt csrf={csrf} onVerified={() => { syncSession(); void send(awaiting); }} onCancel={() => setAwaiting(null)} />}
    {error && <p className="alert" role="alert">{error}</p>}
    {result ? <div role="status" className="dialog-result"><p>{result.message}</p>
      {result.expiresAt && <p className="muted">有效期至 {beijingTime(result.expiresAt)}</p>}
      {result.paymentUrl && paid && <p className="paid-notice" role="status">已付款，已发码。</p>}
      {result.paymentUrl && !paid && <div className="payment-link">{qr && <img src={qr} width={200} height={200} alt="支付宝付款二维码" />}<div className="actions"><button onClick={() => copy(result.paymentUrl!)}><Copy size={16} />复制链接</button><a className="button" href={result.paymentUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开付款页</a></div></div>}
      {result.secret && <><pre className="secret">{result.secret}</pre><button onClick={() => copy(result.secret!)}><Copy size={16} />复制</button><p className="muted">60 秒后自动隐藏。</p></>}
      <button className="primary" onClick={close}>完成</button></div>
      : <form ref={formRef} onSubmit={submit} onInput={validate} onChange={validate} noValidate>
        <fieldset disabled={locked}>{spec.fields.map(field => <Input key={field.key} action={action} field={field} row={row} errors={errors} touched={touched.has(field.key)} onTouch={() => setTouched(previous => new Set(previous).add(field.key))} />)}</fieldset>
        {unknown && <div className="pending"><p>结果未确认。请先查询原操作结果，再决定是否重试。</p><div className="actions"><button type="button" disabled={busy} onClick={() => { void query(); }}>查询结果</button><button type="button" disabled={busy} onClick={() => { void send(unknown); }}>按原编号重试</button></div></div>}
        {!awaiting && !unknown && <button className={destructiveActions.has(action) ? 'danger-confirm' : 'primary'} disabled={busy || !valid}>{busy ? '正在处理…' : spec.submit}</button>}
      </form>}
  </dialog>;
}
