import { useEffect, useRef, useState } from 'react';
import { Download, Upload, RefreshCw, KeyRound } from 'lucide-react';
import { activationCodeSchema, licenseStatusSchema, type LicenseStatus } from '@tb/schema';
import { Button } from './Button';
import { PurchaseSettings } from './PurchaseSettings';

const stateLabels: Record<LicenseStatus['state'], string> = { unconfigured: '尚未启用', inactive: '未激活', active: '已激活', expired: '已到期', invalid: '校验失败', 'renewal-required': '需要联网验证' };
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
        if (alive) setError(`读取授权失败，请完整退出并重新打开软件后重试。${failure instanceof Error ? failure.message : String(failure)}`);
      }
    };
    void read();
    return () => { alive = false; };
  }, []);
  const run = async (action: 'refresh' | 'export' | 'import' | 'activate' | 'online'): Promise<void> => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'export') { if (await window.tbLink.exportLicenseRequest()) setMessage('机器信息已导出，可用于向发行方核对授权。'); }
      else {
        const value = await (action === 'import' ? window.tbLink.importLicense() : action === 'activate' ? window.tbLink.activateLicenseCode(activationCodeSchema.parse(code)) : action === 'online' ? window.tbLink.refreshOnlineLicense() : window.tbLink.getLicenseStatus());
        if (value) {
          const parsed = licenseStatusSchema.parse(value);
          setStatus(parsed);
          if (parsed.state === 'active' && parsed.claims && parsed.claims.kind !== 'trial') await onAuthorized?.();
          if (action === 'import' || action === 'activate' || action === 'online') setMessage('授权已验证并保存到本机。');
          if (action === 'activate') setCode('');
        }
      }
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      setError(reason);
      if (action === 'activate' || action === 'online') {
        try { setStatus(licenseStatusSchema.parse(await window.tbLink.getLicenseStatus())); }
        catch (readFailure) { setError(`${reason}；读取当前授权状态失败：${readFailure instanceof Error ? readFailure.message : String(readFailure)}`); }
      }
    }
    finally { setBusy(false); }
  };
  const claims = status?.claims;
  return <section aria-label="本机授权" className="settings-section">
    <div className="device-section-heading"><h3>一台主机，一份授权</h3><span role="status">{status ? stateLabels[status.state] : error ? '读取失败' : '正在读取…'}</span></div>
    <p className="settings-note">个人与企业均按机器授权，无需注册操作员账户。企业批量购买后，每台电脑使用独立激活码；换机需办理迁移。</p>
    {status ? <>
      <label className="settings-path-row"><span>本机机器码</span><input aria-label="本机机器码" readOnly value={status.machineCode} onFocus={event => event.currentTarget.select()} /></label>
      <p className="settings-note">{status.message}</p>
      <form onSubmit={event => { event.preventDefault(); if (!busy && !runtimeActive && status.onlineAvailable) void run('activate'); }}>
        <label className="settings-path-row"><span>激活码</span><input ref={codeInput} aria-label="激活码" type="password" autoComplete="off" spellCheck={false} maxLength={36} value={code} placeholder="TBA-…" disabled={busy || runtimeActive || !status.onlineAvailable} onChange={event => setCode(event.target.value)} /></label>
        <div className="settings-header-actions"><Button type="submit" className="primary-button" disabled={busy || runtimeActive || !status.onlineAvailable || !code.trim()}><KeyRound />激活本机</Button><Button type="button" className="secondary-button" disabled={busy || runtimeActive || !status.onlineAvailable} onClick={() => void run('online')}><RefreshCw />联网验证授权</Button></div>
      </form>
      {!status.onlineAvailable ? <p className="settings-note">发行方尚未配置在线授权服务，请联系发行方。</p> : <p className="settings-note">每次启动会联网核对激活码和机器码，通过后才能进入工作区。激活码在本机加密保存；验证失败请检查网络后手动重试，工程和已有凭证不会被删除。</p>}
      {claims ? <dl><dt>授权客户</dt><dd>{claims.customer}</dd><dt>授权类型</dt><dd>{kindLabels[claims.kind]}</dd><dt>使用期限</dt><dd>{claims.useUntil ? new Date(claims.useUntil).toLocaleString('zh-CN') : '永久使用'}</dd><dt>升级服务截止</dt><dd>{new Date(claims.updatesUntil).toLocaleString('zh-CN')}</dd></dl> : null}
      {claims?.online ? <p className="settings-note">本次签名凭证有效至 {new Date(claims.online.leaseUntil).toLocaleString('zh-CN')}。该期限不免除下次启动的联网验证；运行中的演出不会因网络中断而停止。</p> : null}
      <div className="settings-header-actions"><Button className="secondary-button" disabled={busy} onClick={() => void run('export')}><Download />导出授权申请</Button><Button className="primary-button" disabled={busy || runtimeActive || status.onlineAvailable} onClick={() => void run('import')}><Upload />导入授权文件</Button><Button className="secondary-button" disabled={busy} onClick={() => void run('refresh')}><RefreshCw />刷新状态</Button></div>
      <p className="settings-note">本软件所有产品功能均需付费激活，不提供免费版或试用。开票、换机及售后请联系发行方。</p>
      <PurchaseSettings runtimeActive={runtimeActive || busy || !status.onlineAvailable} license={claims ?? null} onSelectCode={value => { setCode(value); codeInput.current?.focus(); }} />
      {runtimeActive ? <p className="settings-note">请停止播放后再更换授权。</p> : null}
    </> : error ? <Button className="secondary-button" disabled={busy} onClick={() => void run('refresh')}>重新读取</Button> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className="device-error" role="alert">{error}</p> : null}
  </section>;
}
