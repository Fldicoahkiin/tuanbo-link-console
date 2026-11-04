import { useSettingsDirty } from '../useSettingsDirty';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { Monitor } from 'lucide-react';
import { Button, Card, Disclosure, Field, Notice, PasswordInput, Switch, TextInput } from '../ui';
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
        else setError('没有连上 OBS，请检查地址、密码，以及 OBS 的 WebSocket 服务是否已打开。');
      }
      return true;
    } catch (failure) {
      const raw = typeof failure === 'object' && failure !== null && 'message' in failure ? String(failure.message) : String(failure);
      const technicalError = password ? raw.replaceAll(password, '[REDACTED]') : raw;
      const reason = toUserErrorMessage(technicalError);
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
  const connected = obs.status === 'connected';
  return <section className="settings-stack" aria-label="OBS 连接设置" aria-busy={busy}>
    <Card title={connected ? 'OBS 已连接' : operation === 'connecting' ? '正在连接 OBS' : 'OBS 还没连接'}
      description={connected ? '可以用 OBS 的画面和声音了。' : 'OBS 装在这台电脑上的话，点右边的按钮就能连接。'}
      actions={connected ? <Button variant="secondary" loading={operation === 'disconnecting'} disabled={disabled || busy} onClick={() => void disconnect()}>{operation === 'disconnecting' ? '正在断开…' : '断开 OBS'}</Button>
        : <Button variant={manualOpen ? 'secondary' : 'primary'} icon={Monitor} loading={operation === 'connecting'} disabled={disabled || busy} onClick={() => void automatic()}>{operation === 'connecting' ? '正在连接…' : '连接本机 OBS'}</Button>}>
      {connected ? <p className="settings-connection-address">{connectedAddress ?? '还没读到连接地址'}</p> : null}
      {saved ? <Notice tone="success">连接配置已保存到本机。</Notice> : null}
      {error ? <Notice tone="error" title={error}>请确认 OBS 已经打开，然后再试一次；要连接其他电脑上的 OBS，展开下面的“手动连接”。</Notice> : null}
      <Switch label="打开联动台时，自动连接 OBS" aria-label="启动时自动连接 OBS" help={operation === 'preference' ? '正在保存…' : preferenceFeedback || '每次启动时试着连一次；没连上的话，点上面的按钮再试'}
        checked={profile?.obs.autoConnectOnLaunch !== false} disabled={disabled || busy} onChange={event => void saveAutoConnect(event.currentTarget.checked)} />
    </Card>
    <Disclosure title="手动连接" description="连接另一台电脑，或自己填写地址和密码" open={manualOpen} onToggle={setManualOpen}>
      <Field label="WebSocket 地址" help="本机可以只填 4455；连接另一台电脑时填 IP 和端口，例如 192.168.1.10:4455" error={addressError || null}>{field => <TextInput {...field} ref={addressInput} aria-label="WebSocket 地址" placeholder="127.0.0.1:4455" value={url} disabled={disabled || busy} onChange={event => { onUrl(event.currentTarget.value); setSaved(false); setAddressError(''); }} />}</Field>
      <Field label="WebSocket 密码" help="留空就沿用已保存的密码。密码只存在这台电脑的安全存储里">{field => <PasswordInput {...field} aria-label="OBS 密码" placeholder="填写 OBS 服务器密码" value={password} disabled={disabled || busy} onChange={event => { onPassword(event.currentTarget.value); setSaved(false); }} />}</Field>
      <div className="settings-actions-row">
        <Button variant="primary" loading={operation === 'connecting'} disabled={disabled || busy} onClick={() => void save(true)}>{operation === 'connecting' ? '正在连接 OBS…' : '保存并连接 OBS'}</Button>
        {dirty ? <Button variant="secondary" loading={operation === 'saving'} disabled={disabled || busy} onClick={() => void save(false)}>{operation === 'saving' ? '正在保存…' : '仅保存 OBS'}</Button> : null}
        {dirty ? <span className="settings-unsaved">有修改还没保存</span> : null}
      </div>
    </Disclosure>
    <Disclosure open={diagnosticsOpen} onToggle={setDiagnosticsOpen} description="连上了却没有预览画面时，在这里检查和修复" title={sourceErrors.length ? `预览画面检查 · ${sourceErrors.length} 项要处理` : '预览画面检查'}>
      {sourceErrors.length ? <Notice tone="warning" title={`${sourceErrors.length} 个来源要检查，其他场景可以正常用`}><ul className="settings-list">{sourceErrors.map(([name, reason]) => <li key={name}><strong>{name}</strong>：{reason}</li>)}</ul></Notice> : null}
      <ObsPreviewSetup disabled={disabled || busy} notify={notify} beforeRepair={() => {
        if (dirty) { setManualOpen(true); return Promise.reject(new Error('请先保存或撤销“手动连接”里的修改，再修复预览组件')); }
        return Promise.resolve();
      }} />
    </Disclosure>
  </section>;
}
