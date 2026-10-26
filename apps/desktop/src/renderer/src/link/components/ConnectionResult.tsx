import { Button } from './Button';
import { ModalSurface } from './ModalSurface';
import type { SettingsCategory } from './settings-navigation';

function guidance(issue: string): { category: SettingsCategory; label: string; detail: string } {
  if (/HiRender P1|可执行文件|程序路径|启动失败/.test(issue)) return { category: 'maintenance', label: '设置程序位置', detail: '外部程序无法自动启动。请在「程序维护」里选择程序的实际安装位置，保存后重新连接。' };
  if (/OBS/i.test(issue)) return { category: 'obs', label: '打开 OBS 设置', detail: '会影响 OBS 画面和动作。请先打开 OBS，在“工具 → WebSocket 服务器设置”里确认已启用，并检查端口和密码。' };
  if (/MA2/i.test(issue)) return { category: 'ma2', label: '打开控台设置', detail: '会影响读取控台 Cue 和网络同步。请检查连接方式、控台地址和 Show 用户；如果已经登录但插件没有响应，请在控台上运行插件后再检查。' };
  if (/loopMIDI|虚拟/i.test(issue)) return { category: 'virtual', label: '打开虚拟 MIDI 设置', detail: '会影响软件之间的虚拟 MIDI 连接。请检查虚拟端口；接实体控台的 MIDI 线请在「音频与 MIDI」里选择。' };
  if (/MIDI|时间码|灯光|P1/i.test(issue)) return { category: 'audio', label: '打开音频与 MIDI', detail: '会影响时间码、灯光触发或播放控制。请检查接口和驱动，刷新设备后选择实际连接的端口；有多个端口时需要手动选定。' };
  return { category: 'logs', label: '查看运行日志', detail: '这项检查没有完成。请在运行日志里查看原因，或导出诊断包发给售后。处理好后重新检查连接。' };
}

export function ConnectionResult({ issues, onClose, onResolve, onRetry }: { issues: readonly string[]; onClose: () => void; onResolve: (category: SettingsCategory) => void; onRetry: () => void }): JSX.Element {
  return <ModalSurface className="modal-card" label="设备连接检查结果" onClose={onClose}>
    <h2>{issues.length ? `${issues.length} 项连接需要处理` : '设备连接检查完成'}</h2>
    <p>下面这些设备还没准备好，会影响对应的功能。开始播放前，联动台还会再检查当前节目实际用到的设备。</p>
    <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
      {issues.map((issue, index) => { const help = guidance(issue); return <section className="settings-section" key={`${index}:${issue}`}><h3>{index + 1}. {issue}</h3><p>{help.detail}</p><Button className="secondary-button" onClick={() => onResolve(help.category)}>{help.label}</Button></section>; })}
    </div>
    <div className="modal-actions"><Button className="secondary-button" onClick={onClose}>关闭</Button><Button className="primary-button" onClick={onRetry}>重新检查连接</Button></div>
  </ModalSurface>;
}
