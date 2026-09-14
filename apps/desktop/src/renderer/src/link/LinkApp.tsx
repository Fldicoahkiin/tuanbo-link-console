import { useMidiPortMonitor } from './useMidiPortMonitor';
import { prepareLoopMidi } from './view-models/loop-midi';
import { subscribeObsSceneSync } from './obs-scene-sync';
import { ToolbarConnections } from './components/ToolbarConnections';
import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import {
  Activity,
  ListMusic,
  Maximize2,
  Minus,
  Settings,
  SlidersHorizontal,
  X
} from 'lucide-react';
import type { SettingsCategory } from './components/settings-navigation';
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

type Page = 'project' | 'cues';
type Notice = { id: string; message: string; tone: 'info' | 'error' };
type NavigationItem = { id: Page; label: string; caption: string; icon: typeof ListMusic };

const NAVIGATION: NavigationItem[] = [
  { id: 'project', label: '节目单', caption: '安排节目与素材', icon: ListMusic },
  { id: 'cues', label: '编辑器', caption: '编排画面与动作', icon: SlidersHorizontal }
];

export function LinkApp(): JSX.Element {
  useAppearanceTheme();
  const [connectHost, setConnectHost] = useState<HTMLDivElement | null>(null); const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [editorSidebarHost, setEditorSidebarHost] = useState<HTMLDivElement | null>(null);
  const [playlistHost, setPlaylistHost] = useState<HTMLDivElement | null>(null);
  const [page, setPage] = useState<Page>('project');
  const [coordinator, setCoordinator] = useState<LinkRuntimeCoordinator | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const { newProjectOpen, setNewProjectOpen, newProjectName, setNewProjectName } = useNewProjectDialog();
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('obs');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const coordinatorDocumentIdRef = useRef<number | null>(null);
  const project = useDocumentStore((state) => state.project);
  const projectPath = useDocumentStore((state) => state.path);
  const documentId = useDocumentStore((state) => state.documentId);
  const dirty = useDocumentStore((state) => state.dirty);
  const documentError = useDocumentStore((state) => state.error);
  const canUndo = useDocumentStore(selectCanUndo);
  const canRedo = useDocumentStore(selectCanRedo);
  const obs = useIntegrationStore((state) => state.obs);
  const processes = useIntegrationStore((state) => state.processes);
  const integrationInitialized = useIntegrationStore((state) => state.initialized);
  const runtimeState = useRuntimeStore((state) => state.state);
  const [playbackProject, setPlaybackProject] = useState(project);
  const internalPlayer = useInternalPlayer(coordinator, integrationInitialized, playbackProject);
  const editingLocked = internalPlayer.state.status === 'preparing' || ['preflight', 'armed', 'running', 'timecodeLost', 'paused', 'error', 'stopping'].includes(runtimeState);
  useEffect(() => { if (!editingLocked) setPlaybackProject(project); }, [editingLocked, project]);
  useConnectionsEscape(connectionsOpen && !settingsOpen, () => setConnectionsOpen(false));

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = crypto.randomUUID();
    setNotices((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 5_000);
  }, []);

  const midiMonitor = useDesktopIntegrationEvents(notify); useEffect(() => { try { useDisplayPreferences.getState().load(); } catch (error) { notify(`显示设置读取失败：${String(error)}`, 'error'); } }, [notify]);
  useProjectPersistence(notify);

  useEffect(() => {
    void linkDesktopViewModel.setDocumentDirty(dirty).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error'));
  }, [dirty, notify]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (editingLocked) {
        if (['s', 'y', 'z'].includes(event.key.toLowerCase())) event.preventDefault();
        return;
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveProject();
      } else if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        useDocumentStore.getState().undo();
      } else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
        event.preventDefault();
        useDocumentStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createProject = async (): Promise<void> => {
    try {
      if (!await saveBeforeNewProject()) return;
      const next = await linkDesktopViewModel.createProject(newProjectName);
      useDocumentStore.getState().setProject(next, null);
      setNewProjectOpen(false); setPage('project');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const beginCreateProject = (): void => {
    if (dirty && !window.confirm('新建独立工程会切换到空节目单，当前工程将先保存。是否继续？')) return;
    setNewProjectOpen(true);
  };

  const openProject = async (): Promise<void> => {
    if (dirty && !window.confirm('当前工程有未保存修改，确认打开其他工程？')) return;
    try {
      const result = await linkDesktopViewModel.pickOpenProject();
      if (!result) return;
      useDocumentStore.getState().setProject(result.project, result.path);
      setPage('project');
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

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setConnectionsOpen(false);
  }, []);

  const documentActions = {
    canUndo, canRedo,
    disabled: editingLocked || !project,
    onUndo: () => useDocumentStore.getState().undo(),
    onRedo: () => useDocumentStore.getState().redo(), onSave: () => void saveProject()
  };
  const pageContent = <><div className="workspace-page" hidden={page !== 'project' || connectionsOpen}><ProjectWorkspace toolbarHost={page === 'project' && !connectionsOpen ? toolbarHost : null} playlistHost={playlistHost} onCreate={beginCreateProject} onOpen={() => void openProject()} player={internalPlayer} editingLocked={editingLocked} coordinator={coordinator} notify={notify} onOpenCueEditor={() => setPage('cues')} documentActions={documentActions} /></div>{page === 'cues' && !connectionsOpen ? <CueWorkspace player={internalPlayer} sidebarHost={editorSidebarHost} toolbarHost={toolbarHost} coordinator={coordinator} notify={notify} documentActions={documentActions} /> : null}</>;

  return <RendererErrorBoundary>
    <div className="app-shell">
      <AppTopbar connectHostRef={setConnectHost} toolbarHostRef={setToolbarHost} onWindowAction={controlWindow} />
      <AppSidebar editorHostRef={setEditorSidebarHost} playlistHostRef={setPlaylistHost} settingsCategory={settingsCategory} onSettingsCategoryChange={setSettingsCategory}
        page={page} internal={project?.playbackSource === 'internal'} editingLocked={editingLocked}
        obsState={obs.status} p1State={processes.p1.status} runtimeState={runtimeState} settingsOpen={connectionsOpen} onPageChange={(next) => { closeSettings(); setPage(next); }} onSettings={openSettings}
      />
      <section className={`app-workspace${connectionsOpen ? ' settings-workspace' : ''}`}>
        {connectionsOpen ? <SettingsSectionNavigation selected={settingsCategory} onSelect={setSettingsCategory} /> : null}
        <main className="app-main">
          <div className="content-scroll">{pageContent}<section hidden={!connectionsOpen} className="connections-dialog" role="dialog" aria-modal="false" aria-label={settingsOpen ? '设置' : '连接与设备'}><div className="connections-content"><IntegrationWorkspace quickConnectHost={connectHost} midiMonitor={midiMonitor} category={settingsCategory} onCategoryChange={setSettingsCategory} coordinator={coordinator} notify={notify} settingsOpen={connectionsOpen && settingsOpen} onSettingsClose={closeSettings} /></div></section>
      <div className="toast-stack">{notices.map((notice) => <div className={`toast ${notice.tone}`} key={notice.id}><span>{notice.message}</span><button onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}><X /></button></div>)}</div></div>
        </main>
      </section>

      {newProjectOpen ? <div className="modal-backdrop"><div className="modal-card"><span className="eyebrow">NEW PROJECT</span><h2>新建联动工程</h2><p>这会切换到一份独立的空节目单。当前工程会保存在原文件中；要继续添加内容，请取消并使用“添加节目”。</p><label className="field"><span>工程名称</span><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.currentTarget.value)} /></label><div className="modal-actions"><button className="secondary-button" onClick={() => setNewProjectOpen(false)}>取消</button><button className="primary-button" disabled={!newProjectName.trim()} onClick={() => void createProject()}>创建工程</button></div></div></div> : null}
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
    <nav className="main-nav" aria-label="主要工作区">{NAVIGATION.map((item) => {
      const Icon = item.icon;
      const disabled = editingLocked && !internal;
      return <button key={item.id} title={`${item.label} · ${disabled ? '已锁定' : item.caption}`} disabled={disabled} className={!settingsOpen && page === item.id ? 'active' : ''} onClick={() => onPageChange(item.id)}><Icon /><span><strong>{item.label}</strong></span></button>;
    })}<button className={settingsOpen ? 'active' : ''} onClick={onSettings}><Settings /><span><strong>设置</strong></span></button></nav>
    <div className="sidebar-context">
      <div className="sidebar-playlists" hidden={settingsOpen || page !== 'project'} ref={playlistHostRef} />
      <div className="sidebar-editor" hidden={settingsOpen || page !== 'cues'} ref={editorHostRef} />
      {settingsOpen ? <SettingsNavigation selected={settingsCategory} onSelect={onSettingsCategoryChange} /> : null}
    </div>
  </aside>;
}

