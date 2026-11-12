import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { consolePolicy } from '../src/console-contract';
import { api, ApiError, errorMessage, messageSchema } from './api';

/** 二次验证有效期，和服务端一样读 consolePolicy。 */
const stepUpWindow = consolePolicy.stepUpMs;
export const stepUpMinutes = consolePolicy.stepUpMs / 60000;
export const stepUpRemaining = (verifiedAt: number, clockOffset: number) => verifiedAt + stepUpWindow - (Date.now() + clockOffset);

/** 6 位验证码：调出数字键盘，输满自动提交；输错时抖动并清空。恢复码是次要入口，点了才换成长输入框。 */
export function OneTimeCode({ label = '验证器验证码', allowRecovery, recoverySubmit, onComplete, failures, disabled, autoFocus }: {
  label?: string; allowRecovery: boolean; recoverySubmit?: string; onComplete: (code: string) => void; failures: number; disabled: boolean; autoFocus?: boolean;
}) {
  const [recovery, setRecovery] = useState(false); const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!failures) return;
    setValue(''); const field = input.current; if (!field) return;
    field.classList.remove('shake'); void field.offsetWidth; field.classList.add('shake'); field.focus();
  }, [failures]);
  return <div className="otp-field">
    {recovery
      ? <label>恢复码<input ref={input} name="code" value={value} onChange={event => setValue(event.target.value.trim())} autoComplete="off" spellCheck={false} required minLength={6} maxLength={100} disabled={disabled} autoFocus /></label>
      : <label>{label}<input ref={input} className="otp" name="code" value={value} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={disabled} autoFocus={autoFocus}
        onChange={event => { const digits = event.target.value.replace(/\D/g, '').slice(0, 6); setValue(digits); if (digits.length === 6) onComplete(digits); }} /></label>}
    {recovery && recoverySubmit && <button className="primary" disabled={disabled}>{recoverySubmit}</button>}
    {allowRecovery && <button type="button" className="text-button" disabled={disabled} onClick={() => { setRecovery(!recovery); setValue(''); }}>{recovery ? '改用验证器验证码' : '改用恢复码'}</button>}
  </div>;
}

/** 敏感操作前的验证层：验证通过后由调用方自动继续原操作。 */
export function StepUpPrompt({ csrf, onVerified, onCancel, title = '需要二次验证', hint = `敏感操作需在 ${stepUpMinutes} 分钟内验证过，验证后自动继续。` }: { csrf: string; onVerified: () => void; onCancel?: () => void; title?: string; hint?: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [failures, setFailures] = useState(0);
  async function verify(code: string) {
    setBusy(true); setError('');
    try { await api('verify', messageSchema, { code }, csrf); onVerified(); }
    catch (cause) { setError(cause instanceof ApiError && cause.code === 'INVALID_CODE' ? '验证码不对或已用过，请输入下一枚' : errorMessage(cause)); setFailures(count => count + 1); }
    finally { setBusy(false); }
  }
  return <form className="step-up" aria-label="二次验证" onSubmit={event => { event.preventDefault(); const code = new FormData(event.currentTarget).get('code'); if (typeof code === 'string') void verify(code); }}>
    <p className="step-up-title"><ShieldCheck size={16} aria-hidden="true" />{title}</p>
    <p className="muted">{hint}</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    <OneTimeCode allowRecovery recoverySubmit="验证" onComplete={code => { void verify(code); }} failures={failures} disabled={busy} autoFocus />
    {onCancel && <button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button>}
  </form>;
}

/** 页头常驻状态：有效时倒计时，未验证时可点击提前验证。 */
export function StepUpBadge({ verifiedAt, clockOffset, onVerify }: { verifiedAt: number; clockOffset: number; onVerify: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => tick(value => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  const left = stepUpRemaining(verifiedAt, clockOffset);
  if (left <= 0) return <button className="step-up-badge" title={`点击提前验证，之后 ${stepUpMinutes} 分钟内敏感操作无需再输验证码`} onClick={onVerify}><ShieldCheck size={14} aria-hidden="true" />二次验证：未验证</button>;
  const seconds = Math.ceil(left / 1000);
  return <span className="step-up-badge verified" title={`${stepUpMinutes} 分钟内的敏感操作无需再输验证码`}><ShieldCheck size={14} aria-hidden="true" />二次验证：有效（{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}）</span>;
}

/** 从页头标签提前验证。 */
export function StepUpDialog({ csrf, onVerified, close }: { csrf: string; onVerified: () => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="action-dialog step-up-dialog" onCancel={close}>
    <StepUpPrompt csrf={csrf} title="提前验证" hint={`验证后 ${stepUpMinutes} 分钟内的敏感操作无需再输验证码。`} onVerified={onVerified} onCancel={close} />
  </dialog>;
}
