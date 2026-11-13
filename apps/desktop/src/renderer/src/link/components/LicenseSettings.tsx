import { useEffect, useRef, useState } from 'react';
import { ZodError } from 'zod';
import { Download, Upload, RefreshCw, KeyRound } from 'lucide-react';
import { activationCodeSchema, licenseStatusSchema, type LicenseStatus } from '@tb/schema';
import { Button, Card, Disclosure, Field, Notice, PasswordInput, StatusBadge, TextInput } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
import { PurchaseSettings } from './PurchaseSettings';

const stateLabels: Record<LicenseStatus['state'], string> = { unconfigured: '还没启用', inactive: '未激活', active: '已激活', expired: '已到期', invalid: '验证失败', 'renewal-required': '需要联网验证' };
const kindLabels = { perpetual: '买断授权', subscription: '订阅授权', trial: '试用授权' };
export function LicenseSettings({ runtimeActive, onAuthorized }: { runtimeActive: boolean; onAuthorized?: () => Promise<void> }): JSX.Element {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
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
              if (action === 'activate') setCode('');
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
  const badge: ConnectionStatus = status ? { state: status.state === 'active' ? 'ready' : status.state === 'inactive' || status.state === 'unconfigured' ? 'idle' : status.state === 'renewal-required' ? 'warning' : 'error', value: stateLabels[status.state], detail: status.message }
    : error ? { state: 'error', value: '读取失败', detail: error } : { state: 'checking', value: '正在读取…', detail: '正在读取本机授权' };
  const locked = busy || runtimeActive || !status?.onlineAvailable;
  return <section aria-label="本机授权" className="settings-stack license-settings" aria-busy={busy}>
    <Card title={onAuthorized ? '激活你的工作区' : '一台主机，一份授权'} description="已有激活码？粘贴后就能在这台电脑上用。" actions={<StatusBadge name="本机授权" status={badge} />}>
      {status ? <>
        <form className="settings-stack" onSubmit={event => { event.preventDefault(); if (!locked) void run('activate'); }}>
          <Field label="激活码" stacked={Boolean(onAuthorized)}>{props => <PasswordInput {...props} ref={codeInput} secret="激活码" aria-label="激活码" aria-invalid={error ? true : undefined} maxLength={36} value={code} placeholder="TBA- 开头的完整激活码" disabled={locked} onChange={event => setCode(event.target.value.trim())} />}</Field>
          <div className="settings-actions-row">
            <Button type="submit" variant="primary" icon={KeyRound} disabled={locked || !code.trim()}>激活本机</Button>
            <Button type="button" variant="secondary" icon={RefreshCw} disabled={locked} onClick={() => void run('online')}>联网验证授权</Button>
          </div>
        </form>
        {message ? <Notice tone="success">{message}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>{status.onlineAvailable ? '一码一机，不用注册账户。启动时联网验证，演出中断网不影响运行。' : '在线授权服务还没开通，请联系售后。'}</p>
        {claims ? <dl className="settings-facts"><dt>授权客户</dt><dd>{claims.customer}</dd><dt>授权类型</dt><dd>{kindLabels[claims.kind]}</dd><dt>使用期限</dt><dd>{claims.useUntil ? new Date(claims.useUntil).toLocaleString('zh-CN') : '永久使用'}</dd><dt>升级服务截止</dt><dd>{new Date(claims.updatesUntil).toLocaleString('zh-CN')}</dd></dl> : null}
        {claims?.online ? <p>本次验证有效至 {new Date(claims.online.leaseUntil).toLocaleString('zh-CN')}。下次启动仍要联网验证；演出过程中断网不影响运行。</p> : null}
        {runtimeActive ? <Notice>停止播放后再更换授权。</Notice> : null}
      </> : error ? <>
        <Notice tone="error">{error}</Notice>
        <div className="settings-actions-row"><Button variant="secondary" disabled={busy} onClick={() => void run('refresh')}>重新读取</Button></div>
      </> : null}
    </Card>
    {status ? <>
      <Disclosure className="license-disclosure" title="购买授权与查询订单">
        <PurchaseSettings runtimeActive={runtimeActive || busy || !status.onlineAvailable} stacked={Boolean(onAuthorized)} license={claims ?? null} onSelectCode={value => { setCode(value); codeInput.current?.focus(); }} />
      </Disclosure>
      <Disclosure className="license-disclosure" title="本机信息与授权文件">
        <Field label="本机机器码" stacked={Boolean(onAuthorized)}>{props => <TextInput {...props} aria-label="本机机器码" readOnly value={status.machineCode} onFocus={event => event.currentTarget.select()} />}</Field>
        <p>{status.message}</p>
        <div className="settings-actions-row">
          <Button variant="secondary" icon={Download} disabled={busy} onClick={() => void run('export')}>导出授权申请</Button>
          <Button variant="secondary" icon={Upload} disabled={busy || runtimeActive || status.onlineAvailable} onClick={() => void run('import')}>导入授权文件</Button>
          <Button variant="ghost" icon={RefreshCw} disabled={busy} onClick={() => void run('refresh')}>刷新状态</Button>
        </div>
      </Disclosure>
      <p className="settings-footnote">激活后就能用全部功能。开票、换电脑和售后问题，请通过官网联系我们。</p>
    </> : null}
  </section>;
}
