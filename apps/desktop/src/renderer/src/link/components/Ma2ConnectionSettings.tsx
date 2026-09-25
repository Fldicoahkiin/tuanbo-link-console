import { Button } from './Button';
import { setMa2Method, useMa2ModeStore } from '../stores/ma2-mode-store';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { Download } from 'lucide-react';
import { connectLocalMa2, useLocalMa2Store } from '../stores/ma2-connection-store';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Ma2NetworkSettings } from './Ma2NetworkSettings';
import { Ma2CatalogSettings } from './Ma2CatalogSettings';

const directoryKey = 'tblink.ma2-onpc-data-directory.v1';
export function Ma2ConnectionSettings({ disabled, notify, maintenanceHost, onMaintenance }: {
  disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void;
  maintenanceHost: HTMLDivElement | null; onMaintenance: () => void;
}): JSX.Element {
  const [directory, setDirectory] = useMa2Directory(notify);
  const method = useMa2ModeStore((state) => state.method);
  const setMethod = async (value: 'midi' | 'local' | 'network'): Promise<void> => {
    setBusy(true);
    try { await setMa2Method(value); }
    catch (error) { notify(`切换连接方式失败：${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const exportPlugin = async (): Promise<void> => {
    setBusy(true);
    try { const path = await window.tbLink.exportMa2Plugin(); if (path) notify(`插件与安装说明已导出：${path}`); }
    catch (error) { notify(`导出控台插件失败：${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
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
    <div className="device-section-heading"><h3>连接配置</h3>{method === 'local' ? <span role="status">{status}</span> : null}</div>
    {method === 'local' ? <div className="settings-row ma2-plugin-row"><span>控台插件</span><div><Button className="secondary-button" disabled={disabled || busy} onClick={() => void exportPlugin()}><Download />导出控台插件</Button><span className="settings-note">插件已内置，可离线导出到 U 盘；在控台导入 XML 与 Lua 后运行。仅 MIDI 时间码或 Cue 触发无需插件。</span></div></div> : null}
    <label className="settings-path-row"><span>连接方式</span><select aria-label="MA2 连接方式" value={method} disabled={busy || disabled} onChange={(event) => void setMethod(event.target.value === 'midi' ? 'midi' : event.target.value === 'local' ? 'local' : 'network')}><option value="midi">仅 MIDI（时间码与 Cue）</option><option value="network">实体控台 / 网络 onPC</option><option value="local">本机 onPC</option></select></label>
    {method === 'network' ? <p className="settings-note">连接网线，一键读取控台素材。首次使用需在控台开启远程登录。</p> : null}
    {method === 'midi' ? <p className="settings-note">声光同步与 Cue 触发均可使用 MIDI：在“音频与 MIDI”选择灯光 MIDI 输出，并在控台选择对应时间码输入。在联动台编排并直接触发 Cue 时，还需配置“灯光动作输出”，在控台启用 MSC MIDI 接收；无需填写 IP、登录控台或安装联动插件。MIDI 连接状态仅表示电脑端口可用，控台接收请在控台确认。</p> : method === 'network' ? <Ma2NetworkSettings disabled={disabled} notify={notify} maintenanceHost={maintenanceHost} onMaintenance={onMaintenance} /> : <>
      <label className="settings-row"><span>本机数据目录</span><input aria-label="MA2 onPC 数据目录" value={directory} disabled={disabled || busy} onChange={(event) => { setDirectory(event.target.value); useLocalMa2Store.setState({ status: 'disconnected' }); }} onBlur={saveDirectory} /></label>
      <p className="settings-note settings-field-help">选择本机 onPC 使用的数据目录，安装联动插件后检查连接。</p>
      <div className="device-actions"><Button className="primary-button" disabled={disabled || busy} onClick={() => void connectLocal()}>连接本机 onPC</Button></div>
    </>}
    {method === 'midi' ? <><p className="settings-note">MIDI 线只能传时间码和触发指令，无法读取控台 Cue 列表。要在导入 P1 后读取对应灯光，请选择“实体控台 / 网络 onPC”，完成网络连接。</p><P1ProjectSyncPanel purpose="audio" disabled={disabled || busy} notify={notify} /></> : null}
    {method !== 'midi' ? <Ma2CatalogSettings method={method} directory={directory} disabled={disabled} notify={notify} onBusy={setBusy} /> : null}
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

