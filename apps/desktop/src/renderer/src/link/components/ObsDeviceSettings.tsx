import { SettingsActions, SettingsDisclosure, SettingsFeedback, SettingsField, SettingsPassword, SettingsSwitch } from './SettingsControls';
import { useSettingsDirty } from '../useSettingsDirty';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { Monitor, CheckCircle2, CircleAlert } from 'lucide-react';
import { Button } from './Button';
import { ObsPreviewSetup } from './ObsPreviewSetup';
import { useEffect, useRef, useState } from 'react';
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
  const savedAddress = useRef(profile?.obs.webSocketUrl);
  savedAddress.current = profile?.obs.webSocketUrl;
  const [connectedAddress, setConnectedAddress] = useState<string | undefined>(profile?.obs.webSocketUrl);
  useEffect(() => { if (obs.status === 'connected') setConnectedAddress(savedAddress.current); }, [obs]);
  const [operation, setOperation] = useState<'connecting' | 'saving' | 'disconnecting' | 'preference' | null>(null);
  const busy = operation !== null;
  const [preferenceFeedback, setPreferenceFeedback] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [addressError, setAddressError] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const previewError = useConnectionCheckStore(state => state.checks.preview?.state === 'error');
  useEffect(() => { if (previewError || Object.keys(sourceSizeErrors ?? {}).length) setDiagnosticsOpen(true); }, [previewError, sourceSizeErrors]);
  const addressInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (addressError && !busy && !disabled) addressInput.current?.focus(); }, [addressError, busy, disabled]);
  const dirty = url !== (profile?.obs.webSocketUrl ?? createDefaultIntegrationProfile().obs.webSocketUrl) || password !== '';
  useSettingsDirty('obs', dirty);
  const save = async (connect: boolean, autoConnect = profile?.obs.autoConnectOnLaunch !== false): Promise<boolean> => {
    if (disabled || busy) return false;
    setOperation(connect ? 'connecting' : 'saving'); onBusy(true); setError(''); setSaved(false);
    try {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const parsedAddress = obsWebSocketUrlSchema.safeParse(url);
      if (!parsedAddress.success) {
        const message = parsedAddress.error.issues.map(issue => issue.message).join('；');
        setAddressError(message); setManualOpen(true);
        throw new Error(message);
      }
      setAddressError('');
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
      setError(reason); setManualOpen(true);
      await linkDesktopViewModel.recordLog({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: reason,
        details: { step: connect ? 'save-and-connect' : 'save', technicalError } }).catch(console.error);
      return false;
    }
    finally { setOperation(null); onBusy(false); }
  };
  const disconnect = async (): Promise<void> => {
    setOperation('disconnecting'); onBusy(true); setError('');
    try { await linkDesktopViewModel.disconnectObs(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setOperation(null); onBusy(false); }
  };
  const automatic = async (): Promise<void> => {
    if (disabled || busy) return;
    setOperation('connecting'); onBusy(true); setError(''); setSaved(false);
    try {
      if (!useIntegrationStore.getState().profile) await linkDesktopViewModel.saveIntegrationProfile({ profile: createDefaultIntegrationProfile() });
      const result = localObsConnectionResultSchema.parse(await linkDesktopViewModel.connectLocalObs());
      const updated = await linkDesktopViewModel.loadIntegrationProfile();
      if (updated) useIntegrationStore.getState().setProfile(updated);
      onUrl(result.address); onPassword('');
      useIntegrationStore.getState().setObs(result.snapshot);
      useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
      setSaved(true);
    } catch (failure) { setError(toUserErrorMessage(failure)); }
    finally { setOperation(null); onBusy(false); }
  };
  const saveAutoConnect = async (value: boolean): Promise<void> => {
    if (disabled || busy) return;
    setOperation('preference'); onBusy(true); setError(''); setPreferenceFeedback('');
    try {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const next = { ...current, updatedAt: new Date().toISOString(), obs: { ...current.obs, autoConnectOnLaunch: value } };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next });
      useIntegrationStore.getState().setProfile(next);
      setPreferenceFeedback('已保存到本机');
    } catch (failure) { setError(toUserErrorMessage(failure)); }
    finally { setOperation(null); onBusy(false); }
  };
  const sourceErrors = Object.entries(sourceSizeErrors ?? {});
  return <section className="settings-section" aria-label="OBS 连接设置" aria-busy={busy}>
    <div className="settings-connection-block">
      <div className="settings-connection-summary">
        <div className={`settings-connection-symbol ${obs.status === 'connected' ? 'is-connected' : ''}`}>{obs.status === 'connected' ? <CheckCircle2 aria-hidden="true" /> : obs.status === 'error' ? <CircleAlert aria-hidden="true" /> : <Monitor aria-hidden="true" />}</div>
        <div className="settings-connection-copy"><h2>{obs.status === 'connected' ? 'OBS 已连接' : operation === 'connecting' ? '正在连接 OBS' : 'OBS 尚未连接'}</h2><p>{obs.status === 'connected' ? '可以使用 OBS 画面与声音。' : 'OBS 装在这台电脑上，点击右侧按钮即可连接。'}</p>{obs.status === 'connected' ? <span className="settings-connection-address">{connectedAddress ?? '连接地址尚未读取'}</span> : null}</div>
        {obs.status === 'connected' ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void disconnect()}>{operation === 'disconnecting' ? '正在断开…' : '断开 OBS'}</Button> : <Button className={manualOpen ? 'secondary-button' : 'primary-button'} loading={operation === 'connecting'} disabled={disabled || busy} onClick={() => void automatic()}>{operation === 'connecting' ? '正在连接…' : '连接本机 OBS'}</Button>}
      </div>
      {saved ? <SettingsFeedback tone="success">连接配置已保存到本机。</SettingsFeedback> : null}
      {error ? <SettingsFeedback tone="error">{error}<p>确认 OBS 已打开后重试；连接其他电脑时，请展开下方“手动连接”。</p></SettingsFeedback> : null}
    </div>
    <div className="settings-preference-block"><SettingsSwitch label="打开联动台时，自动连接 OBS" aria-label="启动时自动连接 OBS" checked={profile?.obs.autoConnectOnLaunch !== false} disabled={disabled || busy} onChange={event => void saveAutoConnect(event.currentTarget.checked)} help="每次启动尝试连接一次；未成功时，可点击上方按钮重试。" /><div className="settings-save-feedback" role="status">{operation === 'preference' ? '正在保存…' : preferenceFeedback}</div></div>
    <SettingsDisclosure title="手动连接" description="连接另一台电脑，或自行填写地址和密码" open={manualOpen} onToggle={setManualOpen}>
      <SettingsField label="WebSocket 地址" help="本机可填 4455；连接另一台电脑时填写 IP 和端口，例如 192.168.1.10:4455。" error={addressError}>{field => <input {...field} ref={addressInput} aria-label="WebSocket 地址" placeholder="127.0.0.1:4455" value={url} disabled={disabled || busy} onChange={event => { onUrl(event.currentTarget.value); setSaved(false); setAddressError(''); }} />}</SettingsField>
      <SettingsField label="WebSocket 密码" help="留空保留已保存的密码。密码仅保存在本机安全存储。">{field => <SettingsPassword {...field} aria-label="OBS 密码" placeholder="填写 OBS 服务器密码" value={password} disabled={disabled || busy} onChange={event => { onPassword(event.currentTarget.value); setSaved(false); }} />}</SettingsField>
      <SettingsActions><Button className="primary-button" loading={operation === 'connecting'} disabled={disabled || busy} onClick={() => void save(true)}>{operation === 'connecting' ? '正在连接 OBS…' : '保存并连接 OBS'}</Button>{dirty ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void save(false)}>{operation === 'saving' ? '正在保存…' : '仅保存 OBS'}</Button> : null}{dirty ? <span className="settings-note">有未保存修改</span> : null}</SettingsActions>
    </SettingsDisclosure>
    <SettingsDisclosure open={diagnosticsOpen} onToggle={setDiagnosticsOpen} description="连接成功但没有预览画面时，在这里检查和修复" title={sourceErrors.length ? `预览画面检查 · ${sourceErrors.length} 项待处理` : '预览画面检查'}>
      {sourceErrors.length ? <SettingsFeedback tone="warning"><strong>{sourceErrors.length} 个来源需要检查，其他场景可用</strong><ul>{sourceErrors.map(([name, reason]) => <li key={name}><strong>{name}</strong>：{reason}</li>)}</ul></SettingsFeedback> : null}
      <ObsPreviewSetup disabled={disabled || busy} notify={notify} beforeRepair={() => {
        if (dirty) { setManualOpen(true); return Promise.reject(new Error('请先保存或恢复手动连接参数，再修复预览组件')); }
        return Promise.resolve();
      }} />
    </SettingsDisclosure>
  </section>;
}
