import { SettingsPassword, SettingsSwitch, SettingsField } from './SettingsControls';
import { useSettingsDirty } from '../useSettingsDirty';
import { Ma2DiscoveryResults } from './Ma2DiscoveryResults';
import { Ma2ComputerNetwork, useMa2ComputerNetwork } from './Ma2ComputerNetwork';
import { Button } from './Button';
import { ChevronRight } from 'lucide-react';
import { ma2AddressInput } from '../view-models/ma2-address-input';
import { checkNetworkMa2, connectDiscoveredMa2 } from '../stores/ma2-connection-store';
import { useDocumentStore } from '../stores/document-store';
import { prepareMa2Editing } from '../runtime/ma2-editing-session';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type JSX } from 'react';
import { ma2NetworkStatusSchema, ma2NetworkSaveSchema, ma2DiscoverySchema, type Ma2Discovery, type Ma2NetworkSettings as NetworkSettings } from '@tb/schema';
import { useMa2NetworkStatus } from './useMa2NetworkStatus';
import { ma2CredentialsForTarget } from '../view-models/ma2-credentials';

async function loadConnectedMa2(target: NetworkSettings, documentId: number, progress: (message: string) => void, notify: (message: string) => void): Promise<void> {
  if (!useDocumentStore.getState().project) { notify('MA2 已连接，打开工程后就能读取节目 Cue。'); return; }
  progress('控台已连接，正在载入对应节目 Cue…');
  notify(await prepareMa2Editing({ dataDirectory: '', network: { host: target.host, port: target.port, monitorPort: target.monitorPort, username: target.username } }, documentId));
}

