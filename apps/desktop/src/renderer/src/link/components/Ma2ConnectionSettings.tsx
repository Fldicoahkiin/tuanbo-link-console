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
    <div className="settings-row ma2-plugin-row"><span>控台插件</span><div><Button className="secondary-button" disabled={disabled || busy} onClick={() => void exportPlugin()}><Download />导出控台插件</Button><span className="settings-note">插件已内置，可离线导出到 U 盘；在控台导入 XML 与 Lua 后运行。仅 MIDI 时间码或 Cue 触发无需插件。</span></div></div>
    <label className="settings-path-row"><span>连接方式</span><select aria-label="MA2 连接方式" value={method} disabled={busy || disabled} onChange={(event) => void setMethod(event.target.value === 'midi' ? 'midi' : event.target.value === 'local' ? 'local' : 'network')}><option value="midi">仅 MIDI（时间码与 Cue）</option><option value="network">实体控台 / 网络 onPC</option><option value="local">本机 onPC</option></select></label>
    {method === 'network' ? <details className="ma2-operation-help" aria-label="首次连接控台步骤"><summary>首次安装与导入步骤</summary><ol><li>点击上方“导出控台插件”，将导出的 XML、Lua 放在 U 盘的 MA2 插件目录中。</li><li>在控台 Plugin 池的空闲位置导入 tblink_bridge.xml，运行插件并保存 Show。首次安装完成后，日常读取通过网线进行。</li><li>电脑与控台接入同一局域网，开启控台 Telnet 登录，填写 Show 用户并连接。网络登录成功后还需检查插件通信。</li><li>在下方选择 P1 的 .hia 工程，自动导入音乐并读取、配对灯光；查看逐首导入结果，处理未配对项。</li><li>保留 MIDI 线，在“音频与 MIDI”选择 MTC 输出。播放时核对控台时间码是否走动，再验证灯光动作。</li></ol><p className="settings-note">插件随软件内置，但需在实体控台首次导入；搜索控台不会自动安装插件或获取账号密码。</p></details> : null}
    {method === 'midi' ? <p className="settings-note">声光同步与 Cue 触发均可使用 MIDI：在“音频与 MIDI”选择灯光 MIDI 输出，并在控台选择对应时间码输入。在联动台编排并直接触发 Cue 时，还需配置“灯光动作输出”，在控台启用 MSC MIDI 接收；无需填写 IP、登录控台或安装联动插件。MIDI 连接状态仅表示电脑端口可用，控台接收请在控台确认。</p> : method === 'network' ? <Ma2NetworkSettings disabled={disabled} notify={notify} maintenanceHost={maintenanceHost} onMaintenance={onMaintenance} /> : <>
      <label className="settings-row"><span>本机数据目录</span><input aria-label="MA2 onPC 数据目录" value={directory} disabled={disabled || busy} onChange={(event) => { setDirectory(event.target.value); useLocalMa2Store.setState({ status: 'disconnected' }); }} onBlur={saveDirectory} /></label>
      <p className="settings-note settings-field-help">选择本机 onPC 使用的数据目录，安装联动插件后检查连接。</p>
      <div className="device-actions"><Button className="primary-button" disabled={disabled || busy} onClick={() => void connectLocal()}>连接本机 onPC</Button></div>
    </>}
    {method === 'midi' ? <><p className="settings-note">MIDI 线只能传时间码和触发指令，无法读取控台 Cue 列表。要在导入 P1 后读取对应灯光，请选择“实体控台 / 网络 onPC”，完成插件安装和网络连接。</p><P1ProjectSyncPanel purpose="audio" disabled={disabled || busy} notify={notify} /></> : null}
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

