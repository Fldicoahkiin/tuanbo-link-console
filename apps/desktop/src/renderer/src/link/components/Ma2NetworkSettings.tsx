import { useSettingsDirty } from '../useSettingsDirty';
import { Ma2DiscoveryResults } from './Ma2DiscoveryResults';
import { Ma2ComputerNetwork, useMa2ComputerNetwork } from './Ma2ComputerNetwork';
import { Button, Card, Disclosure, Field, Notice, PasswordInput, Select, Switch, TextInput } from '../ui';
import { ma2AddressInput } from '../view-models/ma2-address-input';
import { checkNetworkMa2, connectDiscoveredMa2 } from '../stores/ma2-connection-store';
import { useDocumentStore } from '../stores/document-store';
import { prepareMa2Editing } from '../runtime/ma2-editing-session';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type JSX } from 'react';
import { ma2NetworkStatusSchema, ma2NetworkSaveSchema, ma2DiscoverySchema, type Ma2Discovery, type Ma2NetworkSettings as NetworkSettings, type Ma2NetworkStatus } from '@tb/schema';
import { useMa2NetworkStatus } from './useMa2NetworkStatus';
import { ma2CredentialsForTarget } from '../view-models/ma2-credentials';

async function loadConnectedMa2(target: NetworkSettings, documentId: number, progress: (message: string) => void, notify: (message: string) => void): Promise<void> {
  if (!useDocumentStore.getState().project) { notify('MA2 已连接，打开工程后就能读取节目 Cue。'); return; }
  progress('控台已连接，正在载入对应节目 Cue…');
  notify(await prepareMa2Editing({ dataDirectory: '', network: { host: target.host, port: target.port, monitorPort: target.monitorPort, username: target.username } }, documentId));
}

/** The connection as the settings heading shows it: the console these fields name, and whether it is logged in. */
export type Ma2NetworkView = Pick<Ma2NetworkStatus, 'state' | 'error'>;

