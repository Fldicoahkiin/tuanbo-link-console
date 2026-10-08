import { Button } from './Button';
import { ObsPreviewSetup } from './ObsPreviewSetup';
import { useState } from 'react';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { toUserErrorMessage } from '@tb/core/link';
import { obsWebSocketUrlSchema, localObsConnectionResultSchema } from '@tb/schema';

export function ObsDeviceSettings({ url, password, onUrl, onPassword, disabled, onBusy, notify }: {
  notify: (message: string, tone?: 'info' | 'error') => void;
  onBusy: (busy: boolean) => void; url: string; password: string; onUrl: (value: string) => void; onPassword: (value: string) => void; disabled: boolean;
}): JSX.Element {
  const obs = useIntegrationStore((state) => state.obs);
  const sourceSizeErrors = useIntegrationStore((state) => state.inventory?.sourceSizeErrors);
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
      const parsedAddress = obsWebSocketUrlSchema.safeParse(url);
      if (!parsedAddress.success) throw new Error(parsedAddress.error.issues.map(issue => issue.message).join('；'));
      onUrl(parsedAddress.data);
      const next = { ...current, updatedAt: new Date().toISOString(), obs: { ...current.obs, connectionMethod: 'manual' as const, webSocketUrl: parsedAddress.data, autoConnectOnLaunch: autoConnect } };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next, ...(password !== '' || !profile ? { obsPassword: password } : {}) });
      useIntegrationStore.getState().setProfile(next); onPassword(''); setSaved(true);
      if (connect) {
        const result = await linkDesktopViewModel.connectObs();
        useIntegrationStore.getState().setObs(result);
        if (result.status === 'connected') useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
        else setError('OBS 连接未完成，请检查地址、密码和 OBS 的 WebSocket 服务。');
      }
      return true;
    } catch (failure) {
      const raw = typeof failure === 'object' && failure !== null && 'message' in failure ? String(failure.message) : String(failure);
      const technicalError = password ? raw.replaceAll(password, '[REDACTED]') : raw;
      const explanation = toUserErrorMessage(technicalError);
      const reason = explanation.startsWith('操作未能完成。') ? `OBS 操作失败：${technicalError.split('\n')[0]?.slice(0, 300) || '未返回错误内容'}` : explanation;
      setError(reason);
      await linkDesktopViewModel.recordLog({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: reason,
        details: { step: connect ? 'save-and-connect' : 'save', technicalError } }).catch(console.error);
      return false;
    }
    finally { setBusy(false); onBusy(false); }
  };
  const disconnect = async (): Promise<void> => {
    setBusy(true); onBusy(true); setError('');
    try { await linkDesktopViewModel.disconnectObs(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); onBusy(false); }
  };
  const automatic = async (): Promise<void> => {
    if (disabled || busy) return;
    setBusy(true); onBusy(true); setError('');
    try {
      if (!useIntegrationStore.getState().profile) await linkDesktopViewModel.saveIntegrationProfile({ profile: createDefaultIntegrationProfile() });
      const result = localObsConnectionResultSchema.parse(await linkDesktopViewModel.connectLocalObs());
      const updated = await linkDesktopViewModel.loadIntegrationProfile();
      if (updated) useIntegrationStore.getState().setProfile(updated);
      onUrl(result.address); onPassword(result.password);
      useIntegrationStore.getState().setObs(result.snapshot);
      useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
      setSaved(true);
    } catch (failure) { setError(toUserErrorMessage(failure)); }
    finally { setBusy(false); onBusy(false); }
  };
  return <section className="settings-section" aria-label="OBS 连接设置">
    <div className="device-section-heading"><h3>OBS Studio</h3><span role="status">{busy ? '连接处理中' : obs.status === 'connected' ? '已连接' : '未连接'}</span></div>
    <div className="device-actions"><Button className="primary-button" disabled={disabled || busy} onClick={() => void automatic()}>自动连接本机 OBS</Button><span className="settings-note">自动读取地址、端口和密码。下方仅供手动连接使用。</span></div>
    <label className="settings-row"><span>WebSocket 地址</span><input aria-label="WebSocket 地址" placeholder="127.0.0.1:4455" value={url} disabled={disabled || busy} onChange={(event) => { onUrl(event.currentTarget.value); setSaved(false); }} /></label>
    <p className="settings-note">同一台电脑只填端口即可，例如 4455。连接另一台电脑时才需填写 IP 和端口。</p>
    <label className="settings-row"><span>OBS WebSocket 密码</span><input aria-label="OBS 密码" type="text" autoComplete="off" spellCheck={false} placeholder="填写 OBS 服务器密码；已保存则留空保留" value={password} disabled={disabled || busy} onChange={(event) => { onPassword(event.currentTarget.value); setSaved(false); }} /></label>
    <label className="settings-row"><span>启动时自动连接</span><input aria-label="启动时自动连接 OBS" type="checkbox" checked={profile?.obs.autoConnectOnLaunch !== false} disabled={disabled || busy} onChange={(event) => void save(false, event.currentTarget.checked)} /></label>
    <p className="settings-note">启动时尝试一次：OBS 尚未运行时使用已配置的程序路径启动。暂时不可用时保持工作区可用，恢复后可手动重新连接。</p>
    <div className="device-actions settings-header-actions">{obs.status === 'connected' && !dirty ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void disconnect()}>断开 OBS</Button> : <Button className="primary-button" loading={busy} disabled={disabled || busy} onClick={() => void save(true)}>保存并连接 OBS</Button>}{dirty ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void save(false)}>仅保存 OBS</Button> : null}{saved ? <span role="status">已保存</span> : null}</div>
    {error ? <p className="device-error" role="alert">{error}</p> : null}
    {sourceSizeErrors && Object.keys(sourceSizeErrors).length > 0 ? <details className="settings-note">
      <summary>{Object.keys(sourceSizeErrors).length} 个来源尺寸需检查；其他场景可用</summary>
      <ul>{Object.entries(sourceSizeErrors).map(([name, reason]) => <li key={name}>{reason}</li>)}</ul>
    </details> : null}
    <ObsPreviewSetup disabled={disabled || busy} notify={notify} beforeRepair={async () => {
      if (dirty && !await save(false)) throw new Error('OBS 配置保存失败，请检查地址后再次修复组件');
    }} />
  </section>;
}
