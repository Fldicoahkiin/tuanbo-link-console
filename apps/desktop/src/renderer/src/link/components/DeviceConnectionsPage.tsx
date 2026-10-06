import { Button } from './Button';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LinkObsInventory } from '@tb/core/link';
import { useIntegrationStore } from '../stores/integration-store';
import { Ma2ConnectionSettings } from './Ma2ConnectionSettings';
import { ProjectMusicConnections } from './ProjectPlayerControls';
import { LightingMidiSettings } from './LightingMidiSettings';
import { LoopMidiSettings } from './LoopMidiSettings';
import { IntegrationFooter } from './IntegrationOverview';
import { LogsWorkspace } from './LogsWorkspace';
import { SongImportSettings } from './SongImportSettings';

import { SETTINGS_SECTIONS, type DeviceSettingsCategory } from './settings-navigation';

type Props = {
  selected: DeviceSettingsCategory;
  busy: boolean; runtimeActive: boolean; securityAvailable: boolean; internal: boolean;
  midiPorts: ReturnType<typeof useIntegrationStore.getState>['midiPorts']; inventory: LinkObsInventory | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onRefresh: () => void; onRefreshMidi: () => Promise<void>; onSave: () => void; onBusy: (busy: boolean) => void;
  children: ReactNode; maintenance: ReactNode; songTools: ReactNode;
};

export function DeviceConnectionsPage(props: Props): JSX.Element {
  const method = useMa2ModeStore((state) => state.method);
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
  if (selected === 'logs') return <section className="device-console settings-content-page" aria-label="运行日志设置"><LogsWorkspace notify={props.notify} /></section>;
  return <section className="device-console" data-device-category={selected} aria-label="设备连接工作区">
    <header className="device-console-header"><h2>设备连接</h2></header>
    {props.runtimeActive ? <p className="device-console-notice" role="status">演出运行中，连接参数已锁定。停止播放后可修改。</p> : null}
    <div className="device-console-layout">

      <div className="device-detail">
        <header className="device-detail-header"><div><h3>{current.name}</h3><p>{current.detail}</p></div>{selected === 'obs' ? <span className={`device-badge ${obs.status === 'connected' ? 'ready' : 'pending'}`}>{obs.status === 'connected' ? '已连接' : obs.status === 'error' ? '连接异常' : '未连接'}</span> : null}</header>
        <div data-settings-section="songs" hidden={selected !== 'songs'} className="device-panel"><SongImportSettings disabled={disabled} notify={props.notify}>{props.songTools}</SongImportSettings></div>
        <div data-settings-section="obs" hidden={selected !== 'obs'} className="device-panel" aria-label="OBS 设备面板">{props.children}</div>
        <div data-settings-section="ma2" hidden={selected !== 'ma2'} className="device-panel" aria-label="MA2 设备面板">
          <Ma2ConnectionSettings disabled={disabled} notify={props.notify} maintenanceHost={maintenanceHost} onMaintenance={openMa2Maintenance} />
          <LightingMidiSettings maintenance disabled={disabled} notify={props.notify} onBusy={props.onBusy} />
          {method !== 'midi' ? <details className="device-advanced"><summary>高级连接与插件维护</summary><div ref={setMaintenanceHost} /></details> : null}
        </div>
        <div data-settings-section="audio" hidden={selected !== 'audio'} className="device-panel" aria-label="音频与 MIDI 设备面板">
          <div className="device-panel-intro"><p>{props.internal ? '选择正式音乐的播放设备，以及发送时间码的 MIDI 端口。' : '当前跟随 P1 播放，设置时间码输入和灯光动作端口。'}</p><Button className="secondary-button" disabled={disabled} onClick={() => { void props.onRefreshMidi().catch((error: unknown) => props.notify(String(error), 'error')); }}><RefreshCw />刷新端口</Button></div>
          {props.internal ? <ProjectMusicConnections disabled={disabled} notify={props.notify} onBusy={props.onBusy}><LightingMidiSettings disabled={disabled} notify={props.notify} onBusy={props.onBusy} /></ProjectMusicConnections> : <LightingMidiSettings follow disabled={disabled} notify={props.notify} onBusy={props.onBusy} />}
        </div>
        <div data-settings-section="virtual" hidden={selected !== 'virtual'} className="device-panel" aria-label="虚拟 MIDI 设备面板"><LoopMidiSettings disabled={disabled} notify={props.notify} onBusy={props.onBusy} onRefreshMidi={props.onRefreshMidi} /></div>
        <div data-settings-section="maintenance" hidden={selected !== 'maintenance'} className="device-panel" role="region" aria-label="程序维护设备面板"><p className="device-panel-description">预览没有画面或软件无法启动 OBS / P1 时，在这里处理。查看错误和导出反馈文件，请到左侧“运行日志”。</p>{props.maintenance}<div className="device-panel-actions"><Button className="primary-button" disabled={disabled || !props.securityAvailable} onClick={props.onSave}>保存启动设置</Button><Button className="secondary-button" disabled={disabled} onClick={props.onRefresh}><RefreshCw />重新检测程序与设备</Button></div><IntegrationFooter midiPorts={props.midiPorts} inventory={props.inventory} /></div>
      </div>
    </div>
  </section>;
}
