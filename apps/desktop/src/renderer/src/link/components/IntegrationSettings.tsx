import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { AudioWaveform, MonitorUp, type LucideIcon } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { diagnosticContext } from '../view-models/diagnostic-context';
import { Button, Notice } from '../ui';
import { AppearanceControl } from './AppearanceControl';
import { ArchiveSettings } from './ArchiveSettings';
import { AudioMidiSettings, Ma2Settings, MaintenanceSettings } from './DeviceSettings';
import { FeedbackForm } from './FeedbackSettings';
import { LicenseSettings } from './LicenseSettings';
import { LogsWorkspace } from './LogsWorkspace';
import { LoopMidiSettings } from './LoopMidiSettings';
import { PlaybackPreferences } from './PlaybackPreferences';
import { PlaybackSourceSettings, SceneWorkflowGuide, SeekingSettings } from './ProjectSettings';
import { PowerModeSettings } from './PowerModeSettings';
import { SettingsPage } from './SettingsPage';
import { SETTINGS_SECTIONS, type SettingsCategory } from './settings-navigation';
import { ShortcutSettings } from './ShortcutSettings';
import { SongImportSettings } from './SongImportSettings';
import { TimecodeSettings } from './TimecodeSettings';
import { UpdateCenter } from './UpdateCenter';

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

/** Pages kept mounted while settings are open: their forms hold unsaved input (OBS, 程序维护) or a host the MA2 page fills. */
const keptMounted: ReadonlySet<SettingsCategory> = new Set<SettingsCategory>(['audio', 'obs', 'ma2', 'virtual', 'maintenance', 'songs']);
/** Pages whose settings cannot change while the show runs. */
const lockedWhilePlaying: ReadonlySet<SettingsCategory> = new Set<SettingsCategory>(['audio', 'obs', 'ma2', 'virtual', 'maintenance', 'songs', 'source', 'timecode', 'archives', 'preferences']);

/**
 * The settings window (2026-10-30 rework): one SettingsPage per entry of the navigation, all with the
 * same frame: title, what it is for, and whether it is saved on this computer or in the project.
 */
export function IntegrationSettingsDialog({ category, busy, runtimeActive, securityAvailable, nestedDialogOpen, notify, onRefresh, onRefreshMidi, onSave, onClose, onBusy, onNavigate, onCreate, onOpen, maintenance, songTools, children }: {
  category: SettingsCategory;
  onNavigate: (category: SettingsCategory) => void;
  onCreate: () => void;
  onOpen: () => void;
  busy: boolean;
  runtimeActive: boolean;
  securityAvailable: boolean;
  nestedDialogOpen: boolean;
  notify: Notify;
  onRefresh: () => void;
  onRefreshMidi: () => Promise<void>;
  onSave: () => void;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  /** The OBS page's form. */
  children: ReactNode;
  /** The start-up settings of OBS and P1, on 程序维护. */
  maintenance: ReactNode;
  /** The P1 follow tools, on 歌曲导入. */
  songTools: ReactNode;
}): JSX.Element {
  useSettingsEscape(nestedDialogOpen, onClose);
  const internal = useDocumentStore((state) => !state.project || state.project.playbackSource === 'internal');
  const hasMa2 = useDocumentStore((state) => Boolean(state.project?.ma2ReadState));
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
  const disabled = runtimeActive || busy;
  const common = { disabled, notify, onBusy };
  const content = (id: SettingsCategory): ReactNode => {
    switch (id) {
      case 'audio': return <AudioMidiSettings {...common} internal={internal} onRefreshMidi={onRefreshMidi} onNavigate={onNavigate} />;
      case 'obs': return children;
      case 'ma2': return <Ma2Settings {...common} onNavigate={onNavigate} />;
      case 'virtual': return <LoopMidiSettings {...common} onRefreshMidi={onRefreshMidi} />;
      case 'maintenance': return <MaintenanceSettings disabled={disabled} securityAvailable={securityAvailable} onSave={onSave} onRefresh={onRefresh}>{maintenance}</MaintenanceSettings>;
      case 'songs': return <SongImportSettings disabled={disabled} notify={notify}>{songTools}</SongImportSettings>;
      case 'source': return <PlaybackSourceSettings disabled={disabled} notify={notify} onCreate={onCreate} onOpen={onOpen} onNavigate={onNavigate} />;
      case 'timecode': return <TimecodeSettings {...common} internal={internal} onCreate={onCreate} onOpen={onOpen} />;
      case 'archives': return category === 'archives' ? <ArchiveSettings disabled={disabled} /> : null;
      case 'preferences': return internal ? <PlaybackPreferences disabled={disabled} notify={notify} />
        : <Notice actions={<Button variant="secondary" onClick={() => onNavigate('source')}>打开播放主控</Button>}>现在跟随 P1 播放，播放操作在 P1 里设置。</Notice>;
      case 'shortcuts': return <ShortcutSettings />;
      case 'performance': return <PowerModeSettings notify={notify} />;
      case 'seeking': return <SeekingSettings notify={notify} />;
      case 'workflow': return <SceneWorkflowGuide />;
      case 'theme': return <AppearanceControl />;
      case 'updates': return <UpdateCenter notify={notify} runtimeActive={runtimeActive} />;
      case 'license': return <LicenseSettings runtimeActive={runtimeActive} />;
      case 'feedback': return <FeedbackForm context={diagnosticContext} ma2Available={hasMa2} onOpenLogs={() => onNavigate('logs')} />;
      case 'logs': return <LogsWorkspace notify={notify} />;
    }
  };
  const notices = (id: SettingsCategory): ReactNode => {
    const locked = runtimeActive && lockedWhilePlaying.has(id);
    const insecure = !securityAvailable && (id === 'obs' || id === 'maintenance');
    if (!locked && !insecure) return null;
    return <>
      {locked ? <Notice tone="warning">正在播放，这一页的设置先锁住了。停止播放后再改。</Notice> : null}
      {insecure ? <Notice tone="warning" title="暂时连不上 OBS">Windows 安全存储用不了，OBS 密码存不进去。其他设置照常可以查看和修改。</Notice> : null}
    </>;
  };
  return <div ref={root} className="settings-session">
    {SETTINGS_SECTIONS.filter(entry => keptMounted.has(entry.id) || visited.current.has(entry.id)).map(section => <SettingsPage key={section.id} id={section.id} title={section.name} description={section.detail}
      scope={section.scope} hidden={category !== section.id} notices={notices(section.id)}>{content(section.id)}</SettingsPage>)}
  </div>;
}

function useSettingsEscape(nestedDialogOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      const nestedOverlay = document.querySelector('dialog[open], .device-maintenance-backdrop, .diagnostics-log-backdrop');
      if (event.target instanceof HTMLSelectElement) return;
      // Escape here only closes the page; the window's playback keys wait while it is open (0.5.9).
      if (event.key === 'Escape' && !event.defaultPrevented && !nestedDialogOpen && !nestedOverlay) { event.preventDefault(); onClose(); }
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
