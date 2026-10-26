import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
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
import { settingsScope, SETTINGS_SECTIONS, isDeviceSettingsCategory, type SettingsCategory } from './settings-navigation';
import { useDocumentStore } from '../stores/document-store';
import { SettingsPageHeader, SettingsFeedback } from './SettingsControls';
import { Button } from './Button';
import { DeviceConnectionsPage } from './DeviceConnectionsPage';
import { FeedbackForm } from './FeedbackSettings';
import { LogsWorkspace } from './LogsWorkspace';
import { diagnosticContext } from '../view-models/diagnostic-context';

type Notify = (message: string, tone?: 'info' | 'error') => void;

export function IntegrationDeviceOverview({ obsState, p1State, mtcReady }: {
  obsState: string;
  p1State: string;
  mtcReady: boolean;
}): JSX.Element {
  return <section className="integration-device-overview" aria-label="设备状态">
    <OverviewDevice icon={MonitorUp} kind="obs" name="OBS Studio" state={obsState} note={obsState === 'connected' ? 'WebSocket 已连接' : '等待连接'} />
    <OverviewDevice icon={AudioWaveform} kind="p1" name="P1" state={p1State} note={mtcReady ? 'MTC 已接收' : '未收到 MTC'} />
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

export function IntegrationSettingsDialog({ category, busy, runtimeActive, securityAvailable, nestedDialogOpen, midiPorts, inventory, notify, onRefresh, onRefreshMidi, onSave, onClose, onBusy, onNavigate, onCreate, onOpen, maintenance, songTools, children }: {
  category: SettingsCategory;
  onNavigate: (category: SettingsCategory) => void;
  onCreate: () => void;
  onOpen: () => void;
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
  songTools: ReactNode;
}): JSX.Element {
  useSettingsEscape(nestedDialogOpen, onClose);
  const internal = useDocumentStore((state) => !state.project || state.project.playbackSource === 'internal');
  const hasMa2 = useDocumentStore((state) => Boolean(state.project?.ma2ReadState));
  const deviceCategory = isDeviceSettingsCategory(category);
  const visited = useRef(new Set<SettingsCategory>());
  visited.current.add(category);
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<SettingsCategory, number>());
  useLayoutEffect(() => {
    const scroll = root.current?.closest('.content-scroll');
    if (!scroll) return;
    const savedPositions = positions.current;
    scroll.scrollTop = savedPositions.get(category) ?? 0;
    return () => { savedPositions.set(category, scroll.scrollTop); };
  }, [category]);
  return <div ref={root} className="settings-session">
    <div hidden={!deviceCategory}><DeviceConnectionsPage selected={deviceCategory ? category : 'obs'} busy={busy} runtimeActive={runtimeActive} securityAvailable={securityAvailable} internal={internal} midiPorts={midiPorts} inventory={inventory} notify={notify} onRefresh={onRefresh} onRefreshMidi={onRefreshMidi} onSave={onSave} onBusy={onBusy} maintenance={maintenance} songTools={songTools} onNavigate={onNavigate}>{children}</DeviceConnectionsPage></div>
    {SETTINGS_SECTIONS.filter(entry => !isDeviceSettingsCategory(entry.id) && visited.current.has(entry.id)).map(current => <section key={current.id} hidden={category !== current.id} data-settings-section={current.id} className="device-console settings-content-page" aria-label={`${current.name}设置`}>
      <SettingsPageHeader title={current.name} description={current.detail} scope={settingsScope(current.id)} />
      <div className="device-panel">
        {current.id === 'performance' ? <PowerModeSettings notify={notify} /> : null}
        {current.id === 'source' ? <ProjectSettings section="playback" disabled={runtimeActive || busy} notify={notify} onNavigate={onNavigate} onCreate={onCreate} onOpen={onOpen} /> : null}
        {current.id === 'preferences' ? internal ? <PlaybackPreferences disabled={runtimeActive || busy} notify={notify} /> : <SettingsFeedback>当前跟随 P1 播放，请在 P1 中操作。<Button className="secondary-button" onClick={() => onNavigate('source')}>打开播放主控设置</Button></SettingsFeedback> : null}
        {current.id === 'theme' ? <AppearanceControl /> : null}
        {current.id === 'shortcuts' ? <ShortcutSettings /> : null}
        {current.id === 'updates' ? <UpdateCenter notify={notify} inline runtimeActive={runtimeActive} /> : null}
        {current.id === 'license' ? <LicenseSettings runtimeActive={runtimeActive} /> : null}
        {current.id === 'seeking' || current.id === 'timecode' || current.id === 'workflow' ? <ProjectSettings section={current.id} disabled={runtimeActive || busy} notify={notify} onNavigate={onNavigate} onCreate={onCreate} onOpen={onOpen} /> : null}
        {current.id === 'feedback' ? <FeedbackForm context={diagnosticContext} ma2Available={hasMa2} onOpenLogs={() => onNavigate('logs')} /> : null}
        {current.id === 'logs' ? <LogsWorkspace notify={notify} settings /> : null}
      </div>
    </section>)}
  </div>;

}

function useSettingsEscape(nestedDialogOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      const nestedOverlay = document.querySelector('dialog[open], .device-maintenance-backdrop, .diagnostics-log-backdrop');
      if (event.target instanceof HTMLSelectElement) return;
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
