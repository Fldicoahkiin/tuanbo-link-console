import { connectLocalMa2, useLocalMa2Store } from '../stores/ma2-connection-store';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Ma2NetworkSettings } from './Ma2NetworkSettings';

const directoryKey = 'tblink.ma2-onpc-data-directory.v1';
export function Ma2ConnectionSettings({ disabled, notify, maintenanceHost, onMaintenance }: {
  disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void;
  maintenanceHost: HTMLDivElement | null; onMaintenance: () => void;
}): JSX.Element {
  const [directory, setDirectory] = useMa2Directory(notify);
  const [method, setMethod] = useMa2Method(notify);
  const [busy, setBusy] = useState(false);
  const local = useLocalMa2Store();
  const status = local.directory !== directory.trim() ? '未连接' : local.status === 'ready' ? '插件已响应' : local.status === 'connecting' ? '连接中' : '未连接';
  const saveDirectory = (): void => {
    try { localStorage.setItem(directoryKey, directory.trim()); }
    catch (error) { notify(String(error), 'error'); }
  };
  const connectLocal = async (): Promise<void> => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (!directory.trim()) throw new Error('请填写本机 onPC 数据目录');
      saveDirectory();
      await connectLocalMa2(directory.trim());
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  return <section className="settings-section ma2-device-section" aria-label="MA2 连接设置">
    <div className="device-section-heading"><h3>MA2 控台</h3>{method === 'local' ? <span role="status">{status}</span> : null}</div>
    <label className="settings-path-row"><span>连接方式</span><select aria-label="MA2 连接方式" value={method} disabled={busy || disabled} onChange={(event) => setMethod(event.target.value === 'local' ? 'local' : 'network')}><option value="network">实体控台 / 网络 onPC</option><option value="local">本机 onPC</option></select></label>
    {method === 'network' ? <Ma2NetworkSettings disabled={disabled} notify={notify} maintenanceHost={maintenanceHost} onMaintenance={onMaintenance} /> : <>
      <label className="settings-row"><span>本机数据目录</span><input aria-label="MA2 onPC 数据目录" value={directory} disabled={disabled || busy} onChange={(event) => { setDirectory(event.target.value); useLocalMa2Store.setState({ status: 'disconnected' }); }} onBlur={saveDirectory} /></label>
      <p className="settings-note">选择本机 onPC 使用的数据目录，安装联动插件后检查连接。</p>
      <div className="device-actions"><button className="primary-button" disabled={disabled || busy} onClick={() => void connectLocal()}>连接本机 onPC</button><button className="secondary-button" disabled={disabled || busy} onClick={() => { void window.tbLink.exportMa2Plugin().then((path) => { if (path) notify(`插件已导出：${path}`); }).catch((error: unknown) => notify(String(error), 'error')); }}>导出控台插件</button></div>
    </>}
  </section>;
}

function useMa2Directory(notify: (message: string, tone?: 'info' | 'error') => void): [string, Dispatch<SetStateAction<string>>] {
  const value = useState('');
  const setDirectory = value[1];
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try { setDirectory(localStorage.getItem(directoryKey) ?? ''); }
    catch (error) { notify(`读取 MA2 本机设置失败：${String(error)}`, 'error'); }
  }, [notify, setDirectory]);
  return value;
}

function useMa2Method(notify: (message: string, tone?: 'info' | 'error') => void): ['local' | 'network', (value: 'local' | 'network') => void] {
  const [method, setMethod] = useState<'local' | 'network'>('network');
  useEffect(() => {
    try {
      const value = localStorage.getItem('tblink.ma2-connection-method.v1');
      if (value === 'local' || value === 'network') setMethod(value);
      else if (localStorage.getItem(directoryKey)) setMethod('local');
    } catch (error) { notify(`读取 MA2 连接方式失败：${String(error)}`, 'error'); }
  }, [notify]);
  return [method, (value) => {
    try { localStorage.setItem('tblink.ma2-connection-method.v1', value); setMethod(value); }
    catch (error) { notify(`保存 MA2 连接方式失败：${String(error)}`, 'error'); }
  }];
}
