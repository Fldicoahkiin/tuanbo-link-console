import { Ma2DiscoveryResults } from './Ma2DiscoveryResults';
import { Ma2ComputerNetwork, useMa2ComputerNetwork } from './Ma2ComputerNetwork';
import { Button } from './Button';
import { ma2AddressInput } from '../view-models/ma2-address-input';
import { checkNetworkMa2, connectDiscoveredMa2 } from '../stores/ma2-connection-store';
import { useDocumentStore } from '../stores/document-store';
import { prepareMa2Editing } from '../runtime/ma2-editing-session';
import { createPortal } from 'react-dom';
import { useEffect, useState, type JSX } from 'react';
import { ma2NetworkStatusSchema, ma2NetworkSaveSchema, ma2DiscoverySchema, type Ma2Discovery, type Ma2NetworkSettings as NetworkSettings, type Ma2NetworkStatus } from '@tb/schema';

export function Ma2NetworkSettings({ disabled, notify, maintenanceHost, onMaintenance }: { maintenanceHost: HTMLDivElement | null; onMaintenance: () => void; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const [error, setError] = useState('');
  const [pluginReady, setPluginReady] = useState(false);
  const [found, setFound] = useState<Ma2Discovery | null>(null);
  const [searching, setSearching] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(30000);
  const [monitorPort, setMonitorPort] = useState(30001);
  const [username, setUsername] = useState('administrator');
  const [password, setPassword] = useState('admin');
  const [passwordEdited, setPasswordEdited] = useState(true);
  const [autoConnect, setAutoConnect] = useState(false);
  const [status, setStatus] = useState<Ma2NetworkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const computerNetwork = useMa2ComputerNetwork();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (initial: boolean): Promise<void> => {
      try {
        const next = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
        if (!alive) return;
        setStatus(next);
        if (initial) {
          const settings = next.settings;
          if (settings) { setHost(settings.host); setPort(settings.port); setMonitorPort(settings.monitorPort); setUsername(settings.username); setAutoConnect(settings.autoConnect); setPassword(''); setPasswordEdited(false); }
          setLoaded(true);
        }
        // Connection setup already prepares the bundled bridge. Rendering settings
        // must not issue a second device probe alongside reads or synchronization.
        setPluginReady(next.state === 'connected' && (!next.capabilities || next.capabilities.plugin && next.capabilities.objects && next.capabilities.files));
        timer = setTimeout(() => void read(false), 1000);
      } catch (error) { if (alive) { const message = `读取 MA2 连接状态失败：${error instanceof Error ? error.message : String(error)}`; setError(message); notify(message, 'error'); } }
    };
    void read(true);
    return () => { alive = false; clearTimeout(timer); };
  }, [notify]);
  const choose = (profile?: NetworkSettings, address?: { host: string; port: number }): void => {
    setError('');
    setHost(profile?.host ?? address?.host ?? ''); setPort(profile?.port ?? address?.port ?? 30000); setMonitorPort(profile?.monitorPort ?? 30001);
    setUsername(profile?.username ?? 'administrator'); setAutoConnect(profile?.autoConnect ?? false); setPassword(profile ? '' : 'admin'); setPasswordEdited(!profile);
  };
  const automatic = async (): Promise<void> => {
    const documentId = useDocumentStore.getState().documentId;
    setBusy(true); setError(''); setProgress('正在发现控台并准备素材读取…');
    try {
      if (host.trim()) {
        const address = ma2AddressInput(host);
        const request = ma2NetworkSaveSchema.safeParse({ settings: { host: address, port, monitorPort, username: username.trim(), autoConnect }, ...(passwordEdited ? { password } : {}) });
        if (!request.success) throw new Error('请检查连接端口、用户名和密码；用户名和密码不能包含引号、反斜杠或换行');
        await window.tbLink.saveMa2Network(request.data); setHost(address); setPassword(''); setPasswordEdited(false);
      }
      const next = await connectDiscoveredMa2(setFound, address => computerNetwork.prepare(address, setProgress));
      setStatus(next);
      if (next.settings) choose(next.settings);
      if (!next.settings) throw new Error('控台连接缺少来源信息');
      const target = next.settings;
      setProgress('控台已连接，正在载入对应节目 Cue…');
      notify(await prepareMa2Editing({ dataDirectory: '', network: { host: target.host, port: target.port, monitorPort: target.monitorPort, username: target.username } }, documentId));
    } catch (failure) { setAdvancedOpen(true); setError(failure instanceof Error ? failure.message : '连接未完成，请检查网线和控台设置'); }
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
    setBusy(true); setError(''); setProgress('正在保存连接设置…');
    try {
      const address = ma2AddressInput(host);
      const parsed = ma2NetworkSaveSchema.safeParse({ settings: { host: address, port, monitorPort, username: username.trim(), autoConnect }, ...(passwordEdited ? { password } : {}) });
      if (!parsed.success) throw new Error('请填写有效的控台 IPv4 地址、端口与用户名；用户名和密码不能包含引号、反斜杠或换行');
      const saved = ma2NetworkStatusSchema.parse(await window.tbLink.saveMa2Network(parsed.data));
      setHost(address); setPassword(''); setPasswordEdited(false); setStatus(saved);
      if (connect) {
        await computerNetwork.prepare(address, setProgress);
        setProgress(`正在连接 ${host.trim()}:${port}，并验证登录…`);
        setPluginReady(false);
        const connected = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
        setStatus(connected);
        if (connected.error) { setError(connected.error); notify(connected.error, 'error'); }
        else if (connected.state === 'connected') {
          setProgress('控台已连接，正在载入对应节目 Cue…');
          notify(await prepareMa2Editing({ dataDirectory: '', network: { host: address, port, monitorPort, username: username.trim() } }, documentId));
        }
        else { const message = 'MA2 未建立连接，请检查控台远程设置和网络后重新连接'; setError(message); notify(message, 'error'); }
      } else notify('MA2 连接设置已保存');
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message, 'error'); }
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
  const dirty = status?.settings ? !matching || passwordEdited || autoConnect !== status.settings.autoConnect : Boolean(host.trim() || username.trim() || passwordEdited || autoConnect || port !== 30000 || monitorPort !== 30001);
  const connectionLabel = busy || matching && (status?.state === 'connecting' || status?.state === 'authenticating') ? '连接中' : connected ? '已连接' : '未连接';

  const profiles = status?.profiles ?? [];
  const selected = profiles.findIndex((profile) => profile.host === host && profile.port === port && profile.monitorPort === monitorPort && profile.username === username);
  return <div className="ma2-network-settings">
    <Button className="primary-button" disabled={locked || searching} onClick={() => void automatic()}>{busy ? '正在连接并载入…' : '连接 MA2 并载入节目 Cue'}</Button>
    <span className="ma2-device-status" role="status">{connectionLabel}</span>
    <p className="settings-note">插好网线后点击自动连接，软件会检查并配置电脑网卡。{status?.settings ? `当前控台 ${status.settings.host}。` : '首次连接会搜索控台；搜不到时只需填写一次控台 IP。'} MIDI 接口用于时间码与触发。</p>

    <details className="ma2-advanced-settings" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary>手动连接与网卡设置（备用）</summary>
    <Ma2ComputerNetwork network={computerNetwork} disabled={locked || searching} run={runNetwork} />
    <div className="ma2-saved-row"><label><span>已保存控台</span><select aria-label="已保存 MA2 控台" value={selected} disabled={locked || searching} onChange={(event) => choose(profiles[Number(event.target.value)])}><option value={-1}>添加控台</option>{profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.monitorPort}:${profile.username}`} value={index}>{profile.host}:{profile.port} · {profile.username}</option>)}</select></label><div className="settings-header-actions"><Button className="secondary-button" disabled={locked || searching} onClick={() => void search()}>{searching ? '搜索中…' : '搜索局域网控台'}</Button>{searching ? <button onClick={() => { void window.tbLink.cancelMa2Discovery().catch((error: unknown) => notify(String(error), 'error')); }}>取消搜索</button> : null}</div></div>
    {found ? <Ma2DiscoveryResults result={found} disabled={locked} selectedHost={host} onChoose={address => choose(profiles.find(profile => profile.host === address.host && profile.port === address.port), address)} /> : null}

    <details className="ma2-operation-help"><summary>网络连接说明</summary><p className="settings-note">读取控台 Cue 和双向同步需要电脑与控台接入同一局域网，可用网线直连或接同一交换机。控台开启 Setup → Console → Global Settings → Telnet → Login Enabled。登录用户在 Setup → Console → User &amp; Profiles Setup 中查看或新建，填写该用户的密码；未设密码才留空。</p></details>
    <div className="ma2-network-fields">
      <label><span>控台 IP</span><input aria-label="MA2 控台 IP" placeholder="192.168.0.10" value={host} disabled={locked} onChange={(event) => { setError(''); setHost(event.target.value); }} /></label>
      <label><span>登录用户</span><input aria-label="MA2 登录用户" autoComplete="off" value={username} disabled={locked} onChange={(event) => { setError(''); setUsername(event.target.value); setPassword(''); setPasswordEdited(false); }} /></label>
      <label><span>登录密码</span><input aria-label="MA2 登录密码" type="text" autoComplete="off" spellCheck={false} placeholder={matching && status?.passwordSaved ? '已安全保存，留空不修改' : '没有密码可留空'} value={password} disabled={locked} onChange={(event) => { setPassword(event.target.value); setPasswordEdited(true); }} /></label>
      <label><span>启动时连接</span><input aria-label="启动时自动连接 MA2" type="checkbox" checked={autoConnect} disabled={locked} onChange={(event) => setAutoConnect(event.target.checked)} /></label>
    </div>

    <div className="device-actions"><Button className="secondary-button" disabled={locked} onClick={() => { setUsername('administrator'); setPassword('admin'); setPasswordEdited(true); setError(''); }}>使用默认账号</Button><span className="settings-note">MA2 默认：administrator / admin。自定义用户请填写自己的密码。</span></div>

    <div className="settings-header-actions device-actions">{connected && !dirty ? <Button className="secondary-button" disabled={locked} onClick={() => void disconnect()}>断开</Button> : <Button className="primary-button" disabled={locked || searching} onClick={() => void save(true)}>{busy ? '连接中…' : '保存并连接'}</Button>}{dirty ? <Button className="secondary-button" disabled={locked || searching} onClick={() => void save(false)}>仅保存</Button> : null}</div>
    {connected ? <div className="device-actions"><Button className="secondary-button" disabled={locked} onClick={() => void check()}>检查连接</Button><span role="status">{pluginReady ? '连接正常，可以读取控台素材' : '正在准备内置通信桥'}</span>{!pluginReady ? <Button className="secondary-button" onClick={onMaintenance}>连接维护</Button> : null}</div> : null}
    </details>
    {progress ? <p className="settings-note" role="status">{progress}</p> : null}
    {error || matching && status?.error ? <p className="device-error" role="alert">{error || status?.error}</p> : null}

    {maintenanceHost ? createPortal(
    <section className="ma2-protocol"><div className="device-section-heading"><h3>MA2 控台</h3><span>{host || '未选择控台'}</span></div>    <div className="settings-header-actions"><Button className="secondary-button" disabled={locked || !matching || status?.state !== 'connected'} onClick={() => void check()}>检测版本兼容性</Button></div>
    {matching && status?.capabilities ? <p role="status">MA2 {status.capabilities.version} · {status.capabilities.lua} · {status.capabilities.message}</p> : null}
<label className="settings-path-row"><span>远程端口</span><input aria-label="MA2 远程端口" type="number" min={1} max={65535} value={Number.isNaN(port) ? '' : port} disabled={locked} onChange={(event) => { setPort(event.target.valueAsNumber); }} /></label><label className="settings-path-row"><span>监视端口</span><input aria-label="MA2 监视端口" type="number" min={1} max={65535} value={Number.isNaN(monitorPort) ? '' : monitorPort} disabled={locked} onChange={(event) => { setMonitorPort(event.target.valueAsNumber); }} /></label><div className="device-actions">{dirty ? <button disabled={locked} onClick={() => void save(false)}>保存连接配置</button> : null}</div></section>, maintenanceHost) : null}
  </div>;
}

