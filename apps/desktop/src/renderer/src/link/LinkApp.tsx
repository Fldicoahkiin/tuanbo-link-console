import { useSettingsExit } from './useSettingsExit';
import { SettingsConfirm } from './components/SettingsControls';
import { toUserErrorMessage } from '@tb/core/link';
import { useMa2ReadStore } from './stores/ma2-read-store';
import { useDocumentShortcuts } from './useDocumentShortcuts';
import { useMidiPortMonitor } from './useMidiPortMonitor';
import { initializeStartupDevices } from './startup-obs-connection';
import { subscribeObsSceneSync } from './obs-scene-sync';
import { ToolbarConnections } from './components/ToolbarConnections';
import { RendererErrorBoundary } from './components/RendererErrorBoundary';
import { ProjectDialog } from './components/ProjectDialog';
import { startTransition, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Lightbulb,
  ListMusic,
  Maximize2,
  Minus,
  Settings,
  SlidersHorizontal,
  X
} from 'lucide-react';
import type { SettingsCategory, SettingsLocation } from './components/settings-navigation';
import { useSettingsLocation } from './useSettingsLocation';
import { SettingsNavigation, SettingsSectionNavigation } from './components/SettingsNavigation';
import { CueWorkspace } from './components/CueWorkspace';
import { IntegrationWorkspace } from './components/IntegrationWorkspace';
import { useAppearanceTheme } from './components/AppearanceControl';
import { useDisplayPreferences } from './stores/display-preferences-store';
import { ProjectWorkspace } from './components/ProjectWorkspace';
import { LinkRuntimeCoordinator } from './runtime/link-runtime-coordinator';
import { selectCanRedo, selectCanUndo, useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { useRuntimeStore } from './stores/runtime-store';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { useProjectPersistence } from './useProjectPersistence';
import { useP1AutoFollow } from './useP1AutoFollow';
import { useInternalPlayer } from './useInternalPlayer';
import { useMa2AutoSync, useMa2AutoSyncStore } from './runtime/use-ma2-auto-sync';
import { useMediaAudioPreparation } from './runtime/use-media-audio-preparation';
import { useLicenseReminders } from './useLicenseReminders';
import { recordErrorNotice } from './error-notice-log';

type Page = 'project' | 'cues' | 'lighting';
type Notice = { id: string; message: string; tone: 'info' | 'error'; key?: string };
type NavigationItem = { id: Page; label: string; caption: string; icon: typeof ListMusic };

const NAVIGATION: NavigationItem[] = [
  { id: 'project', label: '节目单', caption: '安排节目与素材', icon: ListMusic },
  { id: 'cues', label: '编辑器', caption: '编排画面与动作', icon: SlidersHorizontal },
  { id: 'lighting', label: '灯光工作台', caption: '音频分段与灯光编排', icon: Lightbulb }
];

export function LinkApp(): JSX.Element {
  useAppearanceTheme();
  const [lightingActionsHost, setLightingActionsHost] = useState<HTMLDivElement | null>(null); const [connectHost, setConnectHost] = useState<HTMLDivElement | null>(null); const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [connectionStatusHost, setConnectionStatusHost] = useState<HTMLDivElement | null>(null);
  const [editorSidebarHost, setEditorSidebarHost] = useState<HTMLDivElement | null>(null);
  const [playlistHost, setPlaylistHost] = useState<HTMLDivElement | null>(null);
  const [page, setPage] = useState<Page>('project');
  const [coordinator, setCoordinator] = useState<LinkRuntimeCoordinator | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [licenseNotices, dismissLicenseNotice] = useLicenseReminders();
  const { newProjectOpen, setNewProjectOpen, newProjectName, setNewProjectName } = useNewProjectDialog();
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('obs');
  const [settingsOpen, setSettingsOpen] = useState(false); const [settingsLocation, setSettingsLocation] = useState<SettingsLocation | null>(null);
  const settingsLocator = useSettingsLocation(settingsLocation, settingsOpen, settingsCategory);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const openLighting = useMa2ReadStore(state => state.openWorkspace);
  const coordinatorDocumentIdRef = useRef<number | null>(null);
  const project = useDocumentStore((state) => state.project);
  const projectPath = useDocumentStore((state) => state.path);
  const documentId = useDocumentStore((state) => state.documentId);
  const dirty = useDocumentStore((state) => state.dirty);
  const documentError = useDocumentStore((state) => state.error);
  const canUndo = useDocumentStore(selectCanUndo);
  const canRedo = useDocumentStore(selectCanRedo);
  const lightingUndo = useDocumentStore(state => state.past.at(-1)?.command.scope === 'lighting');
  const lightingRedo = useDocumentStore(state => state.future.at(-1)?.command.scope === 'lighting');
  const obs = useIntegrationStore((state) => state.obs);
  const processes = useIntegrationStore((state) => state.processes);
  const integrationInitialized = useIntegrationStore((state) => state.initialized);
  const runtimeState = useRuntimeStore((state) => state.state);
  const [playbackProject, setPlaybackProject] = useState(project);
  const internalPlayer = useInternalPlayer(coordinator, integrationInitialized, playbackProject);
  const editingLocked = internalPlayer.state.status === 'preparing' || ['preflight', 'armed', 'running', 'timecodeLost', 'paused', 'error', 'stopping'].includes(runtimeState);
  const previewPlaying = useMa2AutoSyncStore(state => state.previewPlaying);
  const playbackLocked = editingLocked || previewPlaying || ['playing', 'paused'].includes(internalPlayer.state.status);
  useEffect(() => { if (!playbackLocked) setPlaybackProject(project); }, [playbackLocked, project]);
  useConnectionsEscape(connectionsOpen && !settingsOpen, () => setConnectionsOpen(false));

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info', key?: string) => {
    const id = crypto.randomUUID();
    const displayMessage = tone === 'error' ? toUserErrorMessage(message) : message;
    if (tone === 'error' && message) recordErrorNotice(displayMessage, message);
    setNotices((current) => [...current.filter(notice => notice.message !== displayMessage && (!key || notice.key !== key)), ...(message ? [{ id, message: displayMessage, tone, ...(key ? { key } : {}) }] : [])]);
    if (tone === 'info') window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 5_000);
  }, []);

  const midiMonitor = useDesktopIntegrationEvents(notify); useEffect(() => { try { useDisplayPreferences.getState().load(); } catch (error) { notify(`显示设置读取失败：${String(error)}`, 'error'); } }, [notify]);
  useMa2AutoSync(editingLocked || internalPlayer.state.status === 'playing', notify);
  useProjectPersistence(notify); useMediaAudioPreparation(playbackLocked, notify);

  useDocumentDirty(dirty, notify);

  useRuntimeCloseProtection(internalPlayer.state.status === 'preparing' ? 'preflight' : runtimeState, notify);

  useDocumentErrorNotification(documentError, notify);

  useEffect(() => {
    if (editingLocked && project?.playbackSource !== 'internal' && page === 'cues') setPage('project');
  }, [editingLocked, page, project?.playbackSource]);

  useEffect(() => {
    if (!playbackProject) {
      coordinatorDocumentIdRef.current = null;
      setCoordinator(null);
      useRuntimeStore.getState().reset();
      return;
    }
    const currentItemId = coordinatorDocumentIdRef.current === documentId
      ? useRuntimeStore.getState().currentItemId
      : null;
    coordinatorDocumentIdRef.current = documentId;
    const next = new LinkRuntimeCoordinator(playbackProject, projectPath);
    if (currentItemId && playbackProject.rundown.some((item) => item.id === currentItemId && item.enabled)) next.selectItem(currentItemId, false);
    else useRuntimeStore.getState().setState({ currentItemId: null, currentCueId: null, nextCueId: null });
    setCoordinator(next);
    return () => next.dispose();
  }, [documentId, playbackProject, projectPath]);

  useP1AutoFollow(coordinator, integrationInitialized, project?.playbackSource !== 'internal' && project?.p1AutoFollow?.enabled === true, notify);

  const createProject = async (): Promise<void> => {
    setNewProjectError(null);
    try {
      if (!await saveBeforeNewProject()) return;
      const next = await linkDesktopViewModel.createProject(newProjectName);
      useDocumentStore.getState().setProject(next, null);
      setNewProjectOpen(false); setPage('project');
    } catch (error) {
      setNewProjectError(`无法创建工程：${error instanceof Error ? error.message : String(error)}。请检查保存位置后重试。`);
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const beginCreateProject = (): void => {
    if (dirty && !window.confirm('新建独立工程会切换到空节目单，当前工程将先保存。是否继续？')) return;
    setNewProjectError(null);
    setNewProjectOpen(true);
  };

  const openProject = async (): Promise<void> => {
    if (dirty && !window.confirm('当前工程有未保存修改，确认打开其他工程？')) return;
    try {
      const result = await linkDesktopViewModel.pickOpenProject();
      if (!result) return;
      useDocumentStore.getState().setProject(result.project, result.path);
      notify(`已打开：${result.project.name}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const saveProject = async (): Promise<void> => {
    const current = useDocumentStore.getState();
    if (!current.project) return;
    const savingRevision = current.revision; const savingDocumentId = current.documentId;
    try {
      const path = await linkDesktopViewModel.saveProject(current.path, current.project);
      if (!path || useDocumentStore.getState().documentId !== savingDocumentId) return;
      useDocumentStore.getState().markSaved(path, savingRevision, savingDocumentId);
      notify(`工程已原子保存：${path}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };


  const controlWindow = (action: 'minimize' | 'toggleMaximize' | 'close'): void => {
    void linkDesktopViewModel.controlWindow(action).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error), 'error');
    });
  };

  const openSettings = useCallback((): void => {
    setConnectionsOpen(true);

    setSettingsOpen(true);
  }, []);

  const { settingsExit, setSettingsExit, leaveSettings } = useSettingsExit(() => {
    setSettingsLocation(null); setSettingsOpen(false); setConnectionsOpen(false);
  });
  const closeSettings = useCallback((): void => leaveSettings(), [leaveSettings]);

  useEffect(() => {
    if (!openLighting) return;
    useMa2ReadStore.setState({ openWorkspace: false });
    leaveSettings(() => setPage('lighting'));
  }, [openLighting, leaveSettings]);
  useDocumentShortcuts(playbackLocked, saveProject);
  const documentActions = {
    canUndo: canUndo && (!playbackLocked || lightingUndo), canRedo: canRedo && (!playbackLocked || lightingRedo),
    historyDisabled: false,
    disabled: editingLocked || !project,
    onUndo: () => useDocumentStore.getState().undo(),
    onRedo: () => useDocumentStore.getState().redo(), onSave: () => void saveProject()
  };
  const pageContent = <><div className="workspace-page" hidden={page !== 'project' || connectionsOpen}><ProjectWorkspace toolbarHost={page === 'project' && !connectionsOpen ? toolbarHost : null} playlistHost={playlistHost} onCreate={beginCreateProject} onOpen={() => void openProject()} onImportSongs={() => { setSettingsCategory('songs'); setSettingsLocation({ category: 'songs' }); openSettings(); }} player={internalPlayer} editingLocked={editingLocked} coordinator={coordinator} notify={notify} onOpenCueEditor={() => setPage('cues')} documentActions={documentActions} /></div>{(page === 'cues' || page === 'lighting') && !connectionsOpen ? <CueWorkspace actionsHost={lightingActionsHost} key={page} workspace={page === 'lighting' ? 'lighting' : 'visual'} player={internalPlayer} sidebarHost={editorSidebarHost} toolbarHost={toolbarHost} coordinator={coordinator} notify={notify} documentActions={documentActions} /> : null}</>;

  return <RendererErrorBoundary>
    <div className="app-shell" data-workspace={connectionsOpen ? 'settings' : page}>
      <a className="skip-link" href="#workspace-content">跳到工作区</a>
      <AppTopbar actionsHostRef={setLightingActionsHost} details={<ToolbarConnections player={internalPlayer} statusHost={connectionStatusHost} onSettings={(category, focus) => { setSettingsCategory(category); setSettingsLocation({ category, ...(focus ? { focus } : {}) }); openSettings(); }} />} statusHostRef={setConnectionStatusHost} connectHostRef={setConnectHost} toolbarHostRef={setToolbarHost} onWindowAction={controlWindow} />
      <AppSidebar editorHostRef={setEditorSidebarHost} playlistHostRef={setPlaylistHost} settingsCategory={settingsCategory} onSettingsCategoryChange={category => { setSettingsLocation(null); setSettingsCategory(category); }}
        page={page} internal={project?.playbackSource === 'internal'} editingLocked={editingLocked}
        obsState={obs.status} p1State={processes.p1.status} runtimeState={runtimeState} settingsOpen={connectionsOpen} onPageChange={(next) => { leaveSettings(() => startTransition(() => setPage(next))); }} onSettings={openSettings}
      />
      <section className={`app-workspace${connectionsOpen ? ' settings-workspace' : ''}`}>
        {connectionsOpen ? <SettingsSectionNavigation selected={settingsCategory} onSelect={category => { setSettingsLocation(null); setSettingsCategory(category); }} /> : null}
        <main className="app-main" id="workspace-content" tabIndex={-1} aria-label={connectionsOpen ? '设置' : NAVIGATION.find(item => item.id === page)?.label}>
          <div className="content-scroll">{pageContent}<section hidden={!connectionsOpen} className="connections-dialog" role="dialog" aria-modal="false" aria-label={settingsOpen ? '设置' : '连接与设备'}><div className="connections-content" ref={settingsLocator.ref}><IntegrationWorkspace quickConnectHost={connectHost} midiMonitor={midiMonitor} category={settingsCategory} onCategoryChange={category => { setSettingsLocation(null); setSettingsCategory(category); }} coordinator={coordinator} notify={notify} settingsOpen={connectionsOpen && settingsOpen} onSettingsClose={closeSettings} onSettingsOpen={openSettings} onCreate={() => leaveSettings(beginCreateProject)} onOpen={() => leaveSettings(() => void openProject())} /></div></section>
      <div className="toast-stack" role="region" aria-label="通知"><div role="status" aria-live="polite">{licenseNotices.map((message, index) => <div className="toast info" key={`license-${index}`}><span>{message}</span><button aria-label="关闭授权提醒" onClick={() => dismissLicenseNotice(index)}><X aria-hidden="true" /></button></div>)}{notices.filter(notice => notice.tone === 'info').map((notice) => <div className="toast info" key={notice.id}><span>{notice.message}</span><button aria-label="关闭通知" onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}><X aria-hidden="true" /></button></div>)}</div><div role="alert">{notices.filter(notice => notice.tone === 'error').map((notice) => <div className="toast error" key={notice.id}><span>{notice.message}</span><button aria-label="关闭错误通知" onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}><X aria-hidden="true" /></button></div>)}</div></div></div>
        </main>
      </section>

      {settingsExit ? <SettingsConfirm cancelLabel="继续编辑" title="离开设置？" confirmLabel="放弃未保存修改" onClose={() => setSettingsExit(null)} onConfirm={settingsExit}>连接或启动参数尚未保存。已保存的本机偏好和工程修改会保留。</SettingsConfirm> : null}
      {newProjectOpen ? <ProjectDialog name={newProjectName} error={newProjectError} onNameChange={setNewProjectName} onClose={() => setNewProjectOpen(false)} onCreate={() => void createProject()} /> : null}
    </div>
  </RendererErrorBoundary>;
}

function useConnectionsEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, onClose]);
}

function useDocumentDirty(dirty: boolean, notify: (message: string, tone?: 'info' | 'error') => void): void {
  useEffect(() => {
    void linkDesktopViewModel.setDocumentDirty(dirty).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error'));
  }, [dirty, notify]);
}

function AppSidebar({ editorHostRef, settingsCategory, onSettingsCategoryChange, playlistHostRef, page, internal, editingLocked, settingsOpen, onPageChange, onSettings }: {
  editorHostRef: (element: HTMLDivElement | null) => void;
  settingsCategory: SettingsCategory;
  onSettingsCategoryChange: (category: SettingsCategory) => void;
  playlistHostRef: (element: HTMLDivElement | null) => void;
  page: Page;
  internal: boolean;
  editingLocked: boolean;
  obsState: string;
  p1State: string;
  runtimeState: string;
  settingsOpen: boolean;
  onPageChange: (page: Page) => void;
  onSettings: () => void;
}): JSX.Element {
  return <aside className="app-sidebar">
    <nav className="main-nav workspace-navigation" aria-label="主要工作区">{NAVIGATION.map((item) => {
      const Icon = item.icon;
      const disabled = editingLocked && !internal && item.id === 'cues';
      const active = !settingsOpen && page === item.id;
      return <button key={item.id} title={`${item.label} · ${disabled ? '已锁定' : item.caption}`} disabled={disabled} aria-current={active ? 'page' : undefined} className={active ? 'active' : ''} onClick={() => onPageChange(item.id)}><Icon aria-hidden="true" /><span><strong>{item.label}</strong></span></button>;
    })}<button className={settingsOpen ? 'active' : ''} aria-current={settingsOpen ? 'page' : undefined} onClick={onSettings}><Settings aria-hidden="true" /><span><strong>设置</strong></span></button></nav>
    <div className="sidebar-context">
      <div className="sidebar-playlists" hidden={settingsOpen || page !== 'project'} ref={playlistHostRef} />
      <div className="sidebar-editor" hidden={settingsOpen || page === 'project'} ref={editorHostRef} />
      {settingsOpen ? <SettingsNavigation selected={settingsCategory} onSelect={onSettingsCategoryChange} /> : null}
    </div>
  </aside>;
}