function AppTopbar({ connectHostRef, toolbarHostRef, onWindowAction }: {
  connectHostRef: (element: HTMLDivElement | null) => void;
  toolbarHostRef: (element: HTMLDivElement | null) => void;
  onWindowAction: (action: 'minimize' | 'toggleMaximize' | 'close') => void;
}): JSX.Element {
  return <div className="app-topbar">
    <div className="persistent-project-toolbar" ref={toolbarHostRef} />
    <div className="topbar-status"><ToolbarConnections /></div>
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
  useIntegrationStore.getState().setInitialized(false);
  try {
    const [appInfo, profile, securityAvailable, obsSnapshot, snapshots] = await Promise.all([
      linkDesktopViewModel.getAppInfo(),
      linkDesktopViewModel.loadIntegrationProfile(),
      linkDesktopViewModel.getSecurityAvailability(),
      linkDesktopViewModel.getObsSnapshot(),
      linkDesktopViewModel.getExternalSnapshots()
    ]);
    if (isCancelled()) return;
    useIntegrationStore.getState().setAppInfo(appInfo);
    useIntegrationStore.getState().setProfile(profile);
    useIntegrationStore.getState().setSecurityAvailable(securityAvailable);
    useIntegrationStore.getState().setObs(obsSnapshot);
    for (const snapshot of snapshots) useIntegrationStore.getState().setProcess(snapshot);
    if (profile) {
      try { await prepareLoopMidi(profile); }
      catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    }
    if (profile && securityAvailable && obsSnapshot.status !== 'connected') {
      const security = await linkDesktopViewModel.getSecurityPreflight();
      if (security.credentialDecryptable) {
        const connected = await linkDesktopViewModel.connectObs();
        if (isCancelled()) return;
        useIntegrationStore.getState().setObs(connected);
        useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
        notify('已自动连接 OBS 并刷新摄像头。');
      }
    }
  } catch (error) {
    if (!isCancelled()) notify(`桌面集成初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Renderer crashed', error, info); }
  override render(): ReactNode {
    if (this.state.error) return <div className="fatal-screen"><Activity /><h1>团播联动台界面发生错误</h1><pre>{this.state.error.stack ?? this.state.error.message}</pre></div>;
    return this.props.children;
  }
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
