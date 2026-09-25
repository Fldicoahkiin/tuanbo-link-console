import { Button } from './Button';
import { ObsPreviewSetup } from './ObsPreviewSetup';
import { useState } from 'react';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';

export function ObsDeviceSettings({ url, password, onUrl, onPassword, disabled, onBusy, notify }: {
  notify: (message: string, tone?: 'info' | 'error') => void;
  onBusy: (busy: boolean) => void; url: string; password: string; onUrl: (value: string) => void; onPassword: (value: string) => void; disabled: boolean;
}): JSX.Element {
  const obs = useIntegrationStore((state) => state.obs);
  const profile = useIntegrationStore((state) => state.profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dirty = url !== profile?.obs.webSocketUrl || password !== '';
  const save = async (connect: boolean, autoConnect = profile?.obs.autoConnectOnLaunch !== false): Promise<boolean> => {
    if (disabled || busy) return false;
    setBusy(true); onBusy(true); setError(''); setSaved(false);
    try {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const next = { ...current, updatedAt: new Date().toISOString(), obs: { ...current.obs, webSocketUrl: url.trim(), autoConnectOnLaunch: autoConnect } };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next, ...(password !== '' || !profile ? { obsPassword: password } : {}) });
      useIntegrationStore.getState().setProfile(next); onPassword(''); setSaved(true);
      if (connect) {
        const result = await linkDesktopViewModel.connectObs();
        useIntegrationStore.getState().setObs(result);
        if (result.status === 'connected') useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
        else setError('OBS 连接未完成，请检查地址、密码和 OBS 的 WebSocket 服务。');
      }
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setBusy(false); onBusy(false); }
  };
  const disconnect = async (): Promise<void> => {
    setBusy(true); onBusy(true); setError('');
    try { await linkDesktopViewModel.disconnectObs(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); onBusy(false); }
  };
  return <section className="settings-section" aria-label="OBS 连接设置">
    <div className="device-section-heading"><h3>OBS Studio</h3><span role="status">{busy ? '连接处理中' : obs.status === 'connected' ? '已连接' : '未连接'}</span></div>
    <label className="settings-row"><span>WebSocket 地址</span><input aria-label="WebSocket 地址" value={url} disabled={disabled || busy} onChange={(event) => { onUrl(event.currentTarget.value); setSaved(false); }} /></label>
    <label className="settings-row"><span>密码</span><input aria-label="OBS 密码" type="password" autoComplete="new-password" placeholder="留空则不更换" value={password} disabled={disabled || busy} onChange={(event) => { onPassword(event.currentTarget.value); setSaved(false); }} /></label>
    <label className="settings-row"><span>启动时自动连接</span><input aria-label="启动时自动连接 OBS" type="checkbox" checked={profile?.obs.autoConnectOnLaunch !== false} disabled={disabled || busy} onChange={(event) => void save(false, event.currentTarget.checked)} /></label>
    <p className="settings-note">启动时尝试一次：OBS 尚未运行时使用已配置的程序路径启动。暂时不可用时保持工作区可用，恢复后可手动重新连接。</p>
    <div className="device-actions settings-header-actions">{obs.status === 'connected' && !dirty ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void disconnect()}>断开 OBS</Button> : <Button className="primary-button" loading={busy} disabled={disabled || busy} onClick={() => void save(true)}>保存并连接 OBS</Button>}{dirty ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void save(false)}>仅保存 OBS</Button> : null}{saved ? <span role="status">已保存</span> : null}</div>
    {error ? <p className="device-error" role="alert">{error}</p> : null}
    <ObsPreviewSetup disabled={disabled || busy} notify={notify} beforeRepair={async () => {
      if (dirty && !await save(false)) throw new Error('OBS 配置保存失败，请检查地址后再次修复组件');
    }} />
  </section>;
}
