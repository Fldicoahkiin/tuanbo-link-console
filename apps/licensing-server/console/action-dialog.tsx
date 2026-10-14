import { useEffect, useRef, useState, type FormEvent } from 'react';
import { X, Copy } from 'lucide-react';
import { actionSchema, resultSchema, type ConsoleAction, type ConsoleResult, type ConsoleRow } from '../src/console-contract';
import { api, errorMessage, ApiError, messageSchema } from './api';
import { destructiveActions, forms } from './forms';

export function ActionDialog({ action, row, csrf, close, changed }: { action: ConsoleAction['action']; row: ConsoleRow | null; csrf: string; close: () => void; changed: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<ConsoleResult | null>(null);
  const [pending, setPending] = useState<{ operationId: string; input: ConsoleAction } | null>(null); const [retry, setRetry] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const spec = forms[action];
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (!result?.secret) return; const timer = window.setTimeout(() => setResult(value => value ? { ...(value.id ? { id: value.id } : {}), message: '敏感凭据已自动隐藏。如需查看，请重新进行受保护的操作。' } : null), 60000); return () => window.clearTimeout(timer); }, [result?.secret]);
  async function send(command: { operationId: string; input: ConsoleAction }) {
    setBusy(true); setError('');
    try { setResult(await api('commands', resultSchema, command, csrf)); setPending(null); changed(); }
    catch (error) {
      setError(errorMessage(error)); setPending(command); setRetry(false);
      setNeedsVerification(error instanceof ApiError && error.code === 'STEP_UP_REQUIRED');
      // Known rejected requests have no side effect; unknown outcomes must be queried first.
      if (error instanceof ApiError && !['INTERNAL_ERROR', 'OPERATION_PENDING'].includes(error.code)) setRetry(true);
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { void send(pending); return; }
    try {
      const data = new FormData(event.currentTarget); const value: Record<string, unknown> = { action, ...(row?.id ? { id: row.id } : {}) };
      for (const field of spec.fields) {
        const entry = data.get(field.key); const raw = typeof entry === 'string' ? entry : '';
        value[field.key] = field.key === 'amountFen' ? Math.round(Number(raw) * 100) : field.type === 'number' ? Number(raw) : field.type === 'datetime-local' ? new Date(action === 'set-expiry' ? `${raw}+08:00` : raw).toISOString() : field.key === 'enabled' ? raw === 'true' : field.key === 'licenseId' ? raw || null : raw;
      }
      const input = actionSchema.parse(value); void send({ operationId: crypto.randomUUID(), input });
    } catch { setError('请检查必填字段、金额、数量、日期及编号格式。'); }
  }
  async function query() {
    if (!pending) return; setBusy(true); setError('');
    try { setResult(await api(`operations/${pending.operationId}`, resultSchema)); setPending(null); changed(); }
    catch (error) { setError(errorMessage(error)); setRetry(error instanceof ApiError && error.code === 'OPERATION_NOT_FOUND'); }
    finally { setBusy(false); }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    try { await api('verify', messageSchema, { code: data.get('code') }, csrf); setNeedsVerification(false); setRetry(true); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="action-dialog" onCancel={event => { if (busy) event.preventDefault(); else close(); }}><header><h2>{spec.title}</h2><button aria-label="关闭操作窗口" disabled={busy} onClick={close}><X size={18} /></button></header>
    <p className="muted">{spec.note}</p>{row?.id && <p className="identifier">对象：{row.id}</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {needsVerification && <form onSubmit={event => { void verify(event); }}><label>二次验证码或恢复码<input name="code" autoComplete="one-time-code" required /></label><button disabled={busy}>验证后继续原操作</button></form>}
    {result ? <div role="status"><p>{result.message}</p>{result.id && <p className="identifier">编号：{result.id}</p>}{result.expiresAt && <p>截止时间：{new Date(result.expiresAt).toLocaleString('zh-CN')}</p>}{result.secret && <><pre className="secret">{result.secret}</pre><button onClick={() => { void navigator.clipboard.writeText(result.secret!).then(() => setError('已复制，请仅交付给核实后的接收人。'), () => setError('浏览器拒绝复制，请手动选择凭据复制。')); }}><Copy size={16} />复制凭据</button><p className="muted">60 秒后自动隐藏。</p></>}<button className="primary" onClick={close}>完成</button></div> : <form ref={formRef} onSubmit={submit}>
      <fieldset disabled={busy || Boolean(pending)}>{spec.fields.map(field => <label key={field.key}>{field.label}{field.type === 'select' ? <select name={field.key} defaultValue={String(row?.[field.key] ?? field.options?.[0]?.[0] ?? '')}>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === 'textarea' ? <textarea name={field.key} required={!field.optional} maxLength={500} rows={3} /> : <input name={field.key} type={field.type ?? 'text'} required={!field.optional} step={field.key === 'amountFen' ? '0.01' : field.type === 'number' ? '1' : undefined} min={field.type === 'number' ? field.key === 'amountFen' ? '0.01' : '1' : undefined} max={field.key === 'quantity' ? 100 : undefined} defaultValue={action === 'set-expiry' && field.key === 'useUntil' && typeof row?.useUntil === 'string' ? new Date(Date.parse(row.useUntil) + 8 * 3600000).toISOString().slice(0, 16) : field.key === 'quantity' ? 1 : field.key === 'amountFen' && action === 'fulfill' && typeof row?.amountFen === 'number' ? row.amountFen / 100 : undefined} autoComplete="off" />}</label>)}</fieldset>
      {pending && <div className="pending"><p>操作编号：<code>{pending.operationId}</code></p><button type="button" disabled={busy} onClick={() => { void query(); }}>查询原操作结果</button>{retry && <button type="button" disabled={busy} onClick={() => { setPending(null); setRetry(false); setError('已解除表单锁定。确认对象状态后再提交。'); }}>返回修改表单</button>}</div>}
      <button className={destructiveActions[action] ? 'danger-confirm' : 'primary'} disabled={busy || Boolean(pending && !retry)}>{busy ? '正在处理…' : pending ? '按原编号重试' : destructiveActions[action] ?? '确认执行'}</button>
    </form>}
  </dialog>;
}
