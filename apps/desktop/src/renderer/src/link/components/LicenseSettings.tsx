import { useEffect, useRef, useState } from 'react';
import { ZodError } from 'zod';
import { Download, Upload, RefreshCw, KeyRound, ChevronRight, ShoppingCart, Monitor, Eye, EyeOff } from 'lucide-react';
import { activationCodeSchema, licenseStatusSchema, type LicenseStatus } from '@tb/schema';
import { Button } from '../ui/Button';
import { PurchaseSettings } from './PurchaseSettings';

const stateLabels: Record<LicenseStatus['state'], string> = { unconfigured: '还没启用', inactive: '未激活', active: '已激活', expired: '已到期', invalid: '验证失败', 'renewal-required': '需要联网验证' };
const kindLabels = { perpetual: '买断授权', subscription: '订阅授权', trial: '试用授权' };
export function LicenseSettings({ runtimeActive, onAuthorized }: { runtimeActive: boolean; onAuthorized?: () => Promise<void> }): JSX.Element {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    const read = async (): Promise<void> => {
      try {
        const parsed = licenseStatusSchema.parse(await window.tbLink.getLicenseStatus());
        if (alive) setStatus(parsed);
      } catch (failure) {
        if (alive) setError(`读取授权失败，请完全退出软件后重新打开。${failure instanceof Error ? failure.message : String(failure)}`);
      }
    };
    void read();
    return () => { alive = false; };
  }, []);
  const run = async (action: 'refresh' | 'export' | 'import' | 'activate' | 'online'): Promise<void> => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'export') { if (await window.tbLink.exportLicenseRequest()) setMessage('本机信息已导出，可以发给售后核对授权。'); }
      else {
        const value = await (action === 'import' ? window.tbLink.importLicense() : action === 'activate' ? window.tbLink.activateLicenseCode(activationCodeSchema.parse(code)) : action === 'online' ? window.tbLink.refreshOnlineLicense() : window.tbLink.getLicenseStatus());
        if (value) {
          const parsed = licenseStatusSchema.parse(value);
          setStatus(parsed);
          if (parsed.state === 'active' && parsed.claims && parsed.claims.kind !== 'trial') await onAuthorized?.();
          if (action === 'import' || action === 'activate' || action === 'online') {
            if (parsed.state === 'active' && parsed.claims && parsed.claims.kind !== 'trial') {
              setMessage('授权已验证并保存到本机。');
              if (action === 'activate') { setCode(''); setShowCode(false); }
            } else setError(parsed.message || '授权没有生效，请检查激活码，或联系售后。');
          }
        }
      }
    } catch (failure) {
      const reason = failure instanceof ZodError ? failure.issues.map(issue => issue.message).join('；') : failure instanceof Error ? failure.message : String(failure);
      setError(reason);
      if (action === 'activate') codeInput.current?.focus();
      if (action === 'activate' || action === 'online') {
        try { setStatus(licenseStatusSchema.parse(await window.tbLink.getLicenseStatus())); }
        catch (readFailure) { setError(`${reason}。另外，读取当前授权状态也失败了：${readFailure instanceof Error ? readFailure.message : String(readFailure)}`); }
      }
    }
    finally { setBusy(false); }
  };
  const claims = status?.claims;
  return <section aria-label="本机授权" className="settings-section license-settings" aria-busy={busy}>
    <div className="device-section-heading license-status-heading"><h3>{onAuthorized ? '激活你的工作区' : '一台主机，一份授权'}</h3><span className="license-state" data-state={status?.state} role="status">{status ? stateLabels[status.state] : error ? '读取失败' : '正在读取…'}</span></div>
    <p className="settings-note">已有激活码？粘贴后即可在这台电脑上使用。</p>
    {status ? <>
      <form className="license-code-form" onSubmit={event => { event.preventDefault(); if (!busy && !runtimeActive && status.onlineAvailable) void run('activate'); }}>
        <label className="settings-path-row"><span>激活码</span><span className="license-code-input"><input ref={codeInput} aria-label="激活码" aria-invalid={error ? true : undefined} aria-describedby={error ? "license-activation-error" : undefined} type={showCode ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={36} value={code} placeholder="TBA- 开头的完整激活码" disabled={busy || runtimeActive || !status.onlineAvailable} onChange={event => setCode(event.target.value.trim())} /><Button type="button" aria-label={showCode ? '隐藏激活码' : '显示激活码'} aria-pressed={showCode} onClick={() => setShowCode(value => !value)}>{showCode ? <EyeOff /> : <Eye />}</Button></span></label>
        <div className="settings-header-actions"><Button type="submit" className="primary-button" disabled={busy || runtimeActive || !status.onlineAvailable || !code.trim()}><KeyRound />激活本机</Button><Button type="button" className="secondary-button" disabled={busy || runtimeActive || !status.onlineAvailable} onClick={() => void run('online')}><RefreshCw />联网验证授权</Button></div>
      </form>
      {message ? <p className="license-feedback" role="status">{message}</p> : null}
      {error ? <p id="license-activation-error" className="device-error license-feedback" role="alert">{error}</p> : null}
      {!status.onlineAvailable ? <p className="settings-note">在线授权服务还没开通，请联系售后。</p> : <p className="settings-note license-assurance">一码一机 · 无需注册账户<br />启动时联网验证，演出中断网不影响运行。</p>}
      {claims ? <dl className="license-claims"><dt>授权客户</dt><dd>{claims.customer}</dd><dt>授权类型</dt><dd>{kindLabels[claims.kind]}</dd><dt>使用期限</dt><dd>{claims.useUntil ? new Date(claims.useUntil).toLocaleString('zh-CN') : '永久使用'}</dd><dt>升级服务截止</dt><dd>{new Date(claims.updatesUntil).toLocaleString('zh-CN')}</dd></dl> : null}
      {claims?.online ? <p className="settings-note">本次验证有效至 {new Date(claims.online.leaseUntil).toLocaleString('zh-CN')}。下次启动仍需联网验证；演出过程中断网不会影响运行。</p> : null}
      <details className="license-disclosure">
        <summary><ShoppingCart aria-hidden="true" /><span>购买授权与查询订单</span><ChevronRight className="license-disclosure-chevron" aria-hidden="true" /></summary>
      <PurchaseSettings runtimeActive={runtimeActive || busy || !status.onlineAvailable} license={claims ?? null} onSelectCode={value => { setCode(value); codeInput.current?.focus(); }} />
      </details>
      <details className="license-disclosure">
        <summary><Monitor aria-hidden="true" /><span>本机信息与授权文件</span><ChevronRight className="license-disclosure-chevron" aria-hidden="true" /></summary>
        <label className="settings-path-row"><span>本机机器码</span><input aria-label="本机机器码" readOnly value={status.machineCode} onFocus={event => event.currentTarget.select()} /></label>
        <p className="settings-note">{status.message}</p>
        <div className="settings-header-actions"><Button className="secondary-button" disabled={busy} onClick={() => void run('export')}><Download />导出授权申请</Button><Button className="secondary-button" disabled={busy || runtimeActive || status.onlineAvailable} onClick={() => void run('import')}><Upload />导入授权文件</Button><Button className="secondary-button" disabled={busy} onClick={() => void run('refresh')}><RefreshCw />刷新状态</Button></div>
      </details>
      <p className="settings-note license-legal">激活后即可使用全部功能。开票、换电脑和售后问题，请通过官网联系我们。</p>
      {runtimeActive ? <p className="settings-note">请停止播放后再更换授权。</p> : null}
    </> : error ? <Button className="secondary-button" disabled={busy} onClick={() => void run('refresh')}>重新读取</Button> : null}
    {!status && error ? <p className="device-error" role="alert">{error}</p> : null}
  </section>;
}
