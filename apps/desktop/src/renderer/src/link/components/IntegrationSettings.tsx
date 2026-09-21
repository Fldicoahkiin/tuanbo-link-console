import { useEffect, type ReactNode } from 'react';
import { AudioWaveform, MonitorUp, type LucideIcon } from 'lucide-react';
import { type LinkObsInventory } from '@tb/core/link';
import type { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { UpdateCenter } from './UpdateCenter';
import { LicenseSettings } from './LicenseSettings';
import { AppearanceControl } from './AppearanceControl';
import { ShortcutSettings } from './ShortcutSettings';
import { PlaybackPreferences } from './PlaybackPreferences';
import { ProjectSettings } from './ProjectSettings';
import { PowerModeSettings } from './PowerModeSettings';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, isDeviceSettingsCategory, type SettingsCategory } from './settings-navigation';
import { useDocumentStore } from '../stores/document-store';
import { DeviceConnectionsPage } from './DeviceConnectionsPage';

type Notify = (message: string, tone?: 'info' | 'error') => void;

export function IntegrationDeviceOverview({ obsState, p1State, mtcReady }: {
  obsState: string;
  p1State: string;
  mtcReady: boolean;
}): JSX.Element {
  return <section className="integration-device-overview" aria-label="设备状态">
    <OverviewDevice icon={MonitorUp} kind="obs" name="OBS Studio" state={obsState} note={obsState === 'connected' ? 'WebSocket 已连接' : '等待连接'} />
    <OverviewDevice icon={AudioWaveform} kind="p1" name="P1" state={p1State} note={mtcReady ? 'MTC 已接收' : 'MTC 未接通'} />
  </section>;
}

function OverviewDevice({ icon: Icon, kind, name, state, note }: {
  icon: LucideIcon;
  kind: 'obs' | 'p1';
  name: string;
  state: string;
  note: string;
}): JSX.Element {
  const ok = state === 'running' || state === 'connected';
  const bad = state === 'error' || state === 'disconnected';
  return <article className="integration-overview-device"><div className={`program-icon ${kind}`}><Icon /></div><div><strong>{name}</strong><span>{note}</span></div><span className={`status-pill ${ok ? 'ok' : bad ? 'error' : 'pending'}`}>{statusLabel(state)}</span></article>;
}

export function IntegrationSettingsDialog({ category, busy, runtimeActive, securityAvailable, nestedDialogOpen, midiPorts, inventory, notify, onRefresh, onRefreshMidi, onSave, onClose, onBusy, maintenance, children }: {
  category: SettingsCategory;
  busy: boolean;
  runtimeActive: boolean;
  securityAvailable: boolean;
  nestedDialogOpen: boolean;
  midiPorts: ReturnType<LinkMidiAdapter['listPorts']>;
  inventory: LinkObsInventory | null;
  notify: Notify;

  onRefresh: () => void;
  onRefreshMidi: () => Promise<void>;
  onSave: () => void;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  children: ReactNode;
  maintenance: ReactNode;
}): JSX.Element {
  useSettingsEscape(nestedDialogOpen, onClose);
  const internal = useDocumentStore((state) => state.project?.playbackSource === 'internal');
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === category)!;
  const deviceCategory = isDeviceSettingsCategory(category);
  const group = SETTINGS_GROUPS.find((entry) => entry.id === current.group)!;
  return <>
    <div hidden={!deviceCategory}><DeviceConnectionsPage selected={deviceCategory ? category : 'obs'} busy={busy} runtimeActive={runtimeActive} securityAvailable={securityAvailable} internal={internal} midiPorts={midiPorts} inventory={inventory} notify={notify} onRefresh={onRefresh} onRefreshMidi={onRefreshMidi} onSave={onSave} onBusy={onBusy} maintenance={maintenance}>{children}</DeviceConnectionsPage></div>
    {!deviceCategory ? <section className="device-console settings-content-page" aria-label={`${current.name}设置`}>
    <header className="device-console-header"><div><span className="device-eyebrow">设置</span><h2>{group.name}</h2><p>配置保存在本机；工程设置随当前工程保存。</p></div></header>
    <div className="device-detail"><header className="device-detail-header"><div><h3>{current.name}</h3><p>{current.detail}</p></div></header><div className="device-panel">
      {category === 'performance' ? <PowerModeSettings notify={notify} /> : null}
      {category === 'source' ? <ProjectSettings section="playback" disabled={runtimeActive || busy} notify={notify} /> : null}
      {category === 'preferences' ? internal ? <PlaybackPreferences disabled={runtimeActive || busy} notify={notify} /> : <p className="settings-note">当前跟随 P1 播放，播放操作在 P1 中完成。切换到本软件播放后可配置播放习惯。</p> : null}
      {category === 'theme' ? <AppearanceControl /> : null}
      {category === 'shortcuts' ? <ShortcutSettings /> : null}
      {category === 'updates' ? <UpdateCenter notify={notify} /> : null}
      {category === 'license' ? <LicenseSettings runtimeActive={runtimeActive} /> : null}
      {category === 'seeking' || category === 'timecode' || category === 'workflow' ? <ProjectSettings section={category} disabled={runtimeActive || busy} notify={notify} /> : null}
    </div></div>
  </section> : null}</>;
}

function useSettingsEscape(nestedDialogOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      const nestedOverlay = document.querySelector('.update-overlay[open], .device-maintenance-backdrop, .diagnostics-log-backdrop');
      if (event.key === 'Escape' && !event.defaultPrevented && !nestedDialogOpen && !nestedOverlay) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [nestedDialogOpen, onClose]);
}

function statusLabel(state: string): string {
  if (state === 'running') return '运行中';
  if (state === 'connected') return '已连接';
  if (state === 'starting') return '启动中';
  if (state === 'connecting' || state === 'reconnecting') return '连接中';
  if (state === 'stopping') return '停止中';
  if (state === 'disconnected') return '未连接';
  if (state === 'notRunning') return '未运行';
  if (state === 'error') return '异常';
  return state;
}
