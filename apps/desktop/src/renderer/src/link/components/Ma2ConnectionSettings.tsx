import { SettingsDisclosure } from './SettingsControls';
import { Button } from './Button';
import { setMa2Method, useMa2ModeStore } from '../stores/ma2-mode-store';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { Download, FolderOpen, ScanSearch } from 'lucide-react';
import { connectLocalMa2, useLocalMa2Store } from '../stores/ma2-connection-store';
import { useEffect, useRef, useState } from 'react';
import { Ma2NetworkSettings } from './Ma2NetworkSettings';
import { Ma2CatalogSettings } from './Ma2CatalogSettings';
import { prepareMa2Editing } from '../runtime/ma2-editing-session';
import { useDocumentStore } from '../stores/document-store';
import { Ma2ProgramSettings } from './Ma2ProgramSettings';

export function Ma2ConnectionSettings({ disabled, notify, maintenanceHost, onMaintenance, onAudioSettings }: {
  disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void;
  onAudioSettings: () => void;
  maintenanceHost: HTMLDivElement | null; onMaintenance: () => void;
}): JSX.Element {
  const [directory, setDirectory] = useMa2Directory(notify);
  const method = useMa2ModeStore((state) => state.method);
  const networkVisited = useRef(false);
  if (method === 'network') networkVisited.current = true;
  const setMethod = async (value: 'midi' | 'local' | 'network'): Promise<void> => {
    setBusy(true);
    try { await setMa2Method(value); }
    catch (error) { notify(`切换连接方式失败：${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [networkConnected, setNetworkConnected] = useState(false);
  const exportPlugin = async (): Promise<void> => {
    setBusy(true);
    try { const path = await window.tbLink.exportMa2Plugin(); if (path) notify(`插件与安装说明已导出：${path}`); }
    catch (error) { notify(`导出控台插件失败：${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  const local = useLocalMa2Store();
  const status = local.directory !== directory.trim() ? '未连接' : local.status === 'ready' ? '插件已响应' : local.status === 'connecting' ? '连接中' : '未连接';
  const chooseDirectory = async (how: 'pick' | 'detect'): Promise<void> => {
    setBusy(true);
    try {
      const chosen = how === 'pick' ? await window.tbLink.pickMa2DataDirectory() : await window.tbLink.detectMa2DataDirectory();
      if (!chosen) return;
      setDirectory(chosen);
      useLocalMa2Store.setState({ status: 'disconnected' });
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const connectLocal = async (): Promise<void> => {
    if (busy || disabled) return;
    const documentId = useDocumentStore.getState().documentId;
    setBusy(true);
    try {
      if (!directory.trim()) throw new Error('请选择或一键识别本机 onPC 数据目录');
      await connectLocalMa2(directory.trim());
      notify(await prepareMa2Editing({ dataDirectory: directory.trim() }, documentId));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  return <section className="settings-section ma2-device-section" aria-label="MA2 连接设置">
    <div className="device-section-heading"><h3>连接</h3>{method === 'local' ? <span role="status">{status}</span> : null}</div>

    <label className="settings-path-row"><span>连接方式</span><select aria-label="MA2 连接方式" value={method} disabled={busy || networkBusy || disabled} onChange={(event) => void setMethod(event.target.value === 'midi' ? 'midi' : event.target.value === 'local' ? 'local' : 'network')}><option value="midi">仅 MIDI（时间码与 Cue）</option><option value="network">实体控台 / 网络 onPC</option><option value="local">本机 onPC</option></select></label>
    {method === 'midi' ? <div className="settings-connection-block"><div className="settings-connection-summary"><div className="settings-connection-copy"><h2>通过 MIDI 控制灯光</h2><p>发送时间码和 Cue 指令。请先选择要使用的 MIDI 端口。</p></div><Button className="primary-button" onClick={onAudioSettings}>选择 MIDI 端口</Button></div><p className="settings-note">需要读取控台里的 Cue？请把连接方式改为“实体控台 / 网络 onPC”。</p></div> : method === 'local' ? <>
      <label className="settings-row"><span>本机数据目录</span><div className="device-path-control">
        <input aria-label="MA2 onPC 数据目录" readOnly value={directory} placeholder="一键识别或选择 onPC 数据目录" />
        <button disabled={disabled || busy} onClick={() => void chooseDirectory('detect')}><ScanSearch />一键识别</button>
        <button disabled={disabled || busy} onClick={() => void chooseDirectory('pick')} aria-label="选择本机 onPC 数据目录"><FolderOpen />浏览</button>
      </div></label>
      <p className="settings-note settings-field-help">此方式通过文件插件通信。数据目录必须与当前运行的 onPC 版本一致，并在 onPC 中运行联动插件。也可切换到网络直连，填写 127.0.0.1。</p>
      {local.error ? <p className="device-error" role="alert">{local.error}</p> : null}
      <Button className="secondary-button" disabled={disabled || busy} onClick={() => void setMethod('network')}>改用本机网络直连</Button>
      <div className="device-actions"><Button className="primary-button" disabled={disabled || busy} onClick={() => void connectLocal()}>连接本机 onPC</Button></div>
    </> : null}
    {networkVisited.current ? <div hidden={method !== 'network'}><Ma2NetworkSettings onConnected={setNetworkConnected} onBusy={setNetworkBusy} disabled={disabled || method !== 'network'} notify={notify} maintenanceHost={method === 'network' ? maintenanceHost : null} onMaintenance={onMaintenance} /></div> : null}
    {method === 'midi' ? <SettingsDisclosure title="MIDI 连接说明" description="控台接收设置与 P1 歌曲导入"><p className="settings-note">在“音频与 MIDI”选择灯光时间码输出，并在控台选择对应时间码输入。需要触发 Cue 时，选择“灯光动作输出”，并在控台启用 MSC MIDI 接收。</p><p className="settings-note">仅 MIDI 不需要 IP、登录账号或联动插件。端口可用只表示电脑端正常；是否收到时间码，请在控台确认。</p><P1ProjectSyncPanel purpose="audio" disabled={disabled || busy} notify={notify} /></SettingsDisclosure> : null}
    {method !== 'midi' ? <SettingsDisclosure title="歌曲导入与同步"><Ma2CatalogSettings connected={method === 'local' ? status === '插件已响应' : networkConnected} method={method} directory={directory} disabled={disabled || networkBusy} notify={notify} onBusy={setBusy} /></SettingsDisclosure> : null}
    <SettingsDisclosure title="本机程序与预演"><Ma2ProgramSettings disabled={disabled || busy} notify={notify} /></SettingsDisclosure>
    {method === 'local' ? <SettingsDisclosure title="控台插件与安装说明"><div className="settings-row ma2-plugin-row"><span>控台插件</span><div><Button className="secondary-button" disabled={disabled || busy} onClick={() => void exportPlugin()}><Download />导出控台插件</Button><span className="settings-note">插件已内置，可离线导出到 U 盘；在控台导入 XML 与 Lua 后运行。仅 MIDI 时间码或 Cue 触发无需插件。</span></div></div></SettingsDisclosure> : null}
  </section>;
}

/** The directory the main process recorded; the window only shows it. */
function useMa2Directory(notify: (message: string, tone?: 'info' | 'error') => void): [string, (directory: string) => void] {
  const [directory, setDirectory] = useState('');
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    window.tbLink.getMa2DataDirectory().then(recorded => setDirectory(recorded ?? ''), (error: unknown) => notify(`读取 MA2 本机设置失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }, [notify]);
  return [directory, setDirectory];
}