export function Ma2NetworkSettings({ disabled, notify, maintenanceHost, onMaintenance, onBusy, onStatus }: { maintenanceHost: HTMLDivElement | null; onMaintenance: () => void; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; onStatus: (status: Ma2NetworkView) => void }): JSX.Element {
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
      const next = await connectDiscoveredMa2(setFound, address => computerNetwork.prepare(address, setProgress), message => notify(message, 'info'));
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
  const viewState: Ma2NetworkView['state'] = busy ? 'connecting' : matching && status ? status.state : 'disconnected';
  const viewError = matching ? status?.error ?? null : null;
  useEffect(() => { onStatus({ state: viewState, error: viewError }); }, [viewState, viewError, onStatus]);
  const dirty = status?.settings ? !matching || passwordEdited || autoConnect !== status.settings.autoConnect : Boolean(host.trim() || username.trim() || passwordEdited || autoConnect || port !== 30000 || monitorPort !== 30001);
  useSettingsDirty('ma2', loaded && dirty && (touched || Boolean(status?.settings)));

  const profiles = status?.profiles ?? [];
  const selected = profiles.findIndex((profile) => profile.host === host && profile.port === port && profile.monitorPort === monitorPort && profile.username === username);
  const connectLabel = busy ? '连接中…' : connected && !dirty ? '读取 Cue' : '连接控台';
  return <div className="ma2-network-settings">
    <form className="ma2-connect-form" onSubmit={event => { event.preventDefault(); if (!locked && !searching) void (host.trim() && (!connected || dirty) ? save(true) : automatic()); }}>
      <Field label="控台 IP" help="填 MA2 控台屏幕上显示的 IP，电脑的网卡和 IP 会自动匹配">{props => <div className="settings-path-control">
        <TextInput {...props} ref={hostInput} aria-label="MA2 控台 IP" aria-invalid={fieldError ? true : undefined} placeholder="例如 2.0.0.1" value={host} disabled={locked} onChange={event => { const value = event.target.value; setError(''); setTouched(true); setSaved(false); setHost(value); setFieldError(''); changeCredentialTarget({ host: value.trim(), port, monitorPort, username: username.trim() }); }} />
        <Button type="submit" variant="primary" disabled={locked || searching}>{connectLabel}</Button>
        {connected ? <Button type="button" variant="secondary" disabled={locked || searching} onClick={() => void disconnect()}>断开</Button> : null}
      </div>}</Field>
    </form>
    <div className="settings-actions-row">
      <Button variant="secondary" size="sm" loading={searching} disabled={locked || searching} onClick={() => void search()}>{searching ? '搜索中…' : '搜索控台'}</Button>
      <Button variant="secondary" size="sm" disabled={locked || searching} onClick={() => { choose(status?.profiles?.find(profile => profile.host === '127.0.0.1'), { host: '127.0.0.1', port: 30000 }); setTouched(true); }}>使用本机 onPC</Button>
      {searching || busy && progress.startsWith('正在发现') ? <Button variant="ghost" size="sm" onClick={() => { void window.tbLink.cancelMa2Discovery().catch((failure: unknown) => notify(String(failure), 'error')); }}>取消搜索</Button> : null}
    </div>
    {profiles.length ? <Ma2RecentConsoles profiles={profiles} selected={selected} disabled={locked || searching} onChoose={index => choose(profiles[index])} /> : null}
    {found ? <Ma2DiscoveryResults result={found} disabled={locked} selectedHost={host} onChoose={address => choose(profiles.find(profile => profile.host === address.host && profile.port === address.port), address)} /> : null}
    <Ma2ConnectionFeedback loaded={loaded} error={error || (matching ? status?.error ?? '' : '')} progress={progress} busy={busy} connected={connected} saved={saved} host={host.trim()}
      plan={computerNetwork.plan?.host === host.trim() ? computerNetwork.plan.message : null} onRetry={() => { setError(''); setReadRevision(value => value + 1); }} />
    <Disclosure className="ma2-advanced-settings" title="高级设置" description="账号、网卡与端口" open={advancedOpen} onToggle={setAdvancedOpen}>
      <Field label="登录用户">{props => <TextInput {...props} aria-label="MA2 登录用户" autoComplete="off" value={username} disabled={locked} onChange={event => { setError(''); setTouched(true); setSaved(false); setUsername(event.target.value); changeCredentialTarget({ host: host.trim(), port, monitorPort, username: event.target.value.trim() }); }} />}</Field>
      <Field label="登录密码" help="密码只存在这台电脑上；换控台时不会沿用上一个控台的密码">{props => <PasswordInput {...props} key={`${host}:${port}:${monitorPort}:${username}`} aria-label="MA2 登录密码" placeholder={matching && status?.passwordSaved ? '已保存，留空不修改' : '控台用户的密码'} value={password} disabled={locked} onChange={event => { setTouched(true); setSaved(false); setPassword(event.target.value); setPasswordEdited(true); }} />}</Field>
      <Switch label="启动时自动连接" aria-label="启动时自动连接 MA2" checked={autoConnect} disabled={locked} onChange={event => { setTouched(true); setAutoConnect(event.target.checked); }} />
      <div className="settings-actions-row">
        <Button variant="secondary" disabled={locked} onClick={() => { setTouched(true); setUsername('administrator'); setPassword('admin'); setPasswordEdited(true); setError(''); }}>使用默认账号</Button>
        {dirty ? <Button variant="secondary" disabled={locked || searching} onClick={() => void save(false)}>仅保存</Button> : null}
      </div>
      <Ma2ComputerNetwork network={computerNetwork} host={host} disabled={locked || searching} run={runNetwork} />
      <Field label="远程端口">{props => <TextInput {...props} aria-label="MA2 远程端口" type="number" min={1} max={65535} value={Number.isNaN(port) ? '' : port} disabled={locked} onChange={event => { setTouched(true); setPort(event.target.valueAsNumber); setPassword(''); setPasswordEdited(false); }} />}</Field>
      <Field label="监视端口">{props => <TextInput {...props} aria-label="MA2 监视端口" type="number" min={1} max={65535} value={Number.isNaN(monitorPort) ? '' : monitorPort} disabled={locked} onChange={event => { setTouched(true); setMonitorPort(event.target.valueAsNumber); setPassword(''); setPasswordEdited(false); }} />}</Field>
      {connected ? <div className="settings-actions-row">
        <Button variant="secondary" disabled={locked} onClick={() => void check()}>检查读写通信</Button><span role="status" className="settings-saved">{pluginReady ? '读写通信正常' : '还没检查读写通信'}</span><Button variant="ghost" onClick={onMaintenance}>更多诊断</Button>
      </div> : null}
    </Disclosure>
    <Ma2ConnectHelp />

    {maintenanceHost ? createPortal(<Ma2CompatibilityCard host={host} disabled={locked || !matching || status?.state !== 'connected'} capabilities={matching ? status?.capabilities ?? null : null} onCheck={() => void check()} />, maintenanceHost) : null}
  </div>;
}