function AppTopbar({ actionsHostRef, details, statusHostRef, connectHostRef, toolbarHostRef, onWindowAction }: {
  actionsHostRef: (element: HTMLDivElement | null) => void;
  details: ReactNode;
  statusHostRef: (element: HTMLDivElement | null) => void;
  connectHostRef: (element: HTMLDivElement | null) => void;
  toolbarHostRef: (element: HTMLDivElement | null) => void;
  onWindowAction: (action: 'minimize' | 'toggleMaximize' | 'close') => void;
}): JSX.Element {
  return <div className="app-topbar">
    <div className="persistent-project-toolbar" ref={toolbarHostRef} />
    <div className="topbar-connection-status" ref={statusHostRef} />
    <div className="topbar-drag-region" title="拖动窗口，双击最大化或还原" aria-hidden="true" />
    <div className="lighting-topbar-actions" ref={actionsHostRef} />
    <div className="topbar-details">{details}</div>
    <div className="topbar-connect" ref={connectHostRef} />
    <WorkspaceToolbar onWindowAction={onWindowAction} />
  </div>;
}

function WorkspaceToolbar({ onWindowAction }: {
  onWindowAction: (action: 'minimize' | 'toggleMaximize' | 'close') => void;
}): JSX.Element {
  return <header className="unified-toolbar" aria-label="窗口标题栏"><div className="window-controls" aria-label="窗口控制"><button aria-label="最小化窗口" onClick={() => onWindowAction('minimize')}><Minus /></button><button aria-label="最大化或还原窗口" onClick={() => onWindowAction('toggleMaximize')}><Maximize2 /></button><button className="window-close" aria-label="关闭窗口" onClick={() => onWindowAction('close')}><X /></button></div></header>;
}