export function Ma2NetworkSettings({ disabled, notify, maintenanceHost, onMaintenance, onBusy, onConnected }: { maintenanceHost: HTMLDivElement | null; onMaintenance: () => void; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; onConnected: (connected: boolean) => void }): JSX.Element {
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [found, setFound] = useState<Ma2Discovery | null>(null);
  const [searching, setSearching] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(30000);
  const [monitorPort, setMonitorPort] = useState(30001);
  const [username, setUsername] = useState('administrator');
  const [password, setPassword] = useState('admin');
  const [passwordEdited, setPasswordEdited] = useState(true);
  const [autoConnect, setAutoConnect] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusy(busy || searching); return () => onBusy(false); }, [busy, searching, onBusy]);
  const [progress, setProgress] = useState('');
  const [readRevision, setReadRevision] = useState(0);
  const { status, setStatus, loaded, pluginReady, setPluginReady } = useMa2NetworkStatus(readRevision, settings => {
    setHost(settings.host); setPort(settings.port); setMonitorPort(settings.monitorPort); setUsername(settings.username);
    setAutoConnect(settings.autoConnect); setPassword(''); setPasswordEdited(false);
  }, message => { setError(message); notify(message, 'error'); });
  const hostInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (fieldError && !busy && !disabled && loaded) hostInput.current?.focus(); }, [fieldError, busy, disabled, loaded]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const computerNetwork = useMa2ComputerNetwork();
  const clearNetworkPlan = computerNetwork.setPlan;
  useEffect(() => { clearNetworkPlan(null); }, [host, clearNetworkPlan]);
  const changeCredentialTarget = (target: { host: string; username: string; port: number; monitorPort: number }): void => {
    const credential = ma2CredentialsForTarget(status?.profiles ?? [], target);
    setPassword(credential.password); setPasswordEdited(credential.edited);
  };
  const choose = (profile?: NetworkSettings, address?: { host: string; port: number }): void => {
    setError(''); setTouched(false); setSaved(false);
    setHost(profile?.host ?? address?.host ?? ''); setPort(profile?.port ?? address?.port ?? 30000); setMonitorPort(profile?.monitorPort ?? 30001);
    setUsername(profile?.username ?? 'administrator'); setAutoConnect(profile?.autoConnect ?? false); setPassword(profile ? '' : 'admin'); setPasswordEdited(!profile);
  };
  const automatic = async (): Promise<void> => {
    const documentId = useDocumentStore.getState().documentId;
    let networkConnected = false;
    setBusy(true); setError(''); setProgress('正在发现控台，准备读取素材…');
    try {
      if (host.trim() && dirty) {
        const address = ma2AddressInput(host);
        const request = ma2NetworkSaveSchema.safeParse({ settings: { host: address, port, monitorPort, username: username.trim(), autoConnect }, ...(passwordEdited ? { password } : {}) });
        if (!request.success) throw new Error('请检查连接端口、用户名和密码；用户名和密码不能包含引号、反斜杠或换行');
        await window.tbLink.saveMa2Network(request.data); setHost(address); setPassword(''); setPasswordEdited(false);
      }
      const next = await connectDiscoveredMa2(setFound, address => computerNetwork.prepare(address, setProgress));
      setStatus(next);
      networkConnected = true;
      if (next.settings) choose(next.settings);
      if (!next.settings) throw new Error('控台连接信息不完整，请重新连接');
      await loadConnectedMa2(next.settings, documentId, setProgress, notify);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : '请检查网线和控台设置';
      const message = networkConnected ? `MA2 已连接，但节目 Cue 没有载入完成：${reason}` : reason;
      setError(message); notify(message, 'error');
    }
    finally { setBusy(false); setProgress(''); }
  };
  const search = async (): Promise<void> => {
    setSearching(true); setFound(null);
    try { setFound(ma2DiscoverySchema.parse(await window.tbLink.discoverMa2())); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message, 'error'); }
    finally { setSearching(false); }
  };
  const check = async (): Promise<void> => {
    setBusy(true); setError(''); setPluginReady(false);
    try {
      const checked = await checkNetworkMa2(); setStatus(checked);
      if (!checked.settings) throw new Error('请先连接控台');
      setPluginReady(true);
    }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const save = async (connect: boolean): Promise<void> => {
    const documentId = useDocumentStore.getState().documentId;
    let networkConnected = false;
    setBusy(true); setError(''); setFieldError(''); setSaved(false); setProgress('正在保存连接设置…');
    try {
      let address: string;
      try { address = ma2AddressInput(host); } catch (failure) { setFieldError(String(failure)); throw failure; }
      const parsed = ma2NetworkSaveSchema.safeParse({ settings: { host: address, port, monitorPort, username: username.trim(), autoConnect }, ...(passwordEdited ? { password } : {}) });
      if (!parsed.success) throw new Error('请填写有效的控台 IPv4 地址、端口与用户名；用户名和密码不能包含引号、反斜杠或换行');
      const saved = ma2NetworkStatusSchema.parse(await window.tbLink.saveMa2Network(parsed.data));
      setHost(address); setPassword(''); setPasswordEdited(false); setStatus(saved); setSaved(true); setTouched(false);
      if (connect) {
        await computerNetwork.prepare(address, setProgress);
        setProgress(`正在连接 ${host.trim()}:${port}，并验证登录…`);
        setPluginReady(false);
        const connected = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
        setStatus(connected);
        if (connected.error) { setError(connected.error); notify(connected.error, 'error'); }
        else if (connected.state === 'connected') {
          networkConnected = true;
          await loadConnectedMa2(parsed.data.settings, documentId, setProgress, notify);
        }
        else { const message = 'MA2 没有连上。请检查控台的远程设置和网络，然后重新连接'; setError(message); notify(message, 'error'); }
      } else notify('MA2 连接设置已保存');
    } catch (error) { const reason = error instanceof Error ? error.message : String(error); const message = networkConnected ? `MA2 已连接，但节目 Cue 没有载入完成：${reason}` : reason; setError(message); notify(message, 'error'); }
    finally { setBusy(false); setProgress(''); }
  };
  const disconnect = async (): Promise<void> => {
    try { setStatus(ma2NetworkStatusSchema.parse(await window.tbLink.disconnectMa2Network())); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message, 'error'); }
  };
  const locked = disabled || busy || !loaded;
  const runNetwork = (operation: () => Promise<unknown>): void => {
    setBusy(true); setError('');
    void operation().catch((failure: unknown) => { const message = failure instanceof Error ? failure.message : String(failure); setError(message); notify(message, 'error'); }).finally(() => setBusy(false));
  };
  const matching = status?.settings?.host === host.trim() && status.settings.port === port && status.settings.monitorPort === monitorPort && status.settings.username === username.trim();
  const connected = matching && status?.state === 'connected';
  useEffect(() => { onConnected(connected); }, [connected, onConnected]);
  const dirty = status?.settings ? !matching || passwordEdited || autoConnect !== status.settings.autoConnect : Boolean(host.trim() || username.trim() || passwordEdited || autoConnect || port !== 30000 || monitorPort !== 30001);
  useSettingsDirty('ma2', loaded && dirty && (touched || Boolean(status?.settings)));
  const connectionLabel = busy || matching && (status?.state === 'connecting' || status?.state === 'authenticating') ? '连接中' : connected ? '已连接' : '未连接';

  const profiles = status?.profiles ?? [];
  const selected = profiles.findIndex((profile) => profile.host === host && profile.port === port && profile.monitorPort === monitorPort && profile.username === username);
  return <div className="ma2-network-settings">
    <form className="ma2-connect-form" onSubmit={event => { event.preventDefault(); if (!locked && !searching) void (host.trim() && (!connected || dirty) ? save(true) : automatic()); }}>
      <div className="ma2-connect-heading"><label htmlFor="ma2-console-address">控台 IP</label><span className="ma2-device-status" data-connected={connected} role="status">{connectionLabel}</span></div>
      <div className="ma2-connect-address"><input id="ma2-console-address" ref={hostInput} aria-label="MA2 控台 IP" aria-invalid={fieldError ? true : undefined} aria-describedby="ma2-address-help" placeholder="例如 2.0.0.1" value={host} disabled={locked} onChange={event => { const value = event.target.value; setError(''); setTouched(true); setSaved(false); setHost(value); setFieldError(''); changeCredentialTarget({ host: value.trim(), port, monitorPort, username: username.trim() }); }} /><Button type="submit" className="primary-button" disabled={locked || searching}>{busy ? '连接中…' : connected && !dirty ? '读取 Cue' : '连接控台'}</Button>{connected ? <Button type="button" className="secondary-button" disabled={locked || searching} onClick={() => void disconnect()}>断开</Button> : null}</div>
      <p id="ma2-address-help" className="settings-note">填写 MA2 控台屏幕上显示的 IP，电脑的网卡和 IP 会自动匹配。</p>
    </form>
    <div className="ma2-connect-shortcuts"><Button className="secondary-button" disabled={locked || searching} onClick={() => void search()}>{searching ? '搜索中…' : '搜索控台'}</Button><Button className="secondary-button" disabled={locked || searching} onClick={() => { choose(status?.profiles?.find(profile => profile.host === '127.0.0.1'), { host: '127.0.0.1', port: 30000 }); setTouched(true); }}>使用本机 onPC</Button>{searching || busy && progress.startsWith('正在发现') ? <Button className="secondary-button" onClick={() => { void window.tbLink.cancelMa2Discovery().catch((error: unknown) => notify(String(error), 'error')); }}>取消搜索</Button> : null}</div>
    {profiles.length ? <label className="settings-path-row ma2-recent-console"><span>最近使用</span><select aria-label="已保存 MA2 控台" value={selected} disabled={locked || searching} onChange={event => choose(profiles[Number(event.target.value)])}><option value={-1}>其他控台</option>{profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.monitorPort}:${profile.username}`} value={index}>{profile.host} · {profile.username}</option>)}</select></label> : null}
    {found ? <Ma2DiscoveryResults result={found} disabled={locked} selectedHost={host} onChoose={address => choose(profiles.find(profile => profile.host === address.host && profile.port === address.port), address)} /> : null}
    <div className="ma2-connection-feedback" aria-live="polite">
      {!loaded ? error ? <Button className="secondary-button" onClick={() => { setError(''); setReadRevision(value => value + 1); }}>重新读取连接设置</Button> : <p role="status">正在读取连接设置…</p> : null}
      {progress ? <p role="status">{progress}</p> : null}
      {error || matching && status?.error ? <p className="device-error" role="alert">{error || status?.error}</p> : !busy && connected ? <p className="settings-note">已连接 {host.trim()}，可以前往灯光工作台读取 Cue。</p> : !busy && saved ? <p className="settings-note" role="status">连接设置已保存。</p> : null}
      {computerNetwork.plan?.host === host.trim() ? <p className="settings-note" role="status">{computerNetwork.plan.message}</p> : null}
    </div>
    <details className="ma2-advanced-settings" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary><ChevronRight aria-hidden="true" />高级设置<span>账号、网卡与端口</span></summary>
      <div className="ma2-network-fields">
        <label><span>登录用户</span><input aria-label="MA2 登录用户" autoComplete="off" value={username} disabled={locked} onChange={event => { setError(''); setTouched(true); setSaved(false); setUsername(event.target.value); changeCredentialTarget({ host: host.trim(), port, monitorPort, username: event.target.value.trim() }); }} /></label>
        <SettingsField label="登录密码" help="密码只保存在这台电脑上；换控台时不会沿用上一个控台的密码。">{field => <SettingsPassword {...field} key={`${host}:${port}:${monitorPort}:${username}`} aria-label="MA2 登录密码" placeholder={matching && status?.passwordSaved ? '已保存，留空不修改' : '控台用户的密码'} value={password} disabled={locked} onChange={event => { setTouched(true); setSaved(false); setPassword(event.target.value); setPasswordEdited(true); }} />}</SettingsField>
        <SettingsSwitch label="启动时自动连接" aria-label="启动时自动连接 MA2" checked={autoConnect} disabled={locked} onChange={event => { setTouched(true); setAutoConnect(event.target.checked); }} />
      </div>
      <div className="device-actions"><Button className="secondary-button" disabled={locked} onClick={() => { setTouched(true); setUsername('administrator'); setPassword('admin'); setPasswordEdited(true); setError(''); }}>使用默认账号</Button>{dirty ? <Button className="secondary-button" disabled={locked || searching} onClick={() => void save(false)}>仅保存</Button> : null}</div>
      <Ma2ComputerNetwork network={computerNetwork} host={host} disabled={locked || searching} run={runNetwork} />
      <div className="ma2-network-ports"><label className="settings-path-row"><span>远程端口</span><input aria-label="MA2 远程端口" type="number" min={1} max={65535} value={Number.isNaN(port) ? '' : port} disabled={locked} onChange={event => { setTouched(true); setPort(event.target.valueAsNumber); setPassword(''); setPasswordEdited(false); }} /></label><label className="settings-path-row"><span>监视端口</span><input aria-label="MA2 监视端口" type="number" min={1} max={65535} value={Number.isNaN(monitorPort) ? '' : monitorPort} disabled={locked} onChange={event => { setTouched(true); setMonitorPort(event.target.valueAsNumber); setPassword(''); setPasswordEdited(false); }} /></label></div>
      {connected ? <div className="device-actions"><Button className="secondary-button" disabled={locked} onClick={() => void check()}>检查读写通信</Button><span role="status">{pluginReady ? '读写通信正常' : '还没检查读写通信'}</span><Button className="secondary-button" onClick={onMaintenance}>更多诊断</Button></div> : null}
    </details>
    <details className="ma2-operation-help"><summary>连接不上？查看控台设置</summary><p className="settings-note">把电脑和控台接到同一台交换机，或用网线直连。在控台上打开 Setup → Console → Global Settings → Telnet → Login Enabled；账号可在 User &amp; Profiles Setup 里查看。联动台的“高级设置”里可以修改账号和密码。</p></details>

    {maintenanceHost ? createPortal(
    <section className="ma2-protocol"><div className="device-section-heading"><h3>MA2 控台</h3><span>{host || '未选择控台'}</span></div>    <div className="settings-header-actions"><Button className="secondary-button" disabled={locked || !matching || status?.state !== 'connected'} onClick={() => void check()}>检测版本兼容性</Button></div>
    {matching && status?.capabilities ? <p role="status">MA2 {status.capabilities.version} · {status.capabilities.lua} · {status.capabilities.message}</p> : null}
</section>, maintenanceHost) : null}
  </div>;
}

