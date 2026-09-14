import { useState, type ReactNode } from 'react';
import { RefreshCw, ScanSearch } from 'lucide-react';
import type { LinkObsInventory } from '@tb/core/link';
import { useIntegrationStore } from '../stores/integration-store';
import { Ma2ConnectionSettings } from './Ma2ConnectionSettings';
import { ProjectMusicConnections } from './ProjectPlayerControls';
import { LightingMidiSettings } from './LightingMidiSettings';
import { LoopMidiSettings } from './LoopMidiSettings';
import { IntegrationFooter } from './IntegrationOverview';

import { SETTINGS_SECTIONS, type DeviceSettingsCategory } from './settings-navigation';

type Props = {
  selected: DeviceSettingsCategory;
  busy: boolean; runtimeActive: boolean; securityAvailable: boolean; internal: boolean;
  midiPorts: ReturnType<typeof useIntegrationStore.getState>['midiPorts']; inventory: LinkObsInventory | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onConnect: () => void; onRefresh: () => void; onRefreshMidi: () => Promise<void>; onSave: () => void; onBusy: (busy: boolean) => void;
  children: ReactNode; maintenance: ReactNode;
};

export function DeviceConnectionsPage(props: Props): JSX.Element {
  const selected = props.selected;
  const [maintenanceHost, setMaintenanceHost] = useState<HTMLDivElement | null>(null);
  const obs = useIntegrationStore((state) => state.obs);
  const disabled = props.busy || props.runtimeActive;
  const current = SETTINGS_SECTIONS.find((device) => device.id === selected)!;
  const openMa2Maintenance = (): void => {
    const details = maintenanceHost?.closest('details');
    if (details) details.open = true;
    maintenanceHost?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  return <section className="device-console" aria-label="设备连接工作区">
    <header className="device-console-header"><div><span className="device-eyebrow">工作环境</span><h2>设备连接</h2><p>配置演出设备，检查连接与信号状态。</p></div><button className="primary-button" disabled={disabled || !props.securityAvailable} onClick={props.onConnect}><ScanSearch />{props.busy ? '正在处理…' : '一键连接设备'}</button></header>
    {props.runtimeActive ? <p className="device-console-notice" role="status">演出运行中，连接参数已锁定。停止播放后可修改。</p> : null}
    <div className="device-console-layout">

      <div className="device-detail">
        <header className="device-detail-header"><div><h3>{current.name}</h3><p>{current.detail}</p></div>{selected === 'obs' ? <span className={`device-badge ${obs.status === 'connected' ? 'ready' : 'pending'}`}>{obs.status === 'connected' ? '已连接' : obs.status === 'error' ? '连接异常' : '未连接'}</span> : null}</header>
        <div hidden={selected !== 'obs'} className="device-panel" aria-label="OBS 设备面板">{props.children}</div>
        <div hidden={selected !== 'ma2'} className="device-panel" aria-label="MA2 设备面板">
          <Ma2ConnectionSettings disabled={disabled} notify={props.notify} maintenanceHost={maintenanceHost} onMaintenance={openMa2Maintenance} />
          <details className="device-advanced"><summary>高级连接与插件维护</summary><div ref={setMaintenanceHost} /><LightingMidiSettings maintenance disabled={disabled} notify={props.notify} onBusy={props.onBusy} /></details>
        </div>
        <div hidden={selected !== 'audio'} className="device-panel" aria-label="音频与 MIDI 设备面板">
          <div className="device-panel-intro"><p>{props.internal ? '选择正式音乐的播放设备，以及发送时间码的 MIDI 端口。' : '当前跟随 P1 播放，设置时间码输入和灯光动作端口。'}</p><button className="secondary-button" disabled={disabled} onClick={() => { void props.onRefreshMidi().catch((error: unknown) => props.notify(String(error), 'error')); }}><RefreshCw />刷新端口</button></div>
          {props.internal ? <ProjectMusicConnections disabled={disabled} notify={props.notify} onBusy={props.onBusy}><LightingMidiSettings disabled={disabled} notify={props.notify} onBusy={props.onBusy} /></ProjectMusicConnections> : <LightingMidiSettings follow disabled={disabled} notify={props.notify} onBusy={props.onBusy} />}
        </div>
        <div hidden={selected !== 'virtual'} className="device-panel" aria-label="虚拟 MIDI 设备面板"><LoopMidiSettings disabled={disabled} notify={props.notify} onBusy={props.onBusy} onRefreshMidi={props.onRefreshMidi} /></div>
        <div hidden={selected !== 'maintenance'} className="device-panel" aria-label="高级与诊断设备面板"><p className="device-panel-description">程序位置、启动参数和设备资源。常用连接请在左侧选择对应设备。</p>{props.maintenance}<div className="device-panel-actions"><button className="primary-button" disabled={disabled || !props.securityAvailable} onClick={props.onSave}>保存本机配置</button><button className="secondary-button" disabled={disabled} onClick={props.onRefresh}><RefreshCw />刷新设备状态</button></div><IntegrationFooter midiPorts={props.midiPorts} inventory={props.inventory} /></div>
      </div>
    </div>
  </section>;
}