/** What the last read, connect or save did; only one message at a time. */
function Ma2ConnectionFeedback({ loaded, error, progress, busy, connected, saved, host, plan, onRetry }: {
  loaded: boolean; error: string; progress: string; busy: boolean; connected: boolean; saved: boolean; host: string; plan: string | null; onRetry: () => void;
}): JSX.Element {
  return <div className="ma2-connection-feedback" aria-live="polite">
    {!loaded ? error ? <Button variant="secondary" onClick={onRetry}>重新读取连接设置</Button> : <p role="status">正在读取连接设置…</p> : null}
    {progress ? <p role="status">{progress}</p> : null}
    {error ? <Notice tone="error">{error}</Notice>
      : !busy && connected ? <p>已连接 {host}，可以到灯光工作台读取 Cue。</p>
      : !busy && saved ? <p role="status">连接设置已保存。</p> : null}
    {plan ? <p role="status">{plan}</p> : null}
  </div>;
}

function Ma2ConnectHelp(): JSX.Element {
  return <Disclosure title="连接不上？查看控台设置">
    <p>把电脑和控台接到同一台交换机，或用网线直连。在控台上打开 Setup → Console → Global Settings → Telnet → Login Enabled；账号在 User &amp; Profiles Setup 里查看。上面的“高级设置”里可以改账号和密码。</p>
  </Disclosure>;
}

/** On 程序维护: whether this console's version and plugin work with the program. */
function Ma2CompatibilityCard({ host, disabled, capabilities, onCheck }: { host: string; disabled: boolean; capabilities: Ma2NetworkStatus['capabilities'] | null; onCheck: () => void }): JSX.Element {
  return <Card level={3} title="MA2 控台" description={host || '还没选控台'} actions={<Button variant="secondary" size="sm" disabled={disabled} onClick={onCheck}>检测版本兼容性</Button>}>
    {capabilities ? <p role="status">MA2 {capabilities.version} · {capabilities.lua} · {capabilities.message}</p> : <p>连上控台后，可以检查控台版本和插件是否兼容。</p>}
  </Card>;
}

function Ma2RecentConsoles({ profiles, selected, disabled, onChoose }: { profiles: NonNullable<Ma2NetworkStatus['profiles']>; selected: number; disabled: boolean; onChoose: (index: number) => void }): JSX.Element {
  return <Field label="最近使用">{props => <Select {...props} aria-label="已保存 MA2 控台" value={selected} disabled={disabled} onChange={event => onChoose(Number(event.target.value))}>
    <option value={-1}>其他控台</option>
    {profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.monitorPort}:${profile.username}`} value={index}>{profile.host} · {profile.username}</option>)}
  </Select>}</Field>;
}
