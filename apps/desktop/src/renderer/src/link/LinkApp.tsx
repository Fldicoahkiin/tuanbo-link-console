import { Button, Dialog, IconButton } from './ui';
import './components/titlebar.css';
import { useSettingsExit } from './useSettingsExit';
import { toUserErrorMessage } from '@tb/core/link';
import { useMa2ReadStore } from './stores/ma2-read-store';
import { useDocumentShortcuts } from './useDocumentShortcuts';
import { useMidiPortMonitor } from './useMidiPortMonitor';
import { initializeStartupDevices } from './startup-obs-connection';
import { subscribeObsSceneSync } from './obs-scene-sync';
import { TitlebarStatus } from './components/TitlebarStatus';
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
import { SettingsNavigation, UpdateDot } from './components/SettingsNavigation';
import { usePendingUpdate } from './view-models/update-availability';
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
import { useRecoveryCopyWriter } from './recovery-copy-writer';
import { confirmReplaceDocument, showOpenedProject, useDocumentCommands, useDocumentStateReport } from './project-document';
import { useP1AutoFollow } from './useP1AutoFollow';
import { useInternalPlayer } from './useInternalPlayer';
import { useMa2Sync } from './runtime/use-ma2-sync';
import { useConsoleFollow } from './runtime/use-console-follow';
import { useStatusSources } from './runtime/use-status-sources';
import { useShowStateMirror } from './runtime/use-show-state-mirror';
import { useMa2SyncStore } from './stores/ma2-sync-store';
import { useMediaAudioPreparation } from './runtime/use-media-audio-preparation';
import { useLicenseReminders } from './useLicenseReminders';
import { TaskSidebarProgress } from './components/TaskSidebarProgress';
import { recordErrorNotice } from './error-notice-log';
import { noticeText, showMainProcessErrors } from './notice-text';
import { useKeyOverlay, useKeyRouter, usePageScope } from './keys/useKeyCommands';

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
  const [syncHost, setSyncHost] = useState<HTMLDivElement | null>(null); const [connectHost, setConnectHost] = useState<HTMLDivElement | null>(null); const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
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
  const previewPlaying = useMa2SyncStore(state => state.previewPlaying);
  const playbackLocked = editingLocked || previewPlaying || ['playing', 'paused'].includes(internalPlayer.state.status);
  useEffect(() => { if (!playbackLocked) setPlaybackProject(project); }, [playbackLocked, project]);
  // The window's one key listener (keys/key-router.ts). While the connection and settings page is open, the window's
  // playback keys wait and Escape there only closes the page (0.5.9; useKeyOverlay below).
  useKeyRouter();
  usePageScope(page);

  /** `written`: the text is written for the operator already and is shown as it is (noticeText). */
  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info', key?: string, written = false) => {
    const id = crypto.randomUUID();
    const displayMessage = noticeText(message, tone, written);
    if (tone === 'error' && message) recordErrorNotice(displayMessage, message);
    setNotices((current) => [...current.filter(notice => notice.message !== displayMessage && (!key || notice.key !== key)), ...(message ? [{ id, message: displayMessage, tone, ...(key ? { key } : {}) }] : [])]);
    if (tone === 'info') window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 5_000);
  }, []);

  const midiMonitor = useDesktopIntegrationEvents(notify); useEffect(() => { try { useDisplayPreferences.getState().load(); } catch (error) { notify(`显示设置读取失败：${String(error)}`, 'error'); } }, [notify]);
  useMa2Sync(notify);
  useConsoleFollow(internalPlayer, playbackProject); useStatusSources(); useShowStateMirror(notify);
  useProjectPersistence(notify); useRecoveryCopyWriter(); useMediaAudioPreparation(playbackLocked, notify);

  useDocumentStateReport(notify);

  useRuntimeCloseProtection(internalPlayer.state.status === 'preparing' ? 'preflight' : runtimeState, notify);

  useDocumentErrorNotification(documentError, notify);
  useUpdateAvailableNotice(notify);

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
      const replaced = await confirmReplaceDocument('new');
      if (!replaced) return;
      const next = await linkDesktopViewModel.createProject(newProjectName);
      useDocumentStore.getState().setProject(next, null);
      await replaced();
      setNewProjectOpen(false); setPage('project');
    } catch (error) {
      setNewProjectError(`无法创建工程：${error instanceof Error ? error.message : String(error)}。请检查保存位置后重试。`);
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const beginCreateProject = (): void => {
    setNewProjectError(null);
    setNewProjectOpen(true);
  };

  const openProject = async (): Promise<void> => {
    try {
      const result = await linkDesktopViewModel.pickOpenProject();
      if (!result) return;
      const replaced = await confirmReplaceDocument('open');
      if (!replaced) return;
      const detail = await showOpenedProject(result);
      await replaced();
      notify(`已打开：${result.project.name}${detail ? `；${detail}` : ''}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const { save: saveProject, saveAs: saveProjectAs, revert: revertProject } = useDocumentCommands(notify);


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
  // Escape closes the settings page (asking first when a form there is not saved), or the connection page. On a
  // drop-down list of the settings page it is left to the list.
  const connectionsPanel = useRef<HTMLElement>(null);
  const closePage = (): void => { if (!settingsOpen) setConnectionsOpen(false); else if (!(document.activeElement instanceof HTMLSelectElement)) closeSettings(); };
  useKeyOverlay(connectionsOpen, { close: closePage, panel: connectionsPanel, blocks: true });

  useEffect(() => {
    if (!openLighting) return;
    useMa2ReadStore.setState({ openWorkspace: false });
    leaveSettings(() => setPage('lighting'));
  }, [openLighting, leaveSettings]);
  useDocumentShortcuts(playbackLocked, saveProject, saveProjectAs);
  const documentActions = {
    canUndo: canUndo && (!playbackLocked || lightingUndo), canRedo: canRedo && (!playbackLocked || lightingRedo),
    historyDisabled: false,
    // Saving keeps the path, so it stays available while playing; Save As and revert do not.
    disabled: !project,
    onUndo: () => useDocumentStore.getState().undo(),
    onRedo: () => useDocumentStore.getState().redo(), onSave: () => void saveProject()
  };
  const fileCommands = { replaceDisabled: playbackLocked || !project, onSaveAs: () => void saveProjectAs(), onRevert: () => void revertProject() };
  const pageContent = <><div className="workspace-page" hidden={page !== 'project' || connectionsOpen}><ProjectWorkspace toolbarHost={page === 'project' && !connectionsOpen ? toolbarHost : null} playlistHost={playlistHost} onCreate={beginCreateProject} onOpen={() => void openProject()} onImportSongs={() => { setSettingsCategory('songs'); setSettingsLocation({ category: 'songs' }); openSettings(); }} player={internalPlayer} editingLocked={editingLocked} coordinator={coordinator} notify={notify} onOpenCueEditor={() => setPage('cues')} documentActions={documentActions} fileCommands={fileCommands} /></div>{(page === 'cues' || page === 'lighting') && !connectionsOpen ? <CueWorkspace syncHost={syncHost} key={page} workspace={page === 'lighting' ? 'lighting' : 'visual'} player={internalPlayer} playbackProject={playbackProject} sidebarHost={editorSidebarHost} toolbarHost={toolbarHost} coordinator={coordinator} notify={notify} documentActions={documentActions} /> : null}</>;

  return <RendererErrorBoundary>
    <div className="app-shell" data-workspace={connectionsOpen ? 'settings' : page}>
      <a className="skip-link" href="#workspace-content">跳到工作区</a>
      <AppTopbar status={<TitlebarStatus player={internalPlayer} onSettings={(category, focus) => { setSettingsCategory(category); setSettingsLocation({ category, ...(focus ? { focus } : {}) }); openSettings(); }} />} connectHostRef={setConnectHost} toolbarHostRef={setToolbarHost} onWindowAction={controlWindow} />
      <AppSidebar editorHostRef={setEditorSidebarHost} syncHostRef={setSyncHost} playlistHostRef={setPlaylistHost} settingsCategory={settingsCategory} onSettingsCategoryChange={category => { setSettingsLocation(null); setSettingsCategory(category); }}
        page={page} internal={project?.playbackSource === 'internal'} editingLocked={editingLocked}
        obsState={obs.status} p1State={processes.p1.status} runtimeState={runtimeState} settingsOpen={connectionsOpen} onPageChange={(next) => { leaveSettings(() => startTransition(() => setPage(next))); }} onSettings={openSettings}
        notify={notify}
      />
      <section className={`app-workspace${connectionsOpen ? ' settings-workspace' : ''}`}>
        <main className="app-main" id="workspace-content" tabIndex={-1} aria-label={connectionsOpen ? '设置' : NAVIGATION.find(item => item.id === page)?.label}>
          <div className="content-scroll">{pageContent}<section ref={connectionsPanel} hidden={!connectionsOpen} className="connections-dialog" role="dialog" aria-modal="false" aria-label={settingsOpen ? '设置' : '连接与设备'}><div className="connections-content" ref={settingsLocator.ref}><IntegrationWorkspace quickConnectHost={connectHost} midiMonitor={midiMonitor} category={settingsCategory} onCategoryChange={category => { setSettingsLocation(null); setSettingsCategory(category); }} coordinator={coordinator} notify={notify} settingsOpen={connectionsOpen && settingsOpen} onSettingsOpen={openSettings} onCreate={() => leaveSettings(beginCreateProject)} onOpen={() => leaveSettings(() => void openProject())} /></div></section>
      <div className="toast-stack" role="region" aria-label="通知"><div role="status" aria-live="polite">{licenseNotices.map((message, index) => <div className="toast info" key={`license-${index}`}><span>{message}</span><button aria-label="关闭授权提醒" onClick={() => dismissLicenseNotice(index)}><X aria-hidden="true" /></button></div>)}{notices.filter(notice => notice.tone === 'info').map((notice) => <div className="toast info" key={notice.id}><span>{notice.message}</span><button aria-label="关闭通知" onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}><X aria-hidden="true" /></button></div>)}</div><div role="alert">{notices.filter(notice => notice.tone === 'error').map((notice) => <div className="toast error" key={notice.id}><span>{notice.message}</span><button aria-label="关闭错误通知" onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}><X aria-hidden="true" /></button></div>)}</div></div></div>
        </main>
      </section>

      {settingsExit ? <Dialog title="离开设置？" size="sm" onClose={() => setSettingsExit(null)} actions={<>
        <Button variant="secondary" onClick={() => setSettingsExit(null)}>继续编辑</Button>
        <Button variant="danger" onClick={settingsExit}>放弃未保存修改</Button>
      </>}><p>连接或启动设置还没保存，离开后这部分修改会丢失。其他已保存的设置和工程修改不受影响。</p></Dialog> : null}
      {newProjectOpen ? <ProjectDialog name={newProjectName} error={newProjectError} onNameChange={setNewProjectName} onClose={() => setNewProjectOpen(false)} onCreate={() => void createProject()} /> : null}
    </div>
  </RendererErrorBoundary>;
}

function AppSidebar({ editorHostRef, syncHostRef, settingsCategory, onSettingsCategoryChange, playlistHostRef, page, internal, editingLocked, settingsOpen, onPageChange, onSettings, notify }: {
  editorHostRef: (element: HTMLDivElement | null) => void;
  /** The lighting workbench puts its console sync controls here, under its own menu. */
  syncHostRef: (element: HTMLDivElement | null) => void;
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
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  const pendingUpdate = usePendingUpdate();
  return <aside className="app-sidebar">
    <nav className="main-nav workspace-navigation" aria-label="主要工作区">{NAVIGATION.map((item) => {
      const Icon = item.icon;
      const disabled = editingLocked && !internal && item.id === 'cues';
      const active = !settingsOpen && page === item.id;
      return <button key={item.id} title={`${item.label} · ${disabled ? '已锁定' : item.caption}`} disabled={disabled} aria-current={active ? 'page' : undefined} className={active ? 'active' : ''} onClick={() => onPageChange(item.id)}><Icon aria-hidden="true" /><span><strong>{item.label}</strong></span></button>;
    })}<button className={settingsOpen ? 'active' : ''} aria-current={settingsOpen ? 'page' : undefined} onClick={onSettings}><Settings aria-hidden="true" /><span><strong>设置</strong></span>{pendingUpdate ? <UpdateDot version={pendingUpdate} /> : null}</button></nav>
    <div className="sidebar-context">
      <div className="sidebar-playlists" hidden={settingsOpen || page !== 'project'} ref={playlistHostRef} />
      <div className="sidebar-editor" hidden={settingsOpen || page === 'project'} ref={editorHostRef} />
      <div className="sidebar-sync" hidden={settingsOpen || page !== 'lighting'} ref={syncHostRef} />
      {settingsOpen ? <SettingsNavigation selected={settingsCategory} onSelect={onSettingsCategoryChange} /> : null}
      <TaskSidebarProgress notify={notify}/>
    </div>
  </aside>;
}

/**
 * The window's title bar (2026-10-30 rework): the page's document controls, the connection status,
 * free space to drag the window, one-click connect and the window buttons. It holds nothing that only
 * one page needs beyond its document controls.
 */
function AppTopbar({ status, connectHostRef, toolbarHostRef, onWindowAction }: {
  status: ReactNode;
  connectHostRef: (element: HTMLDivElement | null) => void;
  toolbarHostRef: (element: HTMLDivElement | null) => void;
  onWindowAction: (action: 'minimize' | 'toggleMaximize' | 'close') => void;
}): JSX.Element {
  return <header className="titlebar" aria-label="窗口标题栏">
    <div className="titlebar-document-host" ref={toolbarHostRef} />
    <div className="titlebar-middle">
      {status}
      <div className="titlebar-drag" title="拖动窗口，双击最大化或还原" aria-hidden="true" />
    </div>
    <div className="titlebar-connect" ref={connectHostRef} />
    <div className="titlebar-window" role="group" aria-label="窗口控制">
      <IconButton label="最小化窗口" icon={Minus} onClick={() => onWindowAction('minimize')} />
      <IconButton label="最大化或还原窗口" icon={Maximize2} onClick={() => onWindowAction('toggleMaximize')} />
      <IconButton label="关闭窗口" icon={X} className="titlebar-close" onClick={() => onWindowAction('close')} />
    </div>
  </header>;
}

function useRuntimeCloseProtection(
  runtimeState: ReturnType<typeof useRuntimeStore.getState>['state'],
  notify: (message: string, tone?: 'info' | 'error') => void
): void {
  useEffect(() => {
    void linkDesktopViewModel.setRuntimeActive(runtimeState !== 'idle')
      .catch((error: unknown) => notify(`更新防误关窗口设置失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }, [notify, runtimeState]);
}

function useDesktopIntegrationEvents(notify: (message: string, tone?: 'info' | 'error', key?: string, written?: boolean) => void): ReturnType<typeof useMidiPortMonitor> {
  const midiMonitor = useMidiPortMonitor(notify);
  useEffect(() => {
    let cancelled = false;
    const reportLogFailure = (error: unknown): void => {
      if (!cancelled) notify(`设备状态日志写入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    };
    const unsubscribeInventory = subscribeObsSceneSync(notify);
    // The main process logs OBS connection changes.
    const unsubscribeObs = linkDesktopViewModel.onObsStatus((snapshot) => { useIntegrationStore.getState().setObs(snapshot); });
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
    // Written for the operator in main (main-process-errors.ts): shown as it is. Subscribed before the state below loads:
    // the program opens only after that (useInternalPlayer waits for it), and main takes the open as the sign that red
    // text reaches this window.
    const unsubscribeMainErrors = showMainProcessErrors(listener => linkDesktopViewModel.onMainProcessError(listener), notify);
    void loadDesktopIntegrationState(() => cancelled, notify);
    return () => {
      cancelled = true;
      unsubscribeInventory();
      unsubscribeObs();
      unsubscribeProcess();
      unsubscribeMainErrors();
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

/** The main process checks once after startup; each new version is announced once per session. */
function useUpdateAvailableNotice(notify: (message: string, tone?: 'info' | 'error', key?: string) => void): void {
  useEffect(() => {
    const announced = new Set<string>();
    return window.tbLink.onUpdateStatus(status => {
      if (status.phase !== 'available' || !status.availableVersion || announced.has(status.availableVersion)) return;
      announced.add(status.availableVersion);
      notify(`有新版本 ${status.availableVersion}，可在「设置 › 外观与更新 › 软件更新」中查看`, 'info', 'update-available');
    });
  }, [notify]);
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

function useNewProjectDialog() {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('新建团播工程');
  return { newProjectOpen, setNewProjectOpen, newProjectName, setNewProjectName };
}
