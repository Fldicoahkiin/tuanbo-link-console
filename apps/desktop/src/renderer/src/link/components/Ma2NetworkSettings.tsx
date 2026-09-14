import { checkNetworkMa2 } from '../stores/ma2-connection-store';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type JSX } from 'react';
import { ma2NetworkStatusSchema, ma2NetworkSaveSchema, ma2DiscoverySchema, type Ma2Discovery, type Ma2NetworkSettings as NetworkSettings, type Ma2NetworkStatus } from '@tb/schema';

export function Ma2NetworkSettings({ disabled, notify, maintenanceHost, onMaintenance }: { maintenanceHost: HTMLDivElement | null; onMaintenance: () => void; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const [error, setError] = useState('');
  const [pluginReady, setPluginReady] = useState(false);
  const checkedConnection = useRef(false);
  const [found, setFound] = useState<Ma2Discovery | null>(null);
  const [searching, setSearching] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(30000);
  const [monitorPort, setMonitorPort] = useState(30001);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordEdited, setPasswordEdited] = useState(false);
  const [autoConnect, setAutoConnect] = useState(false);
  const [status, setStatus] = useState<Ma2NetworkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
          if (settings) { setHost(settings.host); setPort(settings.port); setMonitorPort(settings.monitorPort); setUsername(settings.username); setAutoConnect(settings.autoConnect); }
          setLoaded(true);
        }
        if (next.state !== 'connected') { checkedConnection.current = false; setPluginReady(false); }
        else if (!checkedConnection.current) {
          checkedConnection.current = true;
          try {
            const checked = await checkNetworkMa2();
            if (!alive) return;
            setStatus(checked);
            if (!checked.settings) throw new Error('控台目标不可用');
            if (alive) { setPluginReady(true); setError(''); }
          } catch (failure) { if (alive) { setPluginReady(false); setError(`已连接，但插件未就绪：${failure instanceof Error ? failure.message : String(failure)}`); } }
        }
        timer = setTimeout(() => void read(false), 1000);
      } catch (error) { if (alive) notify(`读取 MA2 连接状态失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    };
    void read(true);
    return () => { alive = false; clearTimeout(timer); };
  }, [notify]);
  const choose = (profile?: NetworkSettings, address?: { host: string; port: number }): void => {
    setError('');
    setHost(profile?.host ?? address?.host ?? ''); setPort(profile?.port ?? address?.port ?? 30000); setMonitorPort(profile?.monitorPort ?? 30001);
    setUsername(profile?.username ?? ''); setAutoConnect(profile?.autoConnect ?? false); setPassword(''); setPasswordEdited(false);
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
    setBusy(true); setError('');
    try {
      const parsed = ma2NetworkSaveSchema.safeParse({ settings: { host: host.trim(), port, monitorPort, username: username.trim(), autoConnect }, ...(passwordEdited ? { password } : {}) });
      if (!parsed.success) throw new Error('请填写有效的控台 IPv4 地址、端口与用户名；用户名和密码不能包含引号、反斜杠或换行');
      const saved = ma2NetworkStatusSchema.parse(await window.tbLink.saveMa2Network(parsed.data));
      setPassword(''); setPasswordEdited(false); setStatus(saved);
      if (connect) {
        checkedConnection.current = false; setPluginReady(false);
        const connected = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
        setStatus(connected);
        if (connected.error) notify(connected.error, 'error');
      } else notify('MA2 连接设置已保存');
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const disconnect = async (): Promise<void> => {
    try { setStatus(ma2NetworkStatusSchema.parse(await window.tbLink.disconnectMa2Network())); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setError(message); notify(message, 'error'); }
  };
  const locked = disabled || busy || !loaded;
  const matching = status?.settings?.host === host.trim() && status.settings.port === port && status.settings.monitorPort === monitorPort && status.settings.username === username.trim();
  const connected = matching && status?.state === 'connected';
  const dirty = status?.settings ? !matching || passwordEdited || autoConnect !== status.settings.autoConnect : Boolean(host.trim() || username.trim() || passwordEdited || autoConnect || port !== 30000 || monitorPort !== 30001);
  const connectionLabel = busy || matching && (status?.state === 'connecting' || status?.state === 'authenticating') ? '连接中' : connected ? pluginReady ? '已连接' : '已连接但插件未就绪' : '未连接';

  const profiles = status?.profiles ?? [];
  const selected = profiles.findIndex((profile) => profile.host === host && profile.port === port && profile.monitorPort === monitorPort && profile.username === username);
  return <div className="ma2-network-settings">
    <span className="ma2-device-status" role="status">{connectionLabel}</span>

    <div className="ma2-saved-row"><label><span>已保存控台</span><select aria-label="已保存 MA2 控台" value={selected} disabled={locked || searching} onChange={(event) => choose(profiles[Number(event.target.value)])}><option value={-1}>添加控台</option>{profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.monitorPort}:${profile.username}`} value={index}>{profile.host}:{profile.port} · {profile.username}</option>)}</select></label><div className="settings-header-actions"><button className="secondary-button" disabled={locked || searching} onClick={() => void search()}>{searching ? '搜索中…' : '搜索局域网控台'}</button>{searching ? <button onClick={() => { void window.tbLink.cancelMa2Discovery().catch((error: unknown) => notify(String(error), 'error')); }}>取消搜索</button> : null}</div></div>
    {found ? <div aria-label="MA2 搜索结果"><p className="settings-note">{found.hosts.length ? `发现 ${found.hosts.length} 个地址，请选择控台。` : '未发现开放远程端口的控台，请检查网线、IP 网段和控台 Telnet 设置，或手动填写地址。'}</p>{found.hosts.map((address) => <button className="secondary-button" key={`${address.host}:${address.port}`} disabled={locked} onClick={() => choose(profiles.find((profile) => profile.host === address.host && profile.port === address.port), address)}>{address.host}:{address.port} · {address.identity === 'ma2' ? 'MA2 远程入口' : '待确认设备'}</button>)}{found.warnings.length ? <p className="device-error" role="alert">{found.warnings.join('；')}</p> : null}</div> : null}

    <div className="ma2-network-fields">
      <label><span>控台 IP</span><input aria-label="MA2 控台 IP" placeholder="192.168.0.10" value={host} disabled={locked} onChange={(event) => { setError(''); setHost(event.target.value); setPassword(''); setPasswordEdited(false); }} /></label>
      <label><span>登录用户</span><input aria-label="MA2 登录用户" autoComplete="off" value={username} disabled={locked} onChange={(event) => { setError(''); setUsername(event.target.value); setPassword(''); setPasswordEdited(false); }} /></label>
      <label><span>登录密码</span><input aria-label="MA2 登录密码" type="password" autoComplete="new-password" placeholder={matching && status?.passwordSaved ? '已安全保存，留空不修改' : '没有密码可留空'} value={password} disabled={locked} onChange={(event) => { setPassword(event.target.value); setPasswordEdited(true); }} /></label>
      <label><span>启动时连接</span><input aria-label="启动时自动连接 MA2" type="checkbox" checked={autoConnect} disabled={locked} onChange={(event) => setAutoConnect(event.target.checked)} /></label>
    </div>

    <div className="settings-header-actions device-actions">{connected && !dirty ? <button className="secondary-button" disabled={locked} onClick={() => void disconnect()}>断开</button> : <button className="primary-button" disabled={locked || searching} onClick={() => void save(true)}>{busy ? '连接中…' : '保存并连接'}</button>}{dirty ? <button className="secondary-button" disabled={locked || searching} onClick={() => void save(false)}>仅保存</button> : null}</div>
    {error || matching && status?.error ? <p className="device-error" role="alert">{error || status?.error}</p> : null}
    {connected && !pluginReady ? <div className="device-actions"><button className="secondary-button" onClick={onMaintenance}>连接维护</button></div> : null}
    {maintenanceHost ? createPortal(
    <section className="ma2-protocol"><div className="device-section-heading"><h3>MA2 控台</h3><span>{host || '未选择控台'}</span></div><div className="settings-header-actions ma2-plugin-actions"><button className="secondary-button" disabled={locked} onClick={() => { void window.tbLink.exportMa2Plugin().then((path) => { if (path) notify(`插件已导出：${path}`); }).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error')); }}>导出控台插件</button></div>    <div className="settings-header-actions"><button className="secondary-button" disabled={locked || !matching || status?.state !== 'connected'} onClick={() => void check()}>检测版本兼容性</button></div>
    {matching && status?.capabilities ? <p role="status">MA2 {status.capabilities.version} · {status.capabilities.lua} · {status.capabilities.message}</p> : null}
<label className="settings-path-row"><span>远程端口</span><input aria-label="MA2 远程端口" type="number" min={1} max={65535} value={Number.isNaN(port) ? '' : port} disabled={locked} onChange={(event) => { setPort(event.target.valueAsNumber); }} /></label><label className="settings-path-row"><span>监视端口</span><input aria-label="MA2 监视端口" type="number" min={1} max={65535} value={Number.isNaN(monitorPort) ? '' : monitorPort} disabled={locked} onChange={(event) => { setMonitorPort(event.target.valueAsNumber); }} /></label><div className="device-actions">{dirty ? <button disabled={locked} onClick={() => void save(false)}>保存连接配置</button> : null}</div></section>, maintenanceHost) : null}
  </div>;
}

