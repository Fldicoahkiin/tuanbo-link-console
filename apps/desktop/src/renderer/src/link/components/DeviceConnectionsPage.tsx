import { Button } from '../ui/Button';
import { ArchiveSettings } from './ArchiveSettings';
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
import { SongImportSettings } from './SongImportSettings';
import { SettingsPageHeader, SettingsFeedback, SettingsDisclosure } from './SettingsControls';

import { SETTINGS_SECTIONS, settingsScope, type DeviceSettingsCategory } from './settings-navigation';

type Props = {
  selected: DeviceSettingsCategory;
  busy: boolean; runtimeActive: boolean; securityAvailable: boolean; internal: boolean;
  midiPorts: ReturnType<typeof useIntegrationStore.getState>['midiPorts']; inventory: LinkObsInventory | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onRefresh: () => void; onRefreshMidi: () => Promise<void>; onSave: () => void; onBusy: (busy: boolean) => void;
  children: ReactNode; maintenance: ReactNode; songTools: ReactNode;
  onNavigate: (category: DeviceSettingsCategory) => void;
};

export function DeviceConnectionsPage(props: Props): JSX.Element {
  const method = useMa2ModeStore((state) => state.method);
  const selected = props.selected;
  const [maintenanceHost, setMaintenanceHost] = useState<HTMLDivElement | null>(null);
  const [refreshingMidi, setRefreshingMidi] = useState(false);
  const disabled = props.busy || props.runtimeActive;
  const current = SETTINGS_SECTIONS.find((device) => device.id === selected)!;
  const refreshMidi = async (): Promise<void> => {
    if (refreshingMidi) return;
    setRefreshingMidi(true); props.onBusy(true);
    try { await props.onRefreshMidi(); }
    catch (error) { props.notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setRefreshingMidi(false); props.onBusy(false); }
  };
  const openMa2Maintenance = (): void => {
    const details = maintenanceHost?.closest('details');
    if (details) details.open = true;
    maintenanceHost?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  return <section className="device-console" data-device-category={selected} aria-label="设备连接工作区">
    <SettingsPageHeader title={current.name} description={current.detail} scope={settingsScope(selected)} />
    {props.runtimeActive ? <SettingsFeedback tone="warning">正在演出，连接设置已锁定，停止播放后才能修改。</SettingsFeedback> : null}
    {!props.securityAvailable && (selected === 'obs' || selected === 'maintenance') ? <SettingsFeedback tone="warning">Windows 安全存储不可用，暂时无法保存 OBS 密码，也无法连接 OBS。其他设置仍可正常查看和修改。</SettingsFeedback> : null}
    <div className="device-console-layout">

      <div className="device-detail">
        <div data-settings-section="archives" hidden={selected !== 'archives'} className="device-panel" role="region" aria-label="工程存档设置">{selected === 'archives' ? <ArchiveSettings disabled={disabled} /> : null}</div>
        <div data-settings-section="songs" hidden={selected !== 'songs'} className="device-panel"><SongImportSettings disabled={disabled} notify={props.notify}>{props.songTools}</SongImportSettings></div>
        <div data-settings-section="obs" hidden={selected !== 'obs'} className="device-panel" aria-label="OBS 设备面板">{props.children}</div>
        <div data-settings-section="ma2" hidden={selected !== 'ma2'} className="device-panel" aria-label="MA2 设备面板">
          <Ma2ConnectionSettings disabled={disabled} notify={props.notify} maintenanceHost={maintenanceHost} onMaintenance={openMa2Maintenance} onAudioSettings={() => props.onNavigate('audio')} />
          <SettingsDisclosure title="控台 MIDI 地址与配置说明"><LightingMidiSettings maintenance disabled={disabled} notify={props.notify} onBusy={props.onBusy} /></SettingsDisclosure>
          {method !== 'midi' ? <details className="device-advanced"><summary>高级连接与插件维护</summary><div ref={setMaintenanceHost} /></details> : null}
        </div>
        <div data-settings-section="audio" hidden={selected !== 'audio'} className="device-panel" aria-label="音频与 MIDI 设备面板">
          <div className="device-panel-intro"><p>{props.internal ? '选择音乐从哪个设备播放，以及时间码从哪个 MIDI 端口发出。' : '当前跟随 P1 播放，请设置时间码输入端口和灯光动作端口。'}</p><Button className="secondary-button" loading={refreshingMidi} disabled={disabled || refreshingMidi} onClick={() => void refreshMidi()}><RefreshCw />刷新端口</Button></div>
          {props.internal ? <ProjectMusicConnections disabled={disabled} notify={props.notify} onBusy={props.onBusy}><LightingMidiSettings disabled={disabled} notify={props.notify} onBusy={props.onBusy} /></ProjectMusicConnections> : <LightingMidiSettings follow disabled={disabled} notify={props.notify} onBusy={props.onBusy} />}
        </div>
        <div data-settings-section="virtual" hidden={selected !== 'virtual'} className="device-panel" aria-label="虚拟 MIDI 设备面板"><LoopMidiSettings disabled={disabled} notify={props.notify} onBusy={props.onBusy} onRefreshMidi={props.onRefreshMidi} /></div>
        <div data-settings-section="maintenance" hidden={selected !== 'maintenance'} className="device-panel" role="region" aria-label="程序维护设备面板"><p className="device-panel-description">预览没有画面，或联动台启动不了 OBS / P1 时，在这里处理。查看错误、导出诊断包或提交问题反馈，请到「帮助与反馈」。</p>{props.maintenance}<div className="device-panel-actions"><Button className="primary-button" disabled={disabled || !props.securityAvailable} onClick={props.onSave}>保存启动设置</Button><Button className="secondary-button" disabled={disabled} onClick={props.onRefresh}><RefreshCw />重新检测程序与设备</Button></div><IntegrationFooter midiPorts={props.midiPorts} inventory={props.inventory} /></div>
      </div>
    </div>
  </section>;
}
