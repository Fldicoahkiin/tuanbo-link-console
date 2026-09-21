import { useEffect, useState } from 'react';
import { Download, Upload, RefreshCw } from 'lucide-react';
import { licenseStatusSchema, type LicenseStatus } from '@tb/schema';
import { Button } from './Button';

const stateLabels: Record<LicenseStatus['state'], string> = { unconfigured: '尚未启用', inactive: '未激活', active: '已激活', expired: '已到期', invalid: '校验失败' };
const kindLabels = { perpetual: '买断授权', subscription: '订阅授权', trial: '试用授权' };
export function LicenseSettings({ runtimeActive }: { runtimeActive: boolean }): JSX.Element {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
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
  const run = async (action: 'refresh' | 'export' | 'import'): Promise<void> => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'export') { if (await window.tbLink.exportLicenseRequest()) setMessage('授权申请已导出，请交给发行方签发本机授权。'); }
      else {
        const value = await (action === 'import' ? window.tbLink.importLicense() : window.tbLink.getLicenseStatus());
        if (value) { setStatus(licenseStatusSchema.parse(value)); if (action === 'import') setMessage('授权已验证并保存到本机。'); }
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const claims = status?.claims;
  return <section aria-label="本机授权" className="settings-section">
    <div className="device-section-heading"><h3>一台主机，一份授权</h3><span role="status">{status ? stateLabels[status.state] : error ? '读取失败' : '正在读取…'}</span></div>
    <p className="settings-note">买断与订阅均绑定本机。其他电脑需要单独授权，换机需办理授权迁移。</p>
    {status ? <>
      <label className="settings-path-row"><span>本机机器码</span><input aria-label="本机机器码" readOnly value={status.machineCode} onFocus={event => event.currentTarget.select()} /></label>
      <p className="settings-note">{status.message}</p>
      {claims ? <dl><dt>授权客户</dt><dd>{claims.customer}</dd><dt>授权类型</dt><dd>{kindLabels[claims.kind]}</dd><dt>使用期限</dt><dd>{claims.useUntil ? new Date(claims.useUntil).toLocaleString('zh-CN') : '永久使用'}</dd><dt>升级服务截止</dt><dd>{new Date(claims.updatesUntil).toLocaleString('zh-CN')}</dd></dl> : null}
      <div className="settings-header-actions"><Button className="secondary-button" disabled={busy} onClick={() => void run('export')}><Download />导出授权申请</Button><Button className="primary-button" disabled={busy || runtimeActive} onClick={() => void run('import')}><Upload />导入授权文件</Button><Button className="secondary-button" disabled={busy} onClick={() => void run('refresh')}><RefreshCw />刷新状态</Button></div>
      <p className="settings-note">当前为授权验证阶段，尚未启用收费限制或在线购买。</p>
      {runtimeActive ? <p className="settings-note">请停止播放后再更换授权。</p> : null}
    </> : error ? <Button className="secondary-button" disabled={busy} onClick={() => void run('refresh')}>重新读取</Button> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className="device-error" role="alert">{error}</p> : null}
  </section>;
}
