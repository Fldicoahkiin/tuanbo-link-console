import { Button } from './Button';
import { ModalSurface } from './ModalSurface';
import type { SettingsCategory } from './settings-navigation';

function guidance(issue: string): { category: SettingsCategory; label: string; detail: string } {
  if (/HiRender P1|可执行文件|程序路径|启动失败/.test(issue)) return { category: 'maintenance', label: '设置程序位置', detail: '影响外部程序的自动启动。在程序维护中选择实际安装的程序文件，保存启动设置后重新连接。' };
  if (/OBS/i.test(issue)) return { category: 'obs', label: '打开 OBS 设置', detail: '影响 OBS 画面或动作连接。启动 OBS，在工具 → WebSocket 服务器设置中核对启用状态、端口和密码。' };
  if (/MA2/i.test(issue)) return { category: 'ma2', label: '打开控台设置', detail: '影响控台 Cue 读取或网络同步。核对连接方式、控台地址和 Show 用户；已登录但插件未就绪时，在控台运行插件后检查通信。' };
  if (/loopMIDI|虚拟/i.test(issue)) return { category: 'virtual', label: '打开虚拟 MIDI 设置', detail: '影响软件间的虚拟 MIDI 链路。核对虚拟端口；实体控台的 MIDI 线在音频与 MIDI 中选择。' };
  if (/MIDI|时间码|灯光|P1/i.test(issue)) return { category: 'audio', label: '打开音频与 MIDI', detail: '影响对应的时间码、灯光触发或播放控制链路。检查接口和驱动，刷新设备并选择实际连接的端口；多个端口时需要手动确认。' };
  return { category: 'logs', label: '查看运行日志', detail: '该检查未完成。请在运行日志中查看错误，或导出诊断包发回排查。处理后手动重新检查连接。' };
}

export function ConnectionResult({ issues, onClose, onResolve, onRetry }: { issues: readonly string[]; onClose: () => void; onResolve: (category: SettingsCategory) => void; onRetry: () => void }): JSX.Element {
  return <ModalSurface className="modal-card" label="设备连接检查结果" onClose={onClose}>
    <h2>{issues.length ? `${issues.length} 项连接需要处理` : '设备连接检查完成'}</h2>
    <p>这是设备连接结果。未就绪项影响下面列出的功能；播放和布防仍会检查当前节目实际需要的设备。</p>
    <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
      {issues.map((issue, index) => { const help = guidance(issue); return <section className="settings-section" key={`${index}:${issue}`}><h3>{index + 1}. {issue}</h3><p>{help.detail}</p><Button className="secondary-button" onClick={() => onResolve(help.category)}>{help.label}</Button></section>; })}
    </div>
    <div className="modal-actions"><Button className="secondary-button" onClick={onClose}>关闭</Button><Button className="primary-button" onClick={onRetry}>重新检查连接</Button></div>
  </ModalSurface>;
}