function useRuntimeCloseProtection(
  runtimeState: ReturnType<typeof useRuntimeStore.getState>['state'],
  notify: (message: string, tone?: 'info' | 'error') => void
): void {
  useEffect(() => {
    void linkDesktopViewModel.setRuntimeActive(runtimeState !== 'idle')
      .catch((error: unknown) => notify(`同步运行关闭保护失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }, [notify, runtimeState]);
}

function useDesktopIntegrationEvents(notify: (message: string, tone?: 'info' | 'error') => void): ReturnType<typeof useMidiPortMonitor> {
  const midiMonitor = useMidiPortMonitor(notify);
  useEffect(() => {
    let cancelled = false;
    const reportLogFailure = (error: unknown): void => {
      if (!cancelled) notify(`设备状态日志写入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    };
    const unsubscribeInventory = subscribeObsSceneSync(notify);
    const unsubscribeObs = linkDesktopViewModel.onObsStatus((snapshot) => {
      useIntegrationStore.getState().setObs(snapshot);
      const project = useDocumentStore.getState().project;
      void linkDesktopViewModel.recordLog({
        level: snapshot.status === 'error' ? 'error' : snapshot.status === 'disconnected' ? 'warning' : 'info',
        category: 'device',
        message: `OBS WebSocket：${snapshot.status}`,
        ...(project ? { projectId: project.projectId } : {}),
        device: 'obs',
        details: {
          status: snapshot.status,
          obsVersion: snapshot.obsVersion,
          webSocketVersion: snapshot.webSocketVersion,
          error: snapshot.error
        }
      }).catch(reportLogFailure);
    });
    const unsubscribeProcess = linkDesktopViewModel.onProcessStatus((snapshot) => {
      useIntegrationStore.getState().setProcess(snapshot);
      const project = useDocumentStore.getState().project;
      void linkDesktopViewModel.recordLog({
        level: snapshot.status === 'error' ? 'error' : 'info',
        category: 'device',
        message: `${snapshot.id} 进程：${snapshot.status}`,
        ...(project ? { projectId: project.projectId } : {}),
        device: snapshot.id,
        details: {
          status: snapshot.status,
          pid: snapshot.pid,
          processName: snapshot.processName,
          executablePath: snapshot.executablePath,
          startTime: snapshot.startTime,
          fileVersion: snapshot.fileVersion,
          owned: snapshot.owned,
          error: snapshot.error
        }
      }).catch(reportLogFailure);
    });
    void loadDesktopIntegrationState(() => cancelled, notify);
    return () => {
      cancelled = true;
      unsubscribeInventory();
      unsubscribeObs();
      unsubscribeProcess();
    };
  }, [notify]);
  return midiMonitor;
}

async function loadDesktopIntegrationState(
  isCancelled: () => boolean,
  notify: (message: string, tone?: 'info' | 'error') => void
): Promise<void> {
  useIntegrationStore.getState().setInitialized(false); useIntegrationStore.getState().setError(null);
  try {
    const [appInfo, profile, securityAvailable, obsSnapshot] = await Promise.all([
      linkDesktopViewModel.getAppInfo(),
      linkDesktopViewModel.loadIntegrationProfile(),
      linkDesktopViewModel.getSecurityAvailability(),
      linkDesktopViewModel.getObsSnapshot()
    ]);
    if (isCancelled()) return;
    useIntegrationStore.getState().setAppInfo(appInfo);
    useIntegrationStore.getState().setProfile(profile);
    useIntegrationStore.getState().setSecurityAvailable(securityAvailable);
    useIntegrationStore.getState().setObs(obsSnapshot);
    useIntegrationStore.getState().setInitialized(true);
    initializeStartupDevices(profile, securityAvailable, obsSnapshot, isCancelled);
  } catch (error) {
    if (!isCancelled()) {
      const message = `桌面集成初始化失败：${toUserErrorMessage(error)}`;
      useIntegrationStore.getState().setError(message); notify(message, 'error');
      void linkDesktopViewModel.recordLog({ level: 'error', category: 'device', message }).catch(console.error);
    }
  } finally {
    if (!isCancelled()) useIntegrationStore.getState().setInitialized(true);
  }
}

function useDocumentErrorNotification(
  documentError: string | null,
  notify: (message: string, tone?: 'info' | 'error') => void
): void {
  useEffect(() => {
    if (!documentError) return;
    notify(documentError, 'error');
    useDocumentStore.getState().clearError();
  }, [documentError, notify]);
}

async function saveBeforeNewProject(): Promise<boolean> {
  const current = useDocumentStore.getState();
  if (!current.project || !current.dirty) return true;
  const savedPath = await linkDesktopViewModel.saveProject(current.path, current.project);
  if (!savedPath) return false;
  const latest = useDocumentStore.getState();
  if (latest.documentId !== current.documentId || latest.revision !== current.revision) {
    throw new Error('保存期间工程发生变化，请再次创建。');
  }
  latest.markSaved(savedPath, current.revision, current.documentId);
  return true;
}

function useNewProjectDialog() {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('新建团播工程');
  return { newProjectOpen, setNewProjectOpen, newProjectName, setNewProjectName };
}
