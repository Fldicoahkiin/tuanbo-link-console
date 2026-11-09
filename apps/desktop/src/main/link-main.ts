import { ma2LayoutDirectoryRequestSchema, ma2LayoutUpdateRequestSchema } from '@tb/schema';
import { projectArchiveRequestSchema, projectArchiveSettingsActionSchema, recoveryCopyDiscardSchema, recoveryCopyQuerySchema, recoveryCopyWriteSchema, type NativeObsPrepare } from '@tb/schema';
import { ma2ExecutorPageRequestSchema, ma2ExecutorUpdateRequestSchema, ma2ExecutorInputSchema } from '@tb/schema';
import { ma2NetworkTargetSchema, ma2SongCheckRequestSchema, ma2SongSyncRequestSchema, type LicenseStatus } from '@tb/schema';
import { firstTimeWarning, materialSceneTargets, projectFileReferences } from '@tb/core/link';
import { ibtExecutable } from './link/ibt-beat-service';
import { Ma2AuditionService } from './link/ma2-audition-service';
import { assertMa2ConnectionOwner, isLocalMa2Address, waitForMa2Listener } from './link/ma2-connection-owner';
import { ma2AuditionRequestSchema,ma2AuditionControlSchema } from '@tb/schema';
import { WindowsMidiHealth, midiProbeExecutable, probeWindowsMidi, midiHealthMessage } from './link/windows-midi-health';
import { LicenseService } from './link/license-service';
import { PurchaseService } from './link/purchase-service';
import { isProductWebsiteUrl } from './link/product-website';
import { writeFileAtomically } from './link/atomic-file';
import { createLicenseMachineCodeReader } from './link/license-machine';
import { localTestAccessEnabled, localTestLicenseStatus } from './link/local-test-license';
import licensePublicKeys from './link/license-public-keys.json';
import releasePublicKeys from './link/release-public-keys.json';
import licenseConfig from './link/license-config.json';
import { LicenseAccess } from './link/license-access';
import { authorizeRequest, programLicense, type LicenseGate } from './link/program-license';
import { licenseRequestSchema } from '@tb/schema';
import { licenseLogDetails, licenseStateLabel } from './link/license-log';
import { FeedbackService, feedbackContext, feedbackRange, type FeedbackIdentity } from './link/feedback-service';
import { feedbackEnvironment, recentCrashDumps } from './link/diagnostic-environment';
import { feedbackCategoryLabels, linkFeedbackDraftSchema, type LinkFeedbackResult } from '@tb/schema';
import { installObsLiveBridge } from './link/obs-live-install';
import { existsSync } from 'node:fs';
import { elevateObsPluginInstall } from './link/obs-plugin-elevation';
import { ObsBridgeSetup } from './link/obs-bridge-setup';
import { prepareLocalObsConnection, readObsCommandLine } from './link/obs-local-connection';
import { localObsConnectionResultSchema } from '@tb/schema';
import { obsEndpointNotListening, waitForObsEndpoint } from './link/obs-startup';
import { obsLiveEditSchema, obsMediaPreparationSchema } from '@tb/schema';
import { beautyApplySchema, beautyBasicValuesSchema, beautyTargetSchema, beautyStartSchema } from '@tb/schema';
import { BeautyRuntime } from './link/beauty-runtime';
import { BeautyOutputController } from './link/beauty-output-controller';
import { BeautyComparison } from './link/beauty-comparison';
import { ObsLivePreview } from './link/obs-live-preview';
import { ObsNativeSeek } from './link/obs-native-seek';
import { obsSourceCreateSchema, obsSourceNameSchema, obsSourceApplySchema, ma2BridgeRequestSchema, ma2ReadRequestSchema, ma2CompareRequestSchema, ma2ApplyRequestSchema, ma2CreateRequestSchema } from '@tb/schema';
import { createMa2Timecode } from './link/ma2-create';
import { renameMa2Object } from './link/ma2-rename-service';
import { ma2RenameRequestSchema } from '@tb/schema';
import { ma2CatalogRequestSchema, ma2ReadProgressSchema, linkP1ProjectImportProgressSchema, type Ma2ReadProgressUpdate, type LinkP1ProjectImportProgress } from '@tb/schema';
import { readMa2Catalog } from './link/ma2-catalog';
import { Ma2ReadRecovery } from './link/ma2-read-recovery';
import { Ma2MaterialRecovery } from './link/ma2-material-recovery';
import { readMa2EffectLibrary } from './link/ma2-effect-library';
import { ma2LayoutReadRequestSchema, ma2NewCueRequestSchema } from '@tb/schema';
import { ma2CueDeletePrepareSchema, ma2CueDeleteCommitSchema } from '@tb/schema';
import { ma2ExecutorReadRequestSchema } from '@tb/schema';
import { readMa2Executor } from './link/ma2-executor-read';
import { Ma2Connections } from './link/ma2-connections';
import { Ma2DataDirectory, detectMa2DataDirectory } from './link/ma2-data-directory';
import { Ma2DiscoveryService } from './link/ma2-discovery';
import { Ma2NetworkSetup } from './link/ma2-network-setup';
import { ma2NetworkSetupRequestSchema } from '@tb/schema';
import { Ma2NetworkManager } from './link/ma2-network-manager';
import { Ma2ConsoleBackups } from './link/ma2-console-backups';
import { ma2PlaybackRequestSchema, ma2NetworkSaveSchema, ma2LiveConnectSchema, ma2LiveInputSchema, ma2LiveRequestSchema, ma2ExecutorObserveRequestSchema } from '@tb/schema';
import ma2PluginLua from '../../../../tools/ma2/tblink_bridge.lua?raw';
import ma2PluginXml from '../../../../tools/ma2/tblink_bridge.xml?raw';
import ma2PluginInstructions from '../../../../tools/ma2/README.md?raw';
import { compareMa2LightingReadback } from './link/ma2-comparison';
import { convertMa2Snapshot } from './link/ma2-timecode-conversion';
import { readFile, stat, statfs, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { assetResponse } from './link/asset-response';
import { ProjectDocumentService } from './link/project-document-service';
import { ProjectArchiveSettingsStore, projectArchives } from './link/project-archives';
import { offerRecoveryCopy, RecoveryCopies, type RecoveryOffer } from './link/recovery-copies';
import { RendererSaveRequests, UnsavedChangesGuard, unsavedChangesPrompt } from './link/unsaved-changes-guard';
import { cpus, release, totalmem, freemem, networkInterfaces } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { projectDocumentTextSchema, projectSaveOptionsSchema } from '@tb/schema';
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  shell,
  type IpcMainInvokeEvent
} from 'electron';
import {
  createEmptyLinkProject,
  linkDiagnosticContextSchema,
  linkLogExportRangeSchema,
  linkDocumentStateSchema,
  linkSaveResponseSchema,
  linkUnsavedChangesReasonSchema,
  type LinkDocumentState,
  linkRuntimeActiveSchema,
  linkExternalApplicationIdSchema,
  linkFilePathSchema,
  linkIntegrationProfileSavePayloadSchema,
  linkLogFilterSchema,
  linkLogRecordSchema,
  linkMediaAssetImportPayloadSchema,
  linkMediaAssetResolvePayloadSchema,
  linkMediaPreviewPayloadSchema,
  linkMediaInspectionPayloadSchema,
  linkProjectAssetFilesPayloadSchema,
  linkProjectAssetRelinkPayloadSchema,
  linkManagedMediaExecutionPayloadSchema,
  linkObsSourcePreviewPayloadSchema,
  linkOptionalFilePathSchema,
  linkP1ProjectExportPayloadSchema,
  linkP1ProjectExportPreviewPayloadSchema,
  linkP1ProjectImportPayloadSchema,
  linkProjectNameSchema,
  linkReferenceAudioImportPayloadSchema,
  linkReferenceAudioResolvePayloadSchema,
  linkWaveformCachePayloadSchema,
  linkWaveformGeneratePayloadSchema,
  linkWaveformCacheSavePayloadSchema,
  linkWindowControlActionSchema,
  linkActionSchema,
  parseLinkProject,
  type IntegrationProfile
} from '@tb/schema';
import type {
  LinkAppInfo,
  LinkObsInventory,
  LinkObsSnapshot,
  LinkProcessSnapshot,
  LinkUpdateStatus
} from '@tb/core/link';
import { ExternalProcessManager, WindowsProcessTools, type ExternalApplicationId } from './link/external-process-manager';
import { processIdentityExecutable, readProcessIdentities } from './link/process-identity';
import { ResourceMonitor } from './link/resource-monitor';
import { LinkProjectService } from './link/link-project-service';
import { AssetRelinkRequests } from './link/asset-relink-requests';
import { ProjectAccess } from './link/project-access';
import { WindowLogRate } from './link/window-log-rate';
import { ChosenPaths, requireChosenPrograms } from './link/chosen-paths';
import { MediaMetadataProbe } from './link/media-metadata-probe';
import { MediaPreviewService } from './link/media-preview-service';
import { obsMediaCachePaths } from './link/obs-media-paths';
import { WaveformService } from './link/waveform-service';
import { AudioEditService } from './link/audio-edit-service';
import { MusicAnalysisService } from './link/music-analysis-service';
import { AutomaticMusicRuntime } from './link/automatic-music-runtime';
import { automaticMusicRequestSchema, automaticMusicControlSchema, nativeDeviceQueryRequestSchema } from '@tb/schema';
import { MusicMonitorService } from './link/music-monitor-service';
import { musicMonitorRequestSchema } from '@tb/schema';
import { musicAnalysisRequestSchema, musicAnalysisControlSchema } from '@tb/schema';
import { audioAnalysisRequestSchema, audioRenderRequestSchema } from '@tb/schema';
import { ObsWebSocketAdapter } from './link/obs-websocket-adapter';
import { ObsEditorPreview, findLocalObsPid } from './link/obs-editor-preview';
import { P1ProjectService } from './link/p1-project-service';
import { LinkRunLogger, redactValue, type LinkLogEntry, type LinkLogFilter } from './link/run-logger';
import { closedProgramFaultReporter, mainProcessErrorReporter, reportMainProcessErrors } from './link/main-process-errors';
import { SecureProfileStore } from './link/secure-profile-store';
import { WindowsIntegrationDetector } from './link/windows-integration-detector';
import { LoopMidiService } from './link/loop-midi-service';
import { loopMidiActionSchema, loopMidiStatusSchema } from '@tb/schema';
import { LinkUpdateManager } from './link/update-manager';
import { rendererSource } from './link/renderer-source';
import { buildGitSha, buildVersion, releaseChannel, releaseChannelLabel } from './link/build-identity';
import desktopPackage from '../../package.json';
import ffmpegPath from 'ffmpeg-static';
import { NativeAudioCache } from './link/native-audio-cache';
import { NativePlayerService } from './link/native-player-service';
import { NativeMidiCheckService } from './link/native-midi-check';
import { MidiPortBroker } from './link/midi-port-broker';
import { NativeMidiOutput } from './link/native-midi-output';
import { NativeMidiInput } from './link/native-midi-input';
import { NativeDeviceQuery } from './link/native-device-query';
import { midiPortHandleSchema, midiPortListRequestSchema, midiPortOpenSchema, midiPortSendSchema } from '@tb/schema';
import { NativePlayerUiPublisher } from './link/native-player-ui-publisher';
import { NativeProgramHost } from './link/native-program-host';
import { NativeProgramService } from './link/native-program-service';
import { NativePlaybackRequests } from './link/native-playback-requests';
import { NativeObsHost } from './link/native-obs-host';
import { NativeObsRequests } from './link/native-obs-requests';
import { NativeObsPreloadPool } from './link/native-obs-preload';
import { createNativeObsOutputs } from './link/native-obs-outputs';
import { PreparationSteps } from './link/preparation-log';
import { obsStatusLogEntry } from './link/obs-status-log';
import { prepareNextObsFiles } from './link/native-obs-files';

/** False in `electron-vite build --mode release`; app.isPackaged only checks the executable name. */
declare const __TBLINK_LOCAL_TEST_ACCESS__: boolean;

protocol.registerSchemesAsPrivileged([{
  scheme: 'tblink-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

// OBS owns the live video renderer. Keeping Chromium's UI canvases on the
// software path avoids competing for the same Windows GPU command queue while
// OBS starts a high-resolution media source during playback.
if (process.platform === 'win32') app.disableHardwareAcceleration();
crashReporter.start({ uploadToServer: false });

let mainWindow: BrowserWindow | null = null;
/** The open document as the window last reported it; the unsaved-changes guard reads it. */
let documentState: LinkDocumentState = { version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null };
/** The operator chose 不保存 for this quit; its recovery copy goes once the quit completes. */
let discardOnQuit = false;
let recoveryCopies: RecoveryCopies | null = null;
const rendererSaves = new RendererSaveRequests(() => {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isCrashed()) return null;
  return { send: id => window.webContents.send('link:save-request', { version: 1, id }) };
});
const unsavedChanges = new UnsavedChangesGuard({
  state: () => documentState,
  ask: async prompt => {
    const options = unsavedChangesPrompt(prompt);
    const { response } = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  },
  save: () => rendererSaves.request(),
  log: (level, message) => { void ipcLogger?.record({ level, category: 'system', message }).catch((error: unknown) => console.error('记录未保存修改处理失败', error)); }
});
/** Every quit (window close, app.quit, Windows session end) goes through here. */
let requestQuit: () => void = () => { app.quit(); };
/** The guard and quit flow behind requestQuit and the update install; `finish` ends the app once
 * everything is closed. Resolves false when the operator kept the app open. */
let runQuit: (reason: 'quit' | 'update', finish: () => void) => Promise<boolean> = () => Promise.resolve(false);
let runtimeActive = false;
let releaseRendererRuntime: () => Promise<void> = () => Promise.resolve();
let automaticMusic: AutomaticMusicRuntime | null = null;
let authorizeOutput: () => Promise<void> = () => Promise.reject(new Error('授权服务还没准备好'));
let authorizeProduct: (channel: string, value: unknown) => Promise<void> = () => Promise.reject(new Error('授权服务还没准备好'));
let readLicenseStatus: () => Promise<LicenseStatus> = () => Promise.reject(new Error('授权服务还没准备好'));
let ipcLogger: LinkRunLogger | null = null;
let allowWindowClose = false;
let stopAuditionForQuit: (() => Promise<void>) | null = null;
let quitFlowRunning = false;
let restoreMainWindow: (() => void) | null = null;
let nativePlayer: NativePlayerService | null = null;
let musicMonitor: MusicMonitorService | null = null;
const nativePlayerUi = new NativePlayerUiPublisher(status => sendToRenderer('link:native-player-status', status));
let nativePlayerShutdown: Promise<void> | null = null;
let nativeObs: NativeObsHost | null = null;
let nativeObsPreload: NativeObsPreloadPool | null = null;
let nativeProgram: NativeProgramService | null = null;
let nativeProgramHost: NativeProgramHost | null = null;
/** Every MIDI port the window uses is opened here, in main, and only while it is in use. */
let midiPorts: MidiPortBroker | null = null;

async function closeNativePlayer(): Promise<void> {
  await nativeProgram?.close();
  const player = nativePlayer;
  nativePlayerShutdown ??= (async () => {
    const results = await Promise.allSettled([player?.close(), nativeObs?.stop(), nativeObsPreload?.close(), musicMonitor?.stop()]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (failures.length) throw new AggregateError(failures, '音频或画面没能完全关闭，请查看运行日志');
  })();
  // A failed close keeps the owned instance and blocks another engine from
  // opening the same device. Never claim stopped or spawn a replacement.
  await nativePlayerShutdown;
  if (nativePlayer === player) nativePlayer = null;
  nativePlayerShutdown = null;
}
function nativePlaybackActive(): boolean {
  return Boolean(nativePlayer?.status && ['preparing', 'playing', 'paused'].includes(nativePlayer.status.status));
}
/** Which build this is: shown in the update panel and written to logs and diagnostic packages. */
function buildIdentity(): Pick<LinkAppInfo, 'name' | 'version' | 'channel' | 'gitSha' | 'appId'> {
  return { name: app.getName(), version: buildVersion, channel: releaseChannel(app.isPackaged),
    gitSha: buildGitSha, appId: desktopPackage.build.appId };
}
function buildIdentityLine(): string {
  const identity = buildIdentity();
  return `${identity.name} ${identity.version} · ${releaseChannelLabel[identity.channel]} · 提交 ${identity.gitSha ?? '未知'} · ${identity.appId}`;
}
// Identifies programs Windows hides from a normal-privilege console, such as OBS run as administrator.
const identityHelper = processIdentityExecutable(app.isPackaged ? process.resourcesPath : undefined);
const midiHealth = new WindowsMidiHealth(() => probeWindowsMidi(midiProbeExecutable(app.isPackaged ? process.resourcesPath : undefined)));

const projectService = new LinkProjectService();
const projectDocuments = new ProjectDocumentService();
const p1ProjectService = new P1ProjectService(projectService);
const mediaMetadataProbe = new MediaMetadataProbe();
const mediaPreviewService = new MediaPreviewService(projectService);
const knownSecrets = new Set<string>();

async function bootstrap(): Promise<void> {
  reportMainProcessErrors(mainProcessErrorReporter(
    (message, details) => ipcLogger ? ipcLogger.record({ level: 'error', category: 'system', message, details, result: 'failed' }) : Promise.resolve(console.error(message, details)),
    message => sendToRenderer('link:main-process-error', message)));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => {
    if (!mainWindow) restoreMainWindow?.();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show(); mainWindow?.focus();
  });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const profileStore = new SecureProfileStore(app.getPath('userData'), safeStorage);
  const obs = new ObsWebSocketAdapter(join(app.getPath('documents'), '团播联动台', 'screenshots'), undefined, undefined,
    new ObsEditorPreview(join(app.getPath('documents'), '团播联动台', 'OBS预览')));
  const processManager = new ExternalProcessManager(new WindowsProcessTools(identityHelper), obs);
  const integrationDetector = new WindowsIntegrationDetector();
  const logger = new LinkRunLogger(join(app.getPath('userData'), 'link-logs'), () => [...knownSecrets]);
  ipcLogger = logger;
  await logger.record({ level: 'info', category: 'system', message: `${buildIdentityLine()} 已启动`,
    details: { appVersion: buildVersion, ...buildIdentity(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, windows: release(), versions: process.versions } })
    .catch((error: unknown) => dialog.showErrorBox('运行日志无法写入', error instanceof Error ? error.message : String(error)));
  // Earlier sessions' logs keep within 30 days and 200 MB, moved to the recycle bin like archives; this session's file stays.
  // shell.trashItem refuses an item the bin cannot take (a network path: rejected, file kept) and recycled local files from
  // both a desktop and an SSH session on the dev PC (checked 2026-10-24), so a cleanup does not become a permanent delete.
  void logger.pruneSessions(path => shell.trashItem(path)).then(async pruned => {
    if (pruned.length === 0) return;
    const bytes = pruned.reduce((sum, entry) => sum + entry.bytes, 0);
    await logger.record({ level: 'info', category: 'system', message: `已把 ${pruned.length} 个旧日志（${(bytes / 1024 / 1024).toFixed(1)} MB）移到回收站`,
      details: { expired: pruned.filter(entry => entry.reason === 'expired').length, overSize: pruned.filter(entry => entry.reason === 'over-size').length, bytes,
        files: pruned.slice(0, 300).map(entry => basename(entry.file)) } });
  }).catch(async (error: unknown) => {
    await logger.record({ level: 'warning', category: 'system', message: '旧日志没清理完，下次启动时再试', details: { error: error instanceof Error ? error.message : String(error) } });
  }).catch((error: unknown) => console.error('日志清理结果未能写入', error));
  app.on('child-process-gone', (_event, details) => {
    void logger.record({ level: 'error', category: 'device', device: 'Electron',
      message: `Electron ${details.type} 进程退出：${details.reason}，退出码 ${details.exitCode}`,
      result: 'failed' }).catch((error: unknown) => console.error('记录 Electron 子进程崩溃失败', error));
  });
  const updateManager = new LinkUpdateManager(
    buildVersion,
    app.isPackaged,
    (status) => sendToRenderer('link:update-status', status),
    { playbackActive: () => runtimeActive || nativePlaybackActive(), license: () => readLicenseStatus(), releaseKeys: releasePublicKeys,
      log: (level, message) => { void logger.record({ level, category: 'system', device: '软件更新', message, result: level === 'info' ? 'succeeded' : 'failed' })
        .catch((error: unknown) => console.error('更新校验日志写入失败', error)); } }
  );
  registerIpc(profileStore, obs, processManager, logger, integrationDetector, updateManager);
  // Every 10 minutes the log gets each process's memory, CPU and handle count, so a long show can be followed afterwards.
  new ResourceMonitor({
    metrics: () => app.getAppMetrics(),
    extra: () => { const pid = nativePlayer?.status?.enginePid; return pid ? [{ pid, label: '播放引擎' }] : []; },
    handles: async pids => process.platform !== 'win32' ? new Map()
      : new Map((await readProcessIdentities(identityHelper, pids.slice(0, 64))).map(identity => [identity.pid, 'error' in identity ? null : identity.handleCount])),
    record: entry => logger.record(entry)
  }).start();
  void midiHealth.check().then((result) => logger.record({
    level: result === 'ready' ? 'info' : 'error', category: 'device', device: 'MIDI',
    message: midiHealthMessage(result), details: { result }
  })).catch((error: unknown) => console.error('MIDI 检测日志写入失败', error));
  handle('link:midi-recheck', async () => {
    const result = await midiHealth.check(true);
    await logger.record({ level: result === 'ready' ? 'info' : 'error', category: 'device', device: 'MIDI', message: midiHealthMessage(result), details: { result } });
    if (result !== 'ready') throw new Error(midiHealthMessage(result));
  });
  createMainWindow(obs, logger);
  // One check after startup settles; it only reports a new version, the operator downloads it.
  setTimeout(() => {
    if (quitFlowRunning || allowWindowClose) return;
    void updateManager.check('background').then(status => {
      if (status.phase === 'disabled' || status.phase === 'notConfigured') return;
      return logger.record({ level: status.phase === 'idle' ? 'warning' : 'info', category: 'system', device: '软件更新',
        message: status.installBlockedReason ? `${status.message}；${status.installBlockedReason}` : status.message,
        details: { currentVersion: status.currentVersion, availableVersion: status.availableVersion, releaseDate: status.releaseDate } });
    }).catch((error: unknown) => console.error('启动更新检查日志写入失败', error));
  }, 10_000);
  restoreMainWindow = () => {
    if (mainWindow || quitFlowRunning) return;
    allowWindowClose = false;
    createMainWindow(obs, logger);
  };

  // OBS connection changes are logged here, whether or not a window is open.
  let obsStatus = obs.getSnapshot().status;
  obs.subscribe((snapshot) => {
    sendToRenderer('link:obs-status', snapshot);
    const entry = obsStatusLogEntry(obsStatus, snapshot);
    obsStatus = snapshot.status;
    if (entry) void logger.record({ ...entry, category: 'device', device: 'obs' }).catch((error: unknown) => console.error('OBS 连接状态日志未能保存', error));
  });
  obs.subscribeInventoryChanges(() => sendToRenderer('link:obs-inventory-changed', null));
  processManager.subscribe((snapshot) => sendToRenderer('link:process-status', snapshot));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) restoreMainWindow?.();
  });
  app.on('window-all-closed', () => {
    recordQuitStep('所有窗口已关闭');
    if (process.platform !== 'darwin' && (allowWindowClose || !quitFlowRunning)) app.quit();
  });
  runQuit = async (reason, finish) => {
    if (quitFlowRunning) { recordQuitStep('退出流程进行中，忽略重复请求', { reason }); return false; }
    if (runtimeActive || nativePlaybackActive()) {
      showRuntimeActiveExitWarning();
      return false;
    }
    quitFlowRunning = true;
    try {
      const decision = await unsavedChanges.resolve(reason);
      recordQuitStep('未保存修改已处理', { decision, reason });
      if (decision === 'cancelled') return false;
      discardOnQuit = decision === 'discarded';
      await obs.sources.discardPending();
      return await runQuitFlow(profileStore, processManager, finish);
    } finally {
      quitFlowRunning = false;
      // A cancelled quit keeps the edits, and their recovery copy, as they are.
      if (!allowWindowClose) discardOnQuit = false;
      if (allowWindowClose && BrowserWindow.getAllWindows().length === 0) app.quit();
    }
  };
  requestQuit = () => {
    void runQuit('quit', () => app.quit()).catch((error: unknown) => {
      recordQuitStep('退出流程失败', { error: error instanceof Error ? error.message : String(error) });
      dialog.showErrorBox('退出流程失败', error instanceof Error ? error.message : String(error));
    });
  };
  app.on('before-quit', (event) => {
    recordQuitStep('收到退出请求');
    if (allowWindowClose) return;
    event.preventDefault();
    requestQuit();
  });
}

function createMainWindow(obs: ObsWebSocketAdapter, logger: LinkRunLogger): void {
  const icon = process.platform === 'win32' ? join(__dirname, '../../build/icon.ico') : undefined;
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    title: `团播联动台 / Tuanbo Link Console · ${process.pid}`,
    backgroundColor: '#14171e',
    ...(process.platform === 'win32' ? { backgroundMaterial: 'none' as const } : {}),
    frame: false,
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isProductWebsiteUrl(url)) void shell.openExternal(url).catch((error: unknown) => {
      const message = `无法打开官网，请检查默认浏览器后重试。${error instanceof Error ? error.message : String(error)}`;
      dialog.showErrorBox('打开官网失败', message);
      void logger.record({ level: 'error', category: 'device', device: '官网', message, result: 'failed' })
        .catch((failure: unknown) => console.error('记录官网打开失败', failure));
    });
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  const window = mainWindow;
  let rendererReloadedAt = 0;
  // A new page holds none of the MIDI ports the previous one opened.
  mainWindow.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) void midiPorts?.releaseWindow();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void midiPorts?.releaseWindow();
    // Nothing can be saved from a window that exited: the recovery copy holds the
    // edits and is offered when the project opens again, so quitting does not ask.
    rendererSaves.failAll('界面已退出，无法保存。未保存的修改已存进恢复副本，下次打开工程时可以恢复');
    if (documentState.dirty) recordQuitStep('界面已退出，未保存的修改以恢复副本为准');
    documentState = { ...documentState, dirty: false, consoleSynced: false };
    // A program that is playing runs in main and keeps its audio, timecode, OBS and
    // lighting outputs; the reloaded window takes it over. Anything else stops.
    void (nativeProgram?.release() ?? Promise.resolve(null)).then(async kept => {
      if (kept) {
        await logger.record({ level: 'warning', category: 'state', device: '播放器', ...(kept.itemId ? { itemId: kept.itemId } : {}),
          message: `界面已退出，节目在后台继续播放（${Math.floor(kept.positionMs / 1000)} 秒），界面重新加载后会接回控制` });
        return;
      }
      await closeNativePlayer(); await releaseRendererRuntime();
    }).catch((error: unknown) => {
      void logger.record({ level: 'error', category: 'device', device: '音频', message: `界面退出后停止音频失败：${String(error)}`, result: 'failed' })
        .catch((loggingError: unknown) => console.error('记录音频停止失败', loggingError));
    });
    void logger.record({ level: 'error', category: 'device', device: 'Electron',
      message: `界面进程意外退出：${details.reason}，退出码 ${details.exitCode}。崩溃记录在：${app.getPath('crashDumps')}`,
      result: 'failed' }).catch((error: unknown) => console.error('记录 Electron 界面崩溃失败', error));
    if (quitFlowRunning || details.reason === 'clean-exit' || window.isDestroyed()) return;
    // Reload once automatically. Another exit within a minute waits for the
    // operator, so a page that keeps failing cannot reload in a loop.
    if (Date.now() - rendererReloadedAt > 60_000) { rendererReloadedAt = Date.now(); window.webContents.reload(); return; }
    void dialog.showMessageBox(window, { type: 'error', title: '界面又退出了', noLink: true, defaultId: 0, cancelId: 1,
      message: '界面重新加载后不到一分钟又退出了，已停止自动重新加载。', buttons: ['重新加载界面', '暂不加载'] })
      .then(({ response }) => { if (response === 0 && !window.isDestroyed()) { rendererReloadedAt = Date.now(); window.webContents.reload(); } })
      .catch((error: unknown) => console.error('界面重新加载询问失败', error));
  });
  mainWindow.on('unresponsive', () => {
    rendererSaves.failAll('界面没有响应，这次没有保存。未保存的修改已存进恢复副本');
    void logger.record({ level: 'error', category: 'system', message: '界面无响应', result: 'failed' })
      .catch((error: unknown) => console.error('记录界面无响应失败', error));
  });
  mainWindow.on('responsive', () => {
    void logger.record({ level: 'info', category: 'system', message: '界面已恢复响应', result: 'succeeded' })
      .catch((error: unknown) => console.error('记录界面恢复失败', error));
  });
  const notifyVisibility = (): void => sendToRenderer('link:window-visible', Boolean(mainWindow?.isVisible() && !mainWindow.isMinimized()));
  mainWindow.on('minimize', notifyVisibility);
  mainWindow.on('restore', notifyVisibility);
  mainWindow.on('hide', notifyVisibility);
  mainWindow.on('show', notifyVisibility);
  // OBS matches native window titles. Keep this instance distinct across reloads.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.alt || input.control || input.meta || input.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      if (runtimeActive) {
        dialog.showMessageBoxSync(mainWindow!, {
          type: 'info', title: '刷新开发界面',
          message: '停止播放后再按 Alt+R 刷新。',
          buttons: ['知道了'], noLink: true
        });
        return;
      }
      void unsavedChanges.resolve('reload').then(async decision => {
        if (decision === 'cancelled') return;
        if (decision === 'discarded') await discardOpenDocumentRecovery();
        await obs.sources.discardPending();
        mainWindow?.webContents.reload();
      }).catch((error: unknown) => dialog.showErrorBox('刷新失败', error instanceof Error ? error.message : String(error)));
    });
  }

  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    // Chromium requires the audio-device visibility check to enumerate output
    // endpoints. Actual capture requests remain denied below.
    return permission === 'media' && details.mediaType === 'audio';
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Web MIDI stays denied: Chromium opens every MIDI port on the computer for as long as the page
    // uses MIDI, so single-client USB interfaces refused the playback engine and P1 (0.5.2, error 7).
    // The window's MIDI goes through main instead (link:midi-*), one port at a time.
    callback(permission === 'speaker-selection');
  });
  mainWindow.on('close', (event) => {
    recordQuitStep('窗口关闭请求');
    if (allowWindowClose) return;
    event.preventDefault();
    requestQuit();
  });
  mainWindow.on('closed', () => {
    rendererSaves.failAll('界面已关闭，无法保存。未保存的修改已存进恢复副本，下次打开工程时可以恢复');
    mainWindow = null;
  });

  const renderer = rendererSource(app.isPackaged, process.env.ELECTRON_RENDERER_URL);
  if (renderer.kind === 'url') void mainWindow.loadURL(renderer.url);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(
  profileStore: SecureProfileStore,
  obs: ObsWebSocketAdapter,
  processManager: ExternalProcessManager,
  logger: LinkRunLogger,
  integrationDetector: WindowsIntegrationDetector,
  updateManager: LinkUpdateManager
): void {
  const projectAccess = new ProjectAccess(join(app.getPath('userData'), 'link-integrations', 'last-project.json'));
  registerAssetProtocol(projectAccess);
  const assetRelinkRequests = new AssetRelinkRequests({ projects: projectService, access: projectAccess });
  // Absolute paths the window may hand back: files the operator dropped, picked or chose in a
  // dialog, and programs a dialog or the detection found. Kept apart so a dropped file is no program.
  const chosenFiles = new ChosenPaths('这个文件不是通过联动台选择或拖入的');
  const chosenPrograms = new ChosenPaths('这个程序位置不是通过联动台选择或一键识别得到的');
  const chosenFolders = new ChosenPaths('这个启动文件夹不是通过联动台选择的');
  // The preload reports the path of each real File the operator dropped or picked; a window cannot
  // send this message itself, and a File it makes up has no path.
  ipcMain.removeAllListeners('link:file-chosen');
  ipcMain.on('link:file-chosen', (event, pathValue: unknown) => {
    const path = z.string().min(1).max(32_768).safeParse(pathValue);
    if (mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && path.success) { chosenFiles.choose(path.data); return; }
    void logger.record({ level: 'warning', category: 'system', message: '拒绝来源不明的文件选择记录' }).catch((error: unknown) => console.error('文件选择记录日志未能保存', error));
  });
  /** Recovery copies are named by a project the main process approved, or by none (unnamed). */
  const requireApprovedOrUnnamed = (projectPath: string | null): void => { if (projectPath !== null) projectAccess.requireApproved(projectPath); };
  /** A window's playback request names the song or media files of the project it shows. */
  const checkObsFiles = async (request: NativeObsPrepare): Promise<void> => {
    await projectAccess.assetFiles(request.projectPath, [request.snapshot, request.nextFiles?.snapshot].flatMap(snapshot => snapshot
      ? [...snapshot.assets.map(asset => asset.relativePath), ...snapshot.item.referenceAudio ? [snapshot.item.referenceAudio.relativePath] : []] : []));
  };
  const nativeSeek = new ObsNativeSeek();
  const programObsListeners = new Set<(status: import('@tb/schema').NativeObsStatus) => void>();
  // Advisories and repeated warnings already recorded in this run, so each is a warning only once (firstTimeWarning).
  const seenNotices = new Set<string>();
  const obsPreload = new NativeObsPreloadPool({
    authorize: async request => {
      await authorizeProduct('link:native-obs-prepare', request);
      if (nativePlaybackActive() || nativeObs?.busy) throw new Error('正在播放时不能准备另一个节目');
      await nativeObs?.stop();
      if (nativePlaybackActive()) throw new Error('音频已经在准备了，不能再单独准备节目');
    },
    create: (request, positionMs) => createNativeObsOutputs(request, { obs, projects: projectService, media: mediaPreviewService,
      profiles: profileStore, seek: nativeSeek, logger, seenNotices,
      logFailure: error => {
        if (nativeObs?.status?.sessionId === request.sessionId) nativeObs.disconnect(error.message);
        else console.error('已结束画面会话的运行日志未能落盘', error);
      },
      audioIdentity: () => { if (!nativePlayer) throw new Error('音频还没准备好'); return nativePlayer.audioCaptureIdentity; } }, positionMs),
    // Logged once and shown in red on the song playing; nativeObs is set just below, before any preparation runs.
    report: message => nativeObs?.report(message)
  });
  nativeObsPreload = obsPreload;
  nativeObs = new NativeObsHost({
    audio: () => nativePlayer?.status ?? null,
    outputs: (request, positionMs, assertCurrent) => obsPreload.take(request, positionMs, assertCurrent),
    prepareNextFiles: async (request, assertCurrent) => {
      if (!request.nextFiles) return;
      const started = performance.now();
      await prepareNextObsFiles(request, { projects: projectService, media: mediaPreviewService }, assertCurrent);
      assertCurrent();
      const decoderPrepared = await obs.preparePlaybackMedia(() => obsPreload.prepareNext(request, assertCurrent));
      await logger.record({ level: 'info', category: 'preflight', device: '后台画面', projectId: request.snapshot.projectId,
        itemId: request.nextFiles.snapshot.item.id, message: decoderPrepared ? '下一个节目的画面已准备好' : '下一个节目的文件已准备好，共用的来源等当前节目结束后交接', result: 'succeeded',
        details: { elapsedMs: performance.now() - started, decoderPrepared } });
    },
    changed: status => { sendToRenderer('link:native-obs-status', status); for (const listener of programObsListeners) listener(status); },
    error: message => { void logger.record({ level: 'error', category: 'device', device: '后台画面', message, result: 'failed',
      details: { requests: obs.getRequestDiagnostics() } })
      .catch((error: unknown) => console.error('后台画面日志写入失败', error)); }
  });
  const obsRequests = new NativeObsRequests(nativeObs, value => authorizeProduct('link:native-obs-prepare', value));
  handle('link:native-obs-preload', (_event, value: unknown) => obsPreload.preload(value, checkObsFiles), 'listener');
  handle('link:native-obs-preload-cancel', (_event, value: import('@tb/schema').NativeObsStop) => obsPreload.cancel(value));
  handle('link:native-obs-prepare', (_event, value: unknown) => obsRequests.prepare(value, checkObsFiles), 'listener');
  handle('link:native-obs-stop', (_event, value: unknown) => obsRequests.stop(value));
  handle('link:native-obs-status', () => nativeObs?.status ?? null);
  // Recovery rule B when the operator reconnects OBS during a song: playing rebuilds
  // the picture at the current position; paused prepares the song again in place.
  const recoverNativeObs = async (): Promise<void> => {
    const picture = nativeObs?.status?.state, program = nativeProgramHost?.controller, positionMs = nativePlayer?.status?.positionMs;
    if (picture === 'running') { await nativeObs!.reconnected(); return; }
    if (picture !== 'paused' || !program || positionMs === undefined) return;
    await program.seek(positionMs);
    const message = 'OBS 已重新连接，画面已按暂停位置恢复';
    program.reportFault(message);
    await logger.record({ level: 'warning', category: 'device', device: '后台画面', message });
  };
  let obsConnected = obs.getSnapshot().status === 'connected';
  obs.subscribe(state => {
    const reconnected = state.status === 'connected' && !obsConnected;
    obsConnected = state.status === 'connected';
    if (reconnected) void recoverNativeObs().catch((error: unknown) => { void logger.record({ level: 'error', category: 'device', device: '后台画面',
      message: `OBS 已重新连接，但画面恢复失败：${String(error)}`, result: 'failed' }).catch((failure: unknown) => console.error('画面恢复日志写入失败', failure)); });
    if (state.status === 'connected') return;
    nativeObs?.disconnect(state.error || 'OBS 已断开');
    void obsPreload.close().catch((error: unknown) => { void logger.record({ level: 'error', category: 'device', device: '后台画面', message: `关闭节目准备失败：${String(error)}`, result: 'failed' })
      .catch((failure: unknown) => console.error('节目预备清理日志写入失败', failure)); });
  });
  const engineExecutable = app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe')
    : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe');
  const midiPortQuery = new NativeDeviceQuery(engineExecutable);
  const midiPortBroker = new MidiPortBroker({
    authorize: () => authorizeOutput(),
    list: async recheck => {
      const result = await midiHealth.check(recheck);
      if (result !== 'ready') throw new Error(midiHealthMessage(result));
      if (recheck) await midiPortQuery.reopenForPreparation();
      return midiPortQuery.read();
    },
    // The editor previews send a whole lighting state at once.
    createOutput: failed => new NativeMidiOutput(engineExecutable, failed, 256),
    createInput: (receive, failed, invalid) => new NativeMidiInput(engineExecutable, receive, failed, invalid),
    emit: event => sendToRenderer('link:midi-event', event),
    log: (level, message) => { void logger.record({ level, category: 'device', device: 'MIDI', message, result: level === 'info' ? 'succeeded' : 'failed' })
      .catch((error: unknown) => console.error('MIDI 日志写入失败', error)); }
  });
  midiPorts = midiPortBroker;
  handle('link:midi-ports', (_event, value: unknown) => midiPortBroker.listPorts(midiPortListRequestSchema.parse(value).recheck));
  // Opening checks the license itself; sending and closing need a port it opened.
  handle('link:midi-open', async (_event, value: unknown) => {
    const request = midiPortOpenSchema.parse(value);
    return { version: 1 as const, handle: await midiPortBroker.open(request.direction, request.portName) };
  }, 'listener');
  // Messages go out in the order they arrive: nothing is awaited before the broker queues one.
  handle('link:midi-send', (_event, value: unknown) => { const request = midiPortSendSchema.parse(value); return midiPortBroker.send(request.handle, request.bytes); }, 'listener');
  handle('link:midi-close', (_event, value: unknown) => midiPortBroker.close(midiPortHandleSchema.parse(value).handle), 'listener');
  const player = (): NativePlayerService => {
    if (nativePlayerShutdown) throw new Error('音频引擎正在关闭或关闭失败，请查看运行日志');
    if (!nativePlayer) {
      if (!ffmpegPath) throw new Error('FFmpeg 音频解码组件未安装');
      let lastClockBoundary = '', lastReadyBoundary = '';
      // Each preparation's steps go into one 正式音频准备完成 entry; only a slow step is recorded as it happens.
      const audioSteps = new PreparationSteps((step, ms) => {
        void logger.record({ level: 'info', category: 'system', device: '音频', message: `音频准备较慢：${step} 用了 ${(ms / 1000).toFixed(1)} 秒`, details: { ms: Math.round(ms) } })
          .catch((error: unknown) => console.error('正式音频计时日志写入失败', error));
      });
      const measured = (phase: string, elapsedMs: number): void => audioSteps.add(phase, elapsedMs);
      nativePlayer = new NativePlayerService({
        checkDeviceHealth: async (recheck) => {
          const result = await midiHealth.check(recheck);
          if (result !== 'ready') throw new Error(midiHealthMessage(result));
        },
        executable: engineExecutable,
        claimMidiOutput: name => midiPortBroker.claimFormal(name, '时间码'),
        cache: new NativeAudioCache(join(app.getPath('userData'), 'native-audio-streams'), ffmpegPath.replace('app.asar', 'app.asar.unpacked'), undefined, undefined, measured),
        resolveAudio: (projectPath, relativePath) => projectService.resolveReferenceAudio(projectPath, relativePath),
        changed: (status, qpc100ns) => {
          nativeObs?.observe(status, qpc100ns); nativeProgramHost?.observe(status, qpc100ns); nativePlayerUi.publish(status);
          const readyBoundary = `${status.sessionId}:${status.generation}`;
          if (status.status === 'ready' && readyBoundary !== lastReadyBoundary) {
            lastReadyBoundary = readyBoundary;
            const steps = audioSteps.take();
            void logger.record({ level: 'info', category: 'system', device: '音频', itemId: status.itemId, message: '音频已准备好',
              details: { playbackSessionId: status.sessionId, generation: status.generation, totalMs: steps.reduce((sum, step) => sum + step.ms, 0), steps } })
              .catch((error: unknown) => console.error('正式音频准备日志写入失败', error));
          }
          if (qpc100ns && qpc100ns !== '0' && (status.status === 'playing' || status.status === 'ended')) {
            const boundary = `${status.sessionId}:${status.generation}:${status.status}`;
            if (boundary !== lastClockBoundary) {
              lastClockBoundary = boundary;
              void logger.record({ level: 'info', category: 'state', device: '音频', itemId: status.itemId,
                message: status.status === 'playing' ? '声卡已开始输出' : '声卡已播到曲尾',
                details: { playbackSessionId: status.sessionId, generation: status.generation, positionMs: status.positionMs, qpc100ns, enginePid: status.enginePid } })
                .catch((error: unknown) => console.error('正式音频边界日志写入失败', error));
            }
          }
        },
        beforeControl: request => {
          nativeObs?.interrupt(request); nativeProgramHost?.interrupt(request);
          if (request.kind === 'stop' || request.kind === 'seek') void obsPreload.cancelNext(request.sessionId)
            .catch((error: unknown) => { void logger.record({ level: 'error', category: 'device', device: '后台画面',
              message: `清理下一个节目的准备失败：${String(error)}`, result: 'failed' })
              .catch((failure: unknown) => console.error('节目预备清理日志写入失败', failure)); });
        },
        measured,
        // A failed preparation keeps the steps it got through.
        error: message => { const steps = audioSteps.take(); void logger.record({ level: 'error', category: 'device', device: '音频', message, result: 'failed', ...(steps.length ? { details: { steps } } : {}) })
          .catch((error: unknown) => console.error('正式音频日志写入失败', error)); },
        // Not the failure of the song being prepared: its steps stay for its 音频已准备好 entry.
        preloadCleanupError: message => { void logger.record({ level: 'error', category: 'device', device: '音频', message, result: 'failed' })
          .catch((error: unknown) => console.error('正式音频日志写入失败', error)); },
        recovered: report => { void logger.record({ level: 'warning', category: 'device', device: '音频', ...(nativePlayer?.status ? { itemId: nativePlayer.status.itemId } : {}),
          message: `时间码中断 ${(report.durationMs / 1000).toFixed(1)} 秒后已恢复（${report.portName}）：从当前播放位置继续发送，中断期间的时间码不补发`,
          result: 'succeeded', details: report }).catch((error: unknown) => console.error('正式音频日志写入失败', error)); }
      });
    }
    return nativePlayer;
  };
  handle('link:native-player-devices', (_event, value: unknown) => player().devices(nativeDeviceQueryRequestSchema.parse(value).scope));
  const midiCheck = new NativeMidiCheckService(engineExecutable, () => runtimeActive || nativePlaybackActive(), undefined,
    name => midiPortBroker.claimFormal(name, '接口检查'));
  handle('link:native-midi-check', async (_event, value: import('@tb/schema').NativeMidiCheck) => {
    try {
      await midiCheck.check(value);
      await logger.record({ level: 'info', category: 'device', device: 'midi', message: `已试开并释放 Windows MIDI 接口：${value.portName}（没有发送时间码）`, result: 'succeeded' });
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'midi', message: error instanceof Error ? error.message : String(error), result: 'failed' });
      throw error;
    }
  });
  handle('link:native-player-status', () => nativePlayer?.status ?? null);
  const playbackRequests = new NativePlaybackRequests(player, (channel, value) => authorizeProduct(channel, value));
  handle('link:native-player-prepare', (_event, value: unknown) => playbackRequests.prepare(value, async request => {
    await projectAccess.assetFiles(request.projectPath, [request.snapshot, request.nextSnapshot].flatMap(snapshot => snapshot ? [snapshot.audio.relativePath] : []));
  }), 'listener');
  handle('link:native-player-control', (_event, value: unknown) => playbackRequests.control(value), 'listener');
  const enforcement = z.literal('required').parse(licenseConfig.enforcement);
  const localTestAccess = __TBLINK_LOCAL_TEST_ACCESS__ && localTestAccessEnabled(app.isPackaged,
    process.env.TBLINK_LOCAL_TEST_ACCESS, existsSync(join(app.getAppPath(), '.local-test-access')));
  const readMachineCode = createLicenseMachineCodeReader();
  const getLocalTestStatus = async () => localTestLicenseStatus(await readMachineCode());
  let licenseService: Promise<LicenseService> | undefined;
  const getLicenseService = (): Promise<LicenseService> => {
    licenseService ??= readMachineCode().then(async machineCode => {
      const service = new LicenseService(app.getPath('userData'), machineCode, licensePublicKeys, Date.now, {
        serverUrl: licenseConfig.serverUrl, enforcement, credentials: profileStore
      });
      const status = await service.status();
      await logger.record({ level: status.state === 'active' ? 'info' : 'error', category: 'system', device: '授权',
        message: `启动授权校验：${licenseStateLabel[status.state]}，${status.message}`, result: status.state === 'active' ? 'succeeded' : 'failed',
        details: licenseLogDetails(status) });
      return service;
    });
    return licenseService;
  };
  const getLicenseStatus = async () => localTestAccess ? getLocalTestStatus() : (await getLicenseService()).status();
  handle('link:license-status', getLicenseStatus);
  readLicenseStatus = getLicenseStatus;
  let licenseChanging = false;
  const licenseAccess = new LicenseAccess(getLicenseStatus);
  const licenseGate: LicenseGate = { access: licenseAccess, changing: () => licenseChanging };
  releaseRendererRuntime = async () => {
    // Only release close protection after every owned output acknowledged stop.
    await licenseAccess.setActive(false);
    runtimeActive = false;
  };
  authorizeOutput = async () => {
    if (licenseChanging) throw new Error('授权操作还没完成，请稍后再试');
    await licenseAccess.requireOutput();
    if (licenseChanging) throw new Error('正在更换授权，请完成后再试');
  };
  authorizeProduct = (channel, value) => authorizeRequest(licenseGate, channel, value);
  handle('link:license-require-output', () => authorizeOutput());
  const changeOnlineLicense = async (code?: string) => {
    if (runtimeActive || licenseChanging) throw new Error('请先停止播放，并等上一个授权操作完成');
    licenseChanging = true;
    const action = code === undefined ? '联网验证授权' : '输入激活码激活';
    try {
      const service = await getLicenseService();
      const result = code === undefined ? await service.refreshOnline() : await service.activateCode(code);
      await logger.record({ level: 'info', category: 'system', device: '授权', message: `${action}成功：${result.message}`, result: 'succeeded', details: licenseLogDetails(result) });
      return result;
    } catch (error) {
      // The reason names the cause (network, rejection, clock); it never contains the activation code.
      await logger.record({ level: 'error', category: 'system', device: '授权', message: `${action}失败：${error instanceof Error ? error.message : String(error)}`, result: 'failed' });
      throw error;
    } finally { licenseChanging = false; }
  };
  handle('link:license-activate-code', (_event, value: unknown) => changeOnlineLicense(z.string().max(64).parse(value)));
  handle('link:license-refresh-online', () => changeOnlineLicense());
  const purchases = new PurchaseService(licenseConfig.serverUrl, profileStore, url => shell.openExternal(url), fetch, Date.now,
    async id => (await getLicenseService()).renewalAuthorization(id));
  handle('link:purchase-catalog', () => purchases.catalog());
  handle('link:purchase-list', () => purchases.list());
  handle('link:purchase-create', (_event, value: unknown) => purchases.create(value));
  handle('link:purchase-refresh', (_event, value: unknown) => purchases.refresh(z.string().uuid().parse(value)));
  handle('link:purchase-open-payment', (_event, value: unknown) => purchases.openPayment(z.string().uuid().parse(value)));
  handle('link:purchase-copy-code', async (_event, localId: unknown, licenseId: unknown) => {
    clipboard.writeText(await purchases.code(z.string().uuid().parse(localId), z.string().uuid().parse(licenseId)));
  });
  handle('link:license-export-request', async () => {
    const status = await (await getLicenseService()).status();
    const result = await dialog.showSaveDialog(mainWindow!, { title: '导出本机授权申请', defaultPath: '团播联动台-授权申请.json', filters: [{ name: '授权申请', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFileAtomically(result.filePath, JSON.stringify(licenseRequestSchema.parse({ version: 1, product: 'tuanbo-link-console', machineCode: status.machineCode }), null, 2));
    return true;
  });
  handle('link:license-import', async () => {
    if (runtimeActive || licenseChanging) throw new Error('请先停止播放，并等授权操作完成后再更换授权');
    licenseChanging = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow!, { title: '导入本机授权', properties: ['openFile'], filters: [{ name: '团播联动台授权', extensions: ['tbllicense'] }] });
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      if ((await stat(file)).size > 16384) throw new Error('授权文件太大，请确认选的是正确的文件');
      const token = await readFile(file, 'utf8');
      if (runtimeActive) throw new Error('正在播放，请停止后再导入授权');
      const status = await (await getLicenseService()).activate(token);
      await logger.record({ level: 'info', category: 'system', device: '授权', message: '已导入本机授权', result: 'succeeded', details: licenseLogDetails(status) });
      return status;
    } finally { licenseChanging = false; }
  });
  // The local onPC data directory comes only from the folder dialog or the detection below.
  const ma2DataDirectory = new Ma2DataDirectory(join(app.getPath('userData'), 'link-integrations', 'ma2-data-directory.json'));
  const ma2Connections = new Ma2Connections(() => runtimeActive, directory => ma2DataDirectory.require(directory));
  const recordMa2DataDirectory = async (directory: string, how: string): Promise<string> => {
    await ma2DataDirectory.choose(directory);
    await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: `已${how}本机 onPC 数据目录：${directory}`, result: 'succeeded' });
    return directory;
  };
  handle('link:ma2-data-directory', () => ma2DataDirectory.current());
  handle('link:pick-ma2-data-directory', async () => {
    const selected = await dialog.showOpenDialog(mainWindow!, { title: '选择 MA2 onPC 数据目录', properties: ['openDirectory'] });
    const directory = selected.filePaths[0];
    if (selected.canceled || !directory) return null;
    return recordMa2DataDirectory(directory, '选择');
  });
  handle('link:detect-ma2-data-directory', async () => {
    const programData = process.env.ProgramData;
    if (!programData) throw new Error('无法读取 ProgramData 位置，请点“选择”手动指定 onPC 数据目录');
    const onpc = (await integrationDetector.detect()).applications.ma2;
    // gma2onpc.exe carries no file version; the installer names its folder "grandMA2 onPC 3.3.4.3".
    const version = onpc?.version ?? (onpc?.executablePath ? /grandma2 onpc (\d+\.\d+\.\d+(?:\.\d+)?)[\\/]/i.exec(onpc.executablePath)?.[1] ?? null : null);
    return recordMa2DataDirectory(await detectMa2DataDirectory(join(programData, 'MA Lighting Technologies', 'grandma'), version), '识别');
  });
  const loopMidiService = new LoopMidiService();
  // Changing a Windows adapter needs the operator's answer to the main process's own dialog.
  const ma2NetworkSetup = new Ma2NetworkSetup(join(app.getPath('userData'), 'ma2-network-addresses.json'), async change => {
    const { response } = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: '修改网卡地址', noLink: true, buttons: ['确认修改', '取消'], defaultId: 1, cancelId: 1,
      message: change.action === 'add' ? `为网卡「${change.adapterName}」增加地址 ${change.address}/${change.prefix}？` : `从网卡「${change.adapterName}」移除联动台添加的地址 ${change.address}/${change.prefix}？`,
      detail: `用于连接控台 ${change.host}。网卡：${change.adapterDescription}。Windows 可能还会请求管理员确认。` });
    return response === 0;
  });
  const ma2Network = new Ma2NetworkManager(app.getPath('userData'), profileStore, () => runtimeActive || nativePlaybackActive(), ma2PluginLua, host => ma2NetworkSetup.connectionAddress(host), async (host, peers) => {
    if (!isLocalMa2Address(host)) return;
    const profile = await profileStore.loadProfile();
    if (!profile?.ma2) return;
    const selected = await processManager.refresh('ma2', processConfiguration(profile, 'ma2'));
    if (selected.pid === null) throw new Error('选择的 MA2 onPC 还没运行，请先点“一键连接”');
    await assertMa2ConnectionOwner(selected.pid, peers);
  }, async (host, port) => {
    if (!isLocalMa2Address(host)) return;
    const profile = await profileStore.loadProfile();
    if (!profile?.ma2) return;
    const selected = await processManager.refresh('ma2', processConfiguration(profile, 'ma2'));
    if (selected.pid === null) throw new Error(`本机 MA2 onPC 没有运行，没有尝试登录 ${host}:${port}。请先点“一键连接”启动 onPC，或在 MA2 设置里检查控台地址。`);
    const started = performance.now();
    const outcome = await waitForMa2Listener(selected.pid, port, profile.ma2.startupTimeoutMs);
    if (outcome === 'waited') await logger.record({ level: 'info', category: 'device', device: 'MA2', result: 'succeeded',
      message: `MA2 onPC 远程端口 ${port} 已就绪`, details: { pid: selected.pid, waitedMs: Math.round(performance.now() - started) } });
  }, (level, message) => {
    void logger.record({ level, category: 'device', device: 'MA2', message }).catch((error: unknown) => console.error('MA2 连接提示日志未能保存', error));
  });
  const ma2Reads = new Map<string, { senderId: number; controller: AbortController }>();
  ma2Network.setCueDeletionProjectReader(path => projectService.open(path));
  const ma2ConsoleBackups = new Ma2ConsoleBackups(join(app.getPath('userData'), 'link-integrations', 'ma2-console-backups.json'), () => runtimeActive || nativePlaybackActive(),
    message => logger.record({ level: 'warning', category: 'device', device: 'MA2', message, result: 'failed' }));
  ma2Network.setConsoleBackups(ma2ConsoleBackups);
  const ma2ConsoleKey = (request: { dataDirectory: string; network?: import('@tb/schema').Ma2NetworkTarget | undefined }): string => request.network ? `${request.network.host}:${request.network.port}` : `onPC ${request.dataDirectory}`;
  const beginMa2Read = (event: IpcMainInvokeEvent, id?: string): { signal: AbortSignal; report: ((progress: Ma2ReadProgressUpdate) => void) | undefined; finish: () => void } => {
    if (id && ma2Reads.has(id)) throw new Error('读取任务编号重复');
    const controller = new AbortController();
    if (id) ma2Reads.set(id, { senderId: event.sender.id, controller });
    return { signal: controller.signal,
      report: id ? progress => { if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send('link:ma2-read-progress', ma2ReadProgressSchema.parse({ id, ...progress })); } : undefined,
      finish: () => { if (id) ma2Reads.delete(id); }
    };
  };
  handle('link:ma2-read-cancel', (event, value: unknown) => {
    const id = z.string().uuid().parse(value);
    const read = ma2Reads.get(id);
    if (read?.senderId === event.sender.id) read.controller.abort();
  });
  const ma2Discovery = new Ma2DiscoveryService();
  handle('link:ma2-network-setup-state', () => ma2NetworkSetup.state());
  handle('link:ma2-network-setup-plan', (_event, value: unknown) => ma2NetworkSetup.plan(ma2NetworkSetupRequestSchema.parse(value)));
  handle('link:ma2-network-setup-apply', async (_event, value: unknown) => { if (runtimeActive) throw new Error('请停止播放后配置网卡'); await ma2NetworkReady; ma2Network.disconnect(); return ma2NetworkSetup.apply(z.string().uuid().parse(value)); });
  handle('link:ma2-network-setup-restore', async (_event, value: unknown) => { if (runtimeActive) throw new Error('请停止播放后恢复网卡'); await ma2NetworkReady; ma2Network.disconnect(); return ma2NetworkSetup.restore(z.string().uuid().parse(value)); });
  app.once('will-quit', () => ma2Discovery.cancel());
  handle('link:ma2-discover', async () => {
    await ma2NetworkReady; if (runtimeActive) throw new Error('请停止播放后搜索控台');
    const result = await ma2Discovery.search(ma2Network.status().profiles ?? []);
    await logger.record({ level: result.hosts.some(host => host.identity === 'ma2') ? 'info' : 'warning', category: 'device', device: 'MA2', message: `自动发现完成：找到 ${result.hosts.filter(host => host.identity === 'ma2').length} 台控台，另有 ${result.hosts.filter(host => host.identity === 'candidate').length} 个地址需要确认`, details: { hosts: result.hosts, ranges: result.ranges, warnings: result.warnings } });
    return result;
  });
  handle('link:ma2-discovery-cancel', () => ma2Discovery.cancel());
  handle('link:ma2-capabilities', async () => { await ma2NetworkReady; return ma2Network.checkCapabilities(); });
  const ma2NetworkReady = ma2Network.initialize();
  const ma2Audition=new Ma2AuditionService(ma2Network,state=>sendToRenderer('link:ma2-audition-state',state));
  ma2Network.setBeforeConnectionChange(()=>ma2Audition.beforeConnectionChange());
  stopAuditionForQuit=async()=>{
    if(!ma2Audition.status().targets.length)return;
    const result=await ma2Audition.stop();
    await logger.record({level:result.phase==='failed'?'error':'info',category:'operator',device:'MA2',message:'退出前停止本次灯光试听',details:{targets:result.targets}});
    if(result.phase==='failed')throw new Error('试听没能停止，请在灯光工作台查看没停下的目标，处理后再退出。');
  };
  handle('link:ma2-audition-play',async(_event,payload:unknown)=>{
    const request=ma2AuditionRequestSchema.parse(payload);await ma2NetworkReady;
    try{await ma2Audition.play(request);await logger.record({level:'info',category:'operator',device:'MA2',message:'灯光试听指令已发送',details:{action:request.action}});}
    catch(error){await logger.record({level:'error',category:'device',device:'MA2',message:String(error),result:'failed'});throw error;}
  });
  handle('link:ma2-audition-control',async(_event,payload:unknown)=>{
    const request=ma2AuditionControlSchema.parse(payload);
    if(request.action==='status')return ma2Audition.status();
    if(request.action==='acknowledge-closed'){
      const target=ma2Audition.status().targets.find(value=>value.id===request.targetId);
      if(!target?.connectionChanged||target.state!=='failed')throw new Error('旧连接记录已变化，请刷新后查看');
      const label=target.action.target==='sequence'?`序列 ${target.action.sequence}`:`执行器 ${target.action.executor}`;
      const answer=await dialog.showMessageBox(mainWindow!,{type:'warning',title:'确认原控台输出',message:`你已在原控台确认 ${label} 停下了吗？`,detail:`原连接：${target.network.host}:${target.network.port}。确认它已经停下后再清除记录。这个操作不会发送关灯指令。`,buttons:['取消','已确认停止，清除记录'],defaultId:0,cancelId:0,noLink:true});
      if(answer.response!==1)return ma2Audition.status();
      const result=ma2Audition.acknowledgeClosed(request.targetId);
      await logger.record({level:'warning',category:'operator',device:'MA2',message:'操作员确认原控台目标已停止，清除旧连接试听记录（未发送指令）',details:{target}});
      return result;
    }
    const result=await ma2Audition.stop();await logger.record({level:result.phase==='failed'?'error':'info',category:'operator',device:'MA2',message:result.phase==='failed'?'试听没能停止':'试听关闭指令已发送',details:{targets:result.targets}});return result;
  });
  app.once('will-quit', () => ma2Network.disconnect());
  const getMa2Connection = async (request: { dataDirectory: string; network?: import('@tb/schema').Ma2NetworkTarget | undefined }) => {
    await ma2NetworkReady;
    return request.network ? ma2Network.get(request.network) : ma2Connections.get(request.dataDirectory);
  };
  const sendMa2Cue = async (payload: unknown): Promise<void> => {
    await ma2NetworkReady;
    const request = ma2PlaybackRequestSchema.parse(payload);
    try {
      await ma2Network.playCue(request);
      await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: 'MA2 Cue 网络指令已发送', result: 'succeeded', details: { action: request.action } });
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: String(error), result: 'failed' });
      throw error;
    }
  };
  handle('link:ma2-play-cue', (_event, payload: unknown) => sendMa2Cue(payload));
  handle('link:ma2-play-cancel', (_event, sessionId: unknown) => { if (typeof sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('无效的灯光会话'); ma2Network.cancelPlayback(sessionId); });
  handle('link:ma2-network-status', async () => { await ma2NetworkReady; return ma2Network.status(); });
  handle('link:ma2-current-show', async () => { await ma2NetworkReady; return ma2Network.currentShow(); });
  // The program's lighting Off and its running state, as the license rules want them (program-license.ts).
  const programOutputs = programLicense(licenseGate, { ready: ma2NetworkReady, status: () => ma2Network.status(), send: sendMa2Cue });
  // A closed program shows nothing any more: what fails after it closed reaches the window in red.
  const reportClosedProgramFault = closedProgramFaultReporter(entry => logger.record(entry), sendToRenderer);
  nativeProgram = new NativeProgramService((project, request, callbacks) => {
    // A channel that cannot join (OBS, timecode) repeats song after song until fixed: a warning the first time, then info.
    const notice = (message: string, itemId: string | null): void => {
      void logger.record({ level: firstTimeWarning(seenNotices, message), category: 'state', device: '播放器', projectId: project.projectId,
        ...(itemId ? { itemId } : {}), message }).catch((error: unknown) => console.error('后台节目提示日志未能保存', error));
    };
    const host = new NativeProgramHost(project, request.projectPath, request.revision, {
      executable: app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe')
        : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe'),
      audio: () => nativePlayer?.status ?? null, authorize: () => authorizeOutput(), configuration: () => callbacks.configuration(),
      claimMidiOutput: (name, owner) => midiPortBroker.claimFormal(name, owner),
      midiOutputs: async () => (await player().devices('all', true)).midiOutputs,
      preciseSeeking: () => callbacks.configuration().preciseSeeking, changed: state => callbacks.changed(state),
      midiChanged: state => { if (state.state === 'running' || state.state === 'ready') callbacks.cueChanged(state.currentCueId); },
      midiRecovered: (report, itemId) => {
        void logger.record({ level: 'warning', category: 'device', device: '动作 MIDI', projectId: project.projectId, itemId,
          message: `动作 MIDI 中断 ${(report.durationMs / 1000).toFixed(1)} 秒后已恢复（${report.portName}）：从下一个动作起照常发送，中断期间跳过了 ${report.skippedActions} 个动作，不补发`,
          details: { portName: report.portName, interruptedAt: report.interruptedAt, recoveredAt: report.recoveredAt, durationMs: report.durationMs, skippedActions: report.skippedActions } })
          .catch((error: unknown) => console.error('动作 MIDI 恢复日志未能保存', error));
      },
      obsChanged: state => { if (state.state === 'running' || state.state === 'ready') callbacks.cueChanged(state.currentCueId); }, notice,
      closedFault: (message, itemId) => reportClosedProgramFault(message, { projectId: project.projectId, itemId }),
      api: {
        prepareNativePlayback: value => playbackRequests.prepare(value), controlNativePlayback: value => playbackRequests.control(value),
        getNativePlaybackDevices: scope => player().devices(scope), prepareNativeObs: value => obsRequests.prepare(value),
        stopNativeObs: value => obsRequests.stop(value), preloadNativeObs: value => obsPreload.preload(value),
        cancelNativeObsPreload: value => obsPreload.cancel(value),
        onNativeObsStatus: listener => { programObsListeners.add(listener); return () => { programObsListeners.delete(listener); }; }
      },
      network: programOutputs.network
    });
    nativeProgramHost = host;
    return { controller: host.controller, close: async () => { await host.close(); if (nativeProgramHost === host) nativeProgramHost = null; } };
  }, event => sendToRenderer('link:native-program-event', event), () => authorizeOutput(), programOutputs.runningChanged);
  // Session registration captures cancellation synchronously; output adapters
  // validate and authorize every actual audio, OBS, MIDI and lighting request.
  handle('link:native-program-open', async (_event, value: unknown) => {
    const attachment = await nativeProgram!.open(value, async (projectPath, project) => {
      await projectAccess.assetFiles(projectPath, projectFileReferences(project).map(file => file.relativePath));
    });
    if (attachment !== 'opened') await logger.record({ level: 'warning', category: 'state', device: '播放器',
      message: `重新加载的界面已接回后台播放的节目${attachment === 'outdated' ? '；界面里的工程和正在播放的版本不同，停止后会按界面里的工程重新准备' : ''}` });
    return attachment;
  }, 'listener');
  handle('link:native-program-control', (_event, value: unknown) => nativeProgram!.control(value), 'listener');
  handle('link:ma2-export-plugin', async () => {
    const selected = await dialog.showOpenDialog({ title: '选择 MA2 插件导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const directory = await mkdtemp(join(selected.filePaths[0], 'TBLINK-MA2-Bridge-'));
    try {
      for (const [name, content] of [['tblink_bridge.lua', ma2PluginLua], ['tblink_bridge.xml', ma2PluginXml], ['安装说明.md', ma2PluginInstructions]]) {
        if (!name || content === undefined) throw new Error('MA2 插件文件缺失，请重新安装联动台');
        await writeFile(join(directory, name), content, { flag: 'wx' });
      }
      await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: 'MA2 插件已导出', result: 'succeeded' });
      return directory;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `插件导出失败：${error instanceof Error ? error.message : String(error)}`, result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-network-save', async (_event, payload: unknown) => { await ma2NetworkReady; return ma2Network.save(ma2NetworkSaveSchema.parse(payload)); });
  handle('link:ma2-network-connect', async () => {
    await ma2NetworkReady;
    const result = await ma2Network.connect();
    const target = result.settings ? { host: result.settings.host, port: result.settings.port, monitorPort: result.settings.monitorPort } : null;
    await logger.record({ level: result.error ? 'error' : 'info', category: 'device', device: 'MA2', message: result.error ?? (result.state === 'connected' ? `MA2 ${result.version} 已登录（${result.settings?.host ?? '未知地址'}）` : 'MA2 连接已取消'), result: result.error ? 'failed' : result.state === 'connected' ? 'succeeded' : 'skipped',
      details: { target, ...result.unreachable ? { unreachable: true } : {} } });
    return result;
  });
  handle('link:ma2-network-disconnect', async () => { await ma2NetworkReady; return ma2Network.disconnectByOperator(); });
  handle('link:ma2-exchange', async (_event, value: unknown) => {
    const request = ma2BridgeRequestSchema.parse(value);
    return (await getMa2Connection(request)).bridge.request(request.operation, request.target, request.expected, request.desired);
  });
  handle('link:ma2-preview', async (_event, value: unknown) => {
    const request = ma2ReadRequestSchema.parse(value);
    if (request.network) { await ma2NetworkReady; return ma2Network.preview(request.network, request.target, request.timeOriginMs); }
    const snapshot = await (await getMa2Connection(request)).bridge.request('SNAPSHOT', request.target);
    return convertMa2Snapshot(snapshot, request.target, [], request.timeOriginMs);
  });
  handle('link:ma2-catalog', async (event, value: unknown) => {
    const request = ma2CatalogRequestSchema.parse(value);
    if (request.projectPath) projectAccess.requireShown(request.projectPath);
    if (runtimeActive) throw new Error('请停止播放后扫描控台');
    const task = beginMa2Read(event, request.progressId);
    try {
      await ma2NetworkReady;
      if (task.signal.aborted) throw new Error('扫描已取消');
      if (request.projectPath && (!request.projectId || (await projectService.open(request.projectPath)).projectId !== request.projectId)) throw new Error('读取进度记录和当前工程对不上');
      const recovery = request.projectPath && request.projectId ? new Ma2ReadRecovery(request.projectPath, request.projectId, request.network ? `${request.network.host}:${request.network.port}` : '本机 onPC') : undefined;
      const checkpoint = recovery?.checkpoint.bind(recovery);
      const catalog = request.network ? await ma2Network.readCatalog(request.network, task.report, task.signal, request.targets, checkpoint, request.expectedSource) : await readMa2Catalog((await getMa2Connection(request)).bridge, () => runtimeActive, undefined, task.report, task.signal, { targets: request.targets, checkpoint, expectedSource: request.expectedSource });
      for (const entry of catalog.entries) if (entry.error) await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `Timecode ${entry.target} 扫描失败：${entry.error}`, result: 'failed' });
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `已扫描 ${catalog.entries.length} 条 Timecode，其中 ${catalog.entries.filter(entry => entry.error).length} 条读取出错`, result: catalog.entries.some(entry => entry.error) ? 'failed' : 'succeeded' });
      return catalog;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `控台扫描没有完成：${error instanceof Error ? error.message : String(error)}`, result: 'failed' });
      throw error;
    } finally { task.finish(); }
  });
  handle('link:ma2-effect-library', async (event, value: unknown) => {
    const request = ma2CatalogRequestSchema.parse(value);
    if (request.projectPath) projectAccess.requireShown(request.projectPath);
    const task = beginMa2Read(event, request.progressId);
    try {
      await ma2NetworkReady;
      if (task.signal.aborted) throw new Error('素材读取已取消');
      if (request.projectPath && (!request.projectId || (await projectService.open(request.projectPath)).projectId !== request.projectId)) throw new Error('素材读取进度和当前工程对不上');
      const recovery = request.projectPath && request.projectId ? new Ma2MaterialRecovery(request.projectPath, request.projectId, request.network ? `${request.network.host}:${request.network.port}` : '本机 onPC') : undefined;
      const report = async (update: import('@tb/schema').Ma2ReadProgressUpdate): Promise<void> => { await recovery?.record(update); task.report?.(update); };
      const result = request.network ? await ma2Network.readLibrary(request.network, report, 'library', task.signal, request.targets, request.expectedSource, request.details) : await readMa2EffectLibrary((await getMa2Connection(request)).bridge, () => runtimeActive, report, task.signal, request.targets, request.expectedSource, request.details);
      await recovery?.complete(result);
      await logger.record({ level: result.errors.length ? 'error' : 'info', category: 'device', device: 'MA2', message: `效果库读取 ${result.sequences.length} 条序列；异常：${JSON.stringify(result.errors)}`, result: result.errors.length ? 'failed' : 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `效果库读取失败：${String(error)}`, result: 'failed' });
      throw error;
    } finally { task.finish(); }
  });
  handle('link:ma2-layout', async (_event,value:unknown) => {
    try { return await ma2Network.readLayout(ma2LayoutReadRequestSchema.parse(value)); }
    catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`Layout 读取失败：${String(error)}`,result:'failed'}); throw error; }
  });
  handle('link:ma2-cue-delete-prepare', async (event,value:unknown) => {
    if (ma2Reads.size) throw new Error('请等待当前控台读取结束');
    const request = ma2CueDeletePrepareSchema.parse(value); projectAccess.requireShown(request.projectPath); const task = beginMa2Read(event,request.progressId);
    try { return await ma2Network.prepareCueDeletion(request,task.report); }
    catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`检查空 Cue 删除清单失败：${String(error)}`,result:'failed'}); throw error; }
    finally { task.finish(); }
  });
  handle('link:ma2-cue-delete-commit', async (event,value:unknown) => {
    if (ma2Reads.size) throw new Error('请等待当前控台读取结束');
    const request = ma2CueDeleteCommitSchema.parse(value); projectAccess.requireShown(request.projectPath); const task = beginMa2Read(event,request.progressId);
    try {
      const result = await ma2Network.commitCueDeletion(request,task.report);
      await logger.record({level:result.error?'error':'info',category:'device',device:'MA2',message:`已删除 ${result.deleted.length} 个空 Cue；备份 ${result.backups.join('；')}；${result.error??'控台确认无误'}`,result:result.error?'failed':'succeeded'});
      return result;
    } catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`空 Cue 没有删完：${String(error)}`,result:'failed'}); throw error; }
    finally { task.finish(); }
  });
  handle('link:ma2-song-check', async (_event, value: unknown) => ma2Network.checkSong(ma2SongCheckRequestSchema.parse(value)));
  handle('link:ma2-timecode-ranges', async (_event, value: unknown) => {
    try { return await ma2Network.timecodeRanges(ma2NetworkTargetSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `读取控台时间码节目范围失败：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-song-sync', async (event, value: unknown) => {
    const request = ma2SongSyncRequestSchema.parse(value);
    const task = beginMa2Read(event, request.progressId);
    // 2026-11-09 实时同步慢: each pass logs how long it took, so a diagnostics package shows where the time goes.
    const started = performance.now();
    try {
      const result = await ma2Network.syncSong(request, task.report, task.signal);
      await logger.record({ level: 'info', category: 'device', device: 'MA2', itemId: request.itemId, message: `歌曲同步用了 ${Math.round(performance.now() - started)} ms${result.changed ? '，写入了控台' : '，控台已经一致'}`,
        details: { elapsedMs: Math.round(performance.now() - started), changed: result.changed, points: request.points.length } });
      if (result.changed) await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `歌曲序列 ${result.binding.sequence} · ${result.binding.executor ? `执行器 ${result.binding.executor}` : `Layout ${result.binding.layout}`} 已写入控台并确认，备份 ${result.backupFile}`, result: 'succeeded' });
      return result;
    } catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `歌曲同步停止：${String(error)}`, result: 'failed' }); throw error; }
    finally { task.finish(); }
  });
  handle('link:ma2-layouts', async (_event, value: unknown) => ma2Network.listLayouts(ma2LayoutDirectoryRequestSchema.parse(value)));
  handle('link:ma2-executor-pages', async (_event, value: unknown) => {
    try { return await ma2Network.listExecutorPages(ma2LayoutDirectoryRequestSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `读取执行器页面目录失败：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-live-connect', async (_event, value: unknown) => {
    const request = ma2LiveConnectSchema.parse(value); knownSecrets.add(request.password);
    try { return await ma2Network.live().connect(request); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `连接实时推杆失败：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-live-read', async (_event, value: unknown) => {
    try { return await ma2Network.live().read(ma2LiveRequestSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `实时推杆读取失败：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-live-input', async (_event, value: unknown) => {
    try { ma2Network.live().input(ma2LiveInputSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `推杆操作未完成：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-live-release', () => ma2Network.live().release());
  handle('link:ma2-observe-executor', async (_event, value: unknown) => {
    try { return await ma2Network.live().observe(ma2ExecutorObserveRequestSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'warning', category: 'device', device: 'MA2', message: `读不到控台执行器状态，这首歌不再核对控台在不在跟：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-observer-release', () => ma2Network.live().releaseObserver());
  handle('link:ma2-executor-page', async (_event, value: unknown) => {
    try { return await ma2Network.readExecutorPage(ma2ExecutorPageRequestSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `读取执行器页面失败：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-executor-update', async (_event, value: unknown) => {
    const request = ma2ExecutorUpdateRequestSchema.parse(value);
    try {
      const result = await ma2Network.updateExecutor(request);
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `执行器 ${request.page}.${request.slot} ${request.action.kind} 已确认，备份 ${result.backupFile}`, result: 'succeeded' });
      return result;
    } catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `执行器修改需要确认：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-executor-input', async (_event, value: unknown) => {
    try { await ma2Network.inputExecutor(ma2ExecutorInputSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `执行器按键未完成：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-executor-release', async () => {
    try { await ma2Network.releaseExecutors(); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `执行器松开后没有确认：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-layout-update', async (_event, value: unknown) => {
    try { const result = await ma2Network.updateLayout(ma2LayoutUpdateRequestSchema.parse(value)); await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `Layout ${result.layout} 的名称和位置已确认`, result: 'succeeded' }); return result; }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `Layout 修改未完成：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-new-cue', async (_event,value:unknown) => {
    try { const result=await ma2Network.newCue(ma2NewCueRequestSchema.parse(value));await logger.record({level:'info',category:'device',device:'MA2',message:`已新建序列 ${result.sequence}，Layout ${result.layout.layout} 已确认`,result:'succeeded'});return result; }
    catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`新建 Cue 未完成：${String(error)}`,result:'failed'});throw error; }
  });
  handle('link:ma2-rename', async (_event, value: unknown) => {
    const request = ma2RenameRequestSchema.parse(value);
    try {
      const { bridge } = await getMa2Connection(request);
      const result = await renameMa2Object(bridge, request);
      await ma2ConsoleBackups.record(bridge, { console: ma2ConsoleKey(request), object: `Sequence ${result.sequence}`, files: [result.backupFile] });
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `控台改名已确认：Sequence ${result.sequence} ${result.kind === 'single' ? `Cue ${result.cue}` : ''} → ${result.name}；备份 ${result.backupFile}`, result: 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `控台改名未确认：${String(error)}`, result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-create', async (_event, value: unknown) => {
    const request = ma2CreateRequestSchema.parse(value);
    await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: `新建 Timecode ${request.target}`, result: 'running' });
    try {
      const result = await createMa2Timecode((await getMa2Connection(request)).bridge, request.target, request.name);
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `Timecode ${request.target} 已创建并确认`, result: 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: error instanceof Error ? error.message : String(error), result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-executor', async (_event, value: unknown) => {
    const request = ma2ExecutorReadRequestSchema.parse(value);
    try {
      const result = await readMa2Executor((await getMa2Connection(request)).bridge, request);
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `执行器 ${request.executor} 与 Cue 列表已读取`, result: 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: error instanceof Error ? error.message : String(error), result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-compare', (_event, value: unknown) => {
    const request = ma2CompareRequestSchema.parse(value);
    return compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map(request.choices), request.consoleChanges);
  });
  handle('link:ma2-apply', async (_event, value: unknown) => {
    const request = ma2ApplyRequestSchema.parse(value);
    const { bridge, service } = await getMa2Connection(request);
    await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: `开始同步 Timecode ${request.readback.target}`, result: 'running' });
    const result = await service.apply(request);
    if (result.status === 'verified' && result.backupFile) await ma2ConsoleBackups.record(bridge, { console: ma2ConsoleKey(request), object: `Timecode ${request.readback.target}`, files: [result.backupFile] });
    await logger.record({ level: result.status === 'verified' ? 'info' : 'error', category: 'device', device: 'MA2', message: result.status === 'verified' ? 'MA2 已确认，等待应用到节目' : result.message, result: result.status === 'verified' ? 'succeeded' : 'failed', details: result.status === 'verified' ? { backupFile: result.backupFile } : { stage: result.stage, mayHaveWritten: result.mayHaveWritten, backupFile: result.backupFile } });
    return result;
  });
  handle('link:app-info', async (): Promise<LinkAppInfo> => {
    const disk = await statfs(app.getPath('userData'));
    return {
      ...buildIdentity(),
      platform: process.platform,
      architecture: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      availableDiskBytes: disk.bavail * disk.bsize
    };
  });
  handle('link:update-status', (): LinkUpdateStatus => updateManager.getStatus());
  handle('link:update-check', (): Promise<LinkUpdateStatus> => updateManager.check());
  handle('link:update-download', (): Promise<LinkUpdateStatus> => updateManager.download());
  handle('link:update-install', async () => {
    if (runtimeActive || nativePlaybackActive()) throw new Error('联动还没停止。请先到集成中心停止联动、等 OBS 清理完成，再安装更新');
    await updateManager.prepareInstall();
    const decision = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: '安装团播联动台更新',
      message: '联动台会退出并安装已下载的新版本。',
      detail: '退出前会像平时关闭软件一样，逐项确认未保存的工程、灯光试听和联动台启动的外部程序。更新完成后联动台会自动重新启动。',
      buttons: ['取消', '退出并安装'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (decision.response !== 1) return;
    // The same guard and quit flow as closing the window: unsaved changes, lighting audition,
    // external programs and music analysis are settled before the installer starts.
    await runQuit('update', () => {
      recordQuitStep('启动更新安装程序');
      try {
        updateManager.install();
      } catch (error) {
        allowWindowClose = false;
        throw error;
      }
    });
  });
  // The window only selects among projects the main process approved. A failed last-project
  // record is reported after the state is taken, so the quit guard still sees it.
  handle('link:set-document-state', async (_event, stateValue: unknown) => {
    const state = linkDocumentStateSchema.parse(stateValue);
    requireApprovedOrUnnamed(state.projectPath);
    documentState = state;
    await projectAccess.show(state.projectPath);
  });
  handle('link:resolve-unsaved-changes', (_event, reasonValue: unknown) => unsavedChanges.resolve(linkUnsavedChangesReasonSchema.parse(reasonValue)));
  handle('link:save-response', (_event, responseValue: unknown) => {
    const response = linkSaveResponseSchema.parse(responseValue);
    rendererSaves.answer(response.id, response.result);
  });
  handle('link:set-runtime-active', async (_event, activeValue: unknown) => {
    if (licenseChanging && activeValue === true) throw new Error('授权操作还没完成，请稍后再播放');
    const active = linkRuntimeActiveSchema.parse(activeValue);
    await licenseAccess.setActive(active);
    if (active && licenseChanging) { await licenseAccess.setActive(false); throw new Error('正在更换授权，请完成后再播放'); }
    runtimeActive = active;
  });
  handle('link:window-control', (event, actionValue: unknown) => {
    const action = linkWindowControlActionSchema.parse(actionValue);
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) throw new Error('找不到联动台窗口');
    if (action === 'minimize') targetWindow.minimize();
    else if (action === 'toggleMaximize') {
      if (targetWindow.isMaximized()) targetWindow.unmaximize();
      else targetWindow.maximize();
    } else targetWindow.close();
  });
  handle('link:detect-local-integrations', async () => {
    const detection = await integrationDetector.detect();
    await Promise.all((['obs', 'p1', 'ma2', 'ma3d'] as const).map(async (id) => {
      const application = detection.applications[id];
      if (!application?.executablePath || !application.workingDirectory) return;
      chosenPrograms.choose(application.executablePath);
      await processManager.refresh(id, {
        executablePath: application.executablePath,
        workingDirectory: application.workingDirectory,
        arguments: [],
        startupTimeoutMs: 20_000,
        shutdownTimeoutMs: 10_000
      });
    }));
    return detection;
  });
  handle('link:loop-midi', async (_event, value: unknown) => {
    const action = loopMidiActionSchema.parse(value);
    if (action !== 'detect' && runtimeActive) throw new Error('请先停止演出，再配置虚拟 MIDI');
    try {
      if (action === 'download') await shell.openExternal('https://www.tobias-erichsen.de/software/loopmidi.html');
      const result = loopMidiStatusSchema.parse(await (action === 'start' ? loopMidiService.start() : loopMidiService.detect()));
      await logger.record({ level: 'info', category: 'device', device: 'loopMIDI', message: `loopMIDI ${action}：${result.state}`, result: 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'loopMIDI', message: error instanceof Error ? error.message : String(error), result: 'failed' });
      throw error;
    }
  });
  handle('link:pick-executable', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 Windows 程序',
      properties: ['openFile'],
      filters: [{ name: 'Windows 程序', extensions: ['exe'] }]
    });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    if (path) chosenPrograms.choose(path);
    return path;
  });
  handle('link:pick-working-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择启动文件夹', properties: ['openDirectory'] });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    if (path) chosenFolders.choose(path);
    return path;
  });
  handle('link:create-project', (_event, nameValue: unknown) => createEmptyLinkProject(linkProjectNameSchema.parse(nameValue)));
  handle('link:pick-open-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '打开团播联动工程',
      properties: ['openFile'],
      filters: [{ name: '团播联动工程', extensions: ['tblink'] }]
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    const document = await projectDocuments.open(path);
    projectAccess.opened(path);
    return { version: 1, path, ...document };
  });
  // Reopening only: the last project, the shown one (恢复到上次保存, archive restore) or another approved path.
  handle('link:open-project', async (_event, pathValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue);
    projectAccess.requireApproved(path);
    const document = await projectDocuments.open(path);
    projectAccess.opened(path);
    return { version: 1, path, ...document };
  });
  handle('link:last-project', () => projectAccess.lastProject());
  handle('link:save-project', async (_event, pathValue: unknown, projectValue: unknown, optionsValue: unknown) => {
    const content = projectDocumentTextSchema.parse(projectValue);
    const options = projectSaveOptionsSchema.parse(optionsValue);
    let destination = linkOptionalFilePathSchema.parse(pathValue);
    // A named save writes the shown project; any other destination comes from the save dialog.
    if (destination) projectAccess.requireShown(destination);
    else {
      const fileName = `${safeFileName(await projectDocuments.inspect(content))}.tblink`;
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: options.defaultPath ? '另存团播联动工程' : '保存团播联动工程',
        defaultPath: options.defaultPath ? join(dirname(options.defaultPath), fileName) : fileName,
        filters: [{ name: '团播联动工程', extensions: ['tblink'] }]
      });
      if (result.canceled || !result.filePath) return null;
      destination = result.filePath;
      projectAccess.approve(destination);
    }
    try { await projectDocuments.save(destination, content, options.backupOriginal === true); }
    catch (error) {
      await logger.record({ level:'error', category:'system', message:'工程保存失败，文件可能没有写入', result:'failed', details:{ path:destination, error:error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    // A save to the dialog's answer is the project the window shows from now on.
    projectAccess.opened(destination);
    return destination;
  });
  const copies = new RecoveryCopies(join(app.getPath('userData'), 'link-recovery'), projectDocuments);
  recoveryCopies = copies;
  // Copies are written and offered only after the startup cleanup, so it never removes one in use.
  // A failed cleanup is logged and retried at the next startup; it never blocks opening or editing.
  const pruning = copies.prune(path => shell.trashItem(path)).then(async pruned => {
    for (const entry of pruned) await logger.record({ level: 'info', category: 'system', message: entry.reason === 'orphan' ? `清除残留的恢复副本文件：${entry.file}`
      : `恢复副本${entry.reason === 'expired' ? '超过 30 天' : '超过 20 份'}，已移到回收站：${entry.manifest.name}`, details: entry.reason === 'orphan' ? {} : { projectPath: entry.manifest.projectPath, savedAt: entry.manifest.savedAt } });
  }).catch(async (error: unknown) => {
    await logger.record({ level: 'warning', category: 'system', message: '恢复副本没清理完，下次启动时再试', details: { error: error instanceof Error ? error.message : String(error) } });
  });
  // The renderer records a failed write once, with the reason shown to the operator.
  handle('link:write-recovery-copy', async (_event, payload: unknown) => {
    const copy = recoveryCopyWriteSchema.parse(payload);
    requireApprovedOrUnnamed(copy.projectPath);
    await pruning; return copies.write(copy);
  });
  handle('link:confirm-project-location', async (_event, purposeValue: unknown) => {
    const purpose = z.string().min(1).max(200).parse(purposeValue);
    const { response } = await dialog.showMessageBox(mainWindow!, { type: 'question', title: '选择工程保存位置', noLink: true,
      message: `${purpose}需要先保存工程。`, detail: '素材和读取进度会放在工程文件旁边。选好位置保存后继续，取消则不执行。',
      buttons: ['选择保存位置', '取消'], defaultId: 0, cancelId: 1 });
    return response === 0;
  });
  handle('link:project-document-worker', () => ({ stalled: projectDocuments.stalledReason() }));
  handle('link:restart-project-document-worker', async (_event, reasonValue: unknown) => {
    const reason = z.string().min(1).max(8192).parse(reasonValue);
    const { response } = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: '工程处理没有响应', noLink: true,
      message: '保存没有完成：工程处理超过 30 秒没有响应。',
      detail: `${reason}\n\n重启工程处理后再保存一次。上一次未确认的保存可能已经写入，再次保存后以本次内容为准。`,
      buttons: ['重启并保存', '取消'], defaultId: 0, cancelId: 1 });
    if (response !== 0) return false;
    if (projectDocuments.stalledReason()) projectDocuments.restart();
    await logger.record({ level: 'warning', category: 'system', message: '操作员确认重启工程处理并再保存一次', details: { reason } });
    return true;
  });
  handle('link:confirm-revert-to-saved', async (_event, payloadValue: unknown) => {
    const payload = z.object({ name: z.string().max(512), consoleSynced: z.boolean() }).strict().parse(payloadValue);
    const { response } = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: '恢复到上次保存', noLink: true,
      message: `放弃对「${payload.name}」的所有未保存修改？`,
      detail: ['重新打开工程文件里上次保存的内容，撤销记录会清空，恢复副本会删除。', ...payload.consoleSynced ? ['已同步到控台的改动不会撤回。'] : []].join('\n'),
      buttons: ['恢复到上次保存', '取消'], defaultId: 1, cancelId: 1 });
    return response === 0;
  });
  handle('link:discard-recovery-copy', (_event, payload: unknown) => {
    const discard = recoveryCopyDiscardSchema.parse(payload);
    requireApprovedOrUnnamed(discard.projectPath);
    return copies.discard(discard);
  });
  handle('link:resolve-recovery-copy', async (_event, payload: unknown) => {
    const query = recoveryCopyQuerySchema.parse(payload);
    requireApprovedOrUnnamed(query.projectPath);
    await pruning;
    const content = await offerRecoveryCopy(query, {
      copies,
      read: path => projectDocuments.read(path),
      modifiedAt: async path => (await stat(path)).mtime,
      exists: path => stat(path).then(() => true, (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }),
      ask: async offer => {
        const { response } = await dialog.showMessageBox(mainWindow!, recoveryPrompt(offer));
        const choice = response === 0 ? 'restore' as const : 'discard' as const;
        await logger.record({ level: 'info', category: 'system', message: choice === 'restore' ? `恢复未保存的改动：${offer.name}` : `丢弃恢复副本（已移到回收站）：${offer.name}` });
        return choice;
      },
      trash: path => shell.trashItem(path),
      log: message => { void logger.record({ level: 'info', category: 'system', message }).catch((error: unknown) => console.error('记录恢复副本失败', error)); }
    });
    return content === null ? null : { version: 1 as const, content };
  });
  const archiveSettings = new ProjectArchiveSettingsStore(join(app.getPath('userData'), 'link-integrations', 'archive-settings.json'), join(app.getPath('documents'), '团播联动台', '存档'));
  // A failed trim leaves the extra archive in place and is logged; it never blocks the sync that archived.
  handle('link:project-archives', (_event, payload: unknown) => {
    projectAccess.requireShown(projectArchiveRequestSchema.parse(payload).projectPath);
    return projectArchives(payload, projectDocuments, archiveSettings, path => shell.showItemInFolder(path), async path => {
      try { await shell.trashItem(path); return true; }
      catch (error) { await logger.record({ level: 'warning', category: 'system', message: '自动存档超出保留数量，但没能移到回收站', details: { path, error: error instanceof Error ? error.message : String(error) } }); return false; }
    });
  });
  handle('link:project-archive-settings', async (_event, payload: unknown) => {
    const request = projectArchiveSettingsActionSchema.parse(payload);
    const settings = await archiveSettings.read();
    if (request.action === 'save') await archiveSettings.write({ ...settings, enabled: request.enabled, keep: request.keep, nameTemplate: request.nameTemplate });
    if (request.action === 'reset-directory') await archiveSettings.write({ ...settings, directory: null });
    if (request.action === 'choose-directory') {
      const result = await dialog.showOpenDialog(mainWindow!, { title: '选择工程存档位置', defaultPath: archiveSettings.root(settings), properties: ['openDirectory', 'createDirectory'] });
      const directory = result.filePaths[0];
      if (!result.canceled && directory) await archiveSettings.write({ ...settings, directory });
    }
    if (request.action === 'open-directory') {
      const root = archiveSettings.root(settings);
      await mkdir(root, { recursive: true });
      const failure = await shell.openPath(root);
      if (failure) throw new Error(`无法打开存档位置：${failure}`);
    }
    return archiveSettings.status();
  });
  handle('link:import-reference-audio', async (_event, payloadValue: unknown) => {
    const payload = linkReferenceAudioImportPayloadSchema.parse(payloadValue);
    await projectAccess.requireImportSource(payload.projectPath, payload.sourcePath, chosenFiles);
    return projectService.importReferenceAudio(payload.projectPath, payload.sourcePath, payload.durationMs);
  });
  handle('link:resolve-reference-audio-url', async (_event, payloadValue: unknown) => {
    const payload = linkReferenceAudioResolvePayloadSchema.parse(payloadValue);
    await projectAccess.assetFiles(payload.projectPath, [payload.relativePath]);
    const path = projectService.resolveReferenceAudio(payload.projectPath, payload.relativePath);
    return projectAccess.assetUrl(payload.projectPath, path);
  });
  handle('link:import-media-asset', async (_event, payloadValue: unknown) => {
    const payload = linkMediaAssetImportPayloadSchema.parse(payloadValue);
    await projectAccess.requireImportSource(payload.projectPath, payload.sourcePath, chosenFiles);
    const requiresProbe = (payload.kind !== 'image' && payload.durationMs === undefined)
      || (payload.kind !== 'audio' && (payload.width === undefined || payload.height === undefined));
    const probed = requiresProbe ? await mediaMetadataProbe.inspect(payload.sourcePath, payload.kind) : {};
    const asset = await projectService.importMediaAsset(payload.projectPath, payload.sourcePath, {
      name: payload.name,
      kind: payload.kind,
      ...(payload.durationMs ?? probed.durationMs ? { durationMs: payload.durationMs ?? probed.durationMs } : {}),
      ...(payload.width ?? probed.width ? { width: payload.width ?? probed.width } : {}),
      ...(payload.height ?? probed.height ? { height: payload.height ?? probed.height } : {})
    });
    return asset;
  });
  handle('link:resolve-media-asset-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaAssetResolvePayloadSchema.parse(payloadValue);
    await projectAccess.assetFiles(payload.projectPath, [payload.relativePath]);
    return projectAccess.assetUrl(payload.projectPath, projectService.resolveMediaAsset(payload.projectPath, payload.relativePath));
  });
  handle('link:ensure-media-preview-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.parse(payloadValue);
    await projectAccess.assetFiles(payload.projectPath, [payload.relativePath]);
    const path = payload.kind === 'video'
      ? await mediaPreviewService.ensureVideoPreview(payload.projectPath, payload.relativePath, payload.sha256)
      : projectService.resolveMediaAsset(payload.projectPath, payload.relativePath);
    return projectAccess.assetUrl(payload.projectPath, path);
  });
  handle('link:ensure-media-thumbnail-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.strict().parse(payloadValue);
    if (payload.kind === 'audio') throw new Error('音频素材使用类型图标');
    await projectAccess.assetFiles(payload.projectPath, [payload.relativePath]);
    return projectAccess.assetUrl(payload.projectPath, await mediaPreviewService.ensureThumbnail(payload.projectPath, payload.relativePath, payload.sha256));
  });
  handle('link:ensure-media-audio-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.parse(payloadValue);
    if (payload.kind === 'image') throw new Error('图片素材不包含音轨');
    await projectAccess.assetFiles(payload.projectPath, [payload.relativePath]);
    return projectAccess.assetUrl(payload.projectPath, await mediaPreviewService.ensureAudioPreview(payload.projectPath, payload.relativePath, payload.sha256));
  });
  const waveformService = new WaveformService(projectService);
  const audioEditService = new AudioEditService(projectService, ibtExecutable(app.isPackaged ? process.resourcesPath : undefined));
  const musicAnalysis = new MusicAnalysisService(projectService, progress => sendToRenderer('link:music-analysis-progress', progress));
  const analysisRoot = app.isPackaged ? join(process.resourcesPath, 'music-analysis') : join(__dirname, '../../../../output/music-analysis');
  automaticMusic = new AutomaticMusicRuntime(projectService, {
    python: join(analysisRoot, app.isPackaged ? 'runtime/python.exe' : 'env/Scripts/python.exe'),
    worker: app.isPackaged ? join(analysisRoot, 'worker.py') : join(__dirname, '../../../../tools/music-analysis/worker.py'),
    bundle: join(analysisRoot, 'models'), ffmpeg: ffmpegPath?.replace('app.asar', 'app.asar.unpacked') ?? '',
    root: join(app.getPath('userData'), 'music-analysis'), device: app.isPackaged ? 'cpu' : 'cuda', devices: app.isPackaged ? ['cpu'] : ['cuda', 'cpu']
  }, job => {
    sendToRenderer('link:automatic-music-job', job);
    if (job.state === 'failed') void logger.record({ level: 'error', category: 'device', device: '音乐识别', message: job.message, result: 'failed' }).catch((error: unknown) => console.error('音乐识别日志保存失败', error));
  });
  handle('link:automatic-music-status', () => automaticMusic!.status());
  handle('link:automatic-music-start', async (_event, value: unknown) => {
    const request = automaticMusicRequestSchema.parse(value);
    await projectAccess.assetFiles(request.projectPath, [request.source.relativePath]);
    return automaticMusic!.start(request);
  });
  handle('link:automatic-music-control', (_event, value: unknown) => {
    const request = automaticMusicControlSchema.parse(value);
    if (request.action === 'cancel') return automaticMusic!.cancel(request.taskId);
    automaticMusic!.resume(request.taskId);
  });
  app.once('before-quit', () => musicAnalysis.close());
  musicMonitor = new MusicMonitorService(app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe') : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe'), projectService, obs, error => { void logger.record({ level: 'error', category: 'device', device: '编排监听', message: error.message, result: 'failed' }).catch((failure: unknown) => console.error('监听日志保存失败', failure)); }, status => sendToRenderer('link:music-monitor-status', status));
  handle('link:start-music-monitor', async (_event, value: unknown) => {
    const request = musicMonitorRequestSchema.parse(value);
    await projectAccess.assetFiles(request.projectPath, [request.source.relativePath]);
    return musicMonitor!.start(request);
  });
  handle('link:stop-music-monitor', () => musicMonitor!.stop());
  handle('link:analyze-music', async (_event, value: unknown) => {
    if (runtimeActive) throw new Error('请先停止播放，再分析音乐');
    const request = musicAnalysisRequestSchema.parse(value);
    await projectAccess.assetFiles(request.projectPath, [request.source.relativePath]);
    return musicAnalysis.analyze(request.taskId, request.projectPath, request.source);
  });
  handle('link:cancel-music-analysis', (_event, value: unknown) => { musicAnalysis.cancel(musicAnalysisControlSchema.parse(value).taskId); });
  handle('link:analyze-audio-beats', async (_event, value: unknown) => {
    const payload = audioAnalysisRequestSchema.parse(value);
    await projectAccess.assetFiles(payload.projectPath, [payload.source.relativePath]);
    return audioEditService.analyze(payload.projectPath, payload.source);
  });
  handle('link:render-audio-segments', async (_event, value: unknown) => {
    const payload = audioRenderRequestSchema.parse(value);
    if (runtimeActive) throw new Error('请停止播放后编辑音频');
    await projectAccess.assetFiles(payload.projectPath, [payload.source, ...(payload.tracks ?? []).map(track => track.source)].map(source => source.relativePath));
    return payload.tracks ? audioEditService.mix(payload.projectPath, payload.tracks) : audioEditService.render(payload.projectPath, payload.source, payload.segments);
  });
  handle('link:generate-waveform', (_event, payloadValue: unknown) => {
    const payload = linkWaveformGeneratePayloadSchema.parse(payloadValue);
    projectAccess.requireShown(payload.projectPath);
    const sourcePath = projectAccess.assetPath(new URL(payload.url).pathname.slice(1));
    if (!sourcePath) throw new Error('波形素材链接已失效，请重新打开节目');
    return waveformService.ensure(payload.projectPath, sourcePath, payload.sha256, payload.durationMs);
  });
  handle('link:load-waveform-cache', (_event, payloadValue: unknown) => {
    const payload = linkWaveformCachePayloadSchema.parse(payloadValue);
    projectAccess.requireShown(payload.projectPath);
    return projectService.loadWaveformCache(payload.projectPath, payload.sha256);
  });
  handle('link:save-waveform-cache', (_event, payloadValue: unknown) => {
    const payload = linkWaveformCacheSavePayloadSchema.parse(payloadValue);
    projectAccess.requireShown(payload.projectPath);
    return projectService.saveWaveformCache(payload.projectPath, payload.sha256, payload.peaks);
  });
  handle('link:inspect-project-assets', async (_event, pathValue: unknown, projectValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue); const project = parseLinkProject(projectValue);
    await projectAccess.assetFiles(path, projectFileReferences(project).map(file => file.relativePath));
    return projectService.inspectAssets(path, project);
  });
  handle('link:inspect-media-assets', async (_event, value: unknown) => {
    const payload = linkMediaInspectionPayloadSchema.parse(value);
    await projectAccess.assetFiles(payload.projectPath, payload.assets.map(asset => asset.relativePath));
    return projectService.inspectMediaAssets(payload.projectPath, payload.assets);
  });
  handle('link:find-missing-asset-files', (_event, value: unknown) => assetRelinkRequests.findMissing(linkProjectAssetFilesPayloadSchema.parse(value)));
  handle('link:pick-asset-source-directory', async (_event, pathValue: unknown) => {
    const projectPath = linkFilePathSchema.parse(pathValue);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择原工程文件夹（原 .tblink 所在的文件夹）',
      defaultPath: dirname(projectPath),
      properties: ['openDirectory']
    });
    const directory = result.canceled ? null : result.filePaths[0] ?? null;
    assetRelinkRequests.pickedSourceDirectory(directory);
    return directory;
  });
  handle('link:relink-asset-files', (_event, value: unknown) => {
    if (runtimeActive) throw new Error('请停止播放后找回素材');
    return assetRelinkRequests.relink(linkProjectAssetRelinkPayloadSchema.parse(value));
  });
  handle('link:p1-detect-current-project', async () => {
    const detection = await integrationDetector.detect();
    const title = detection.applications.p1.windowTitle?.trim() ?? '';
    if (!title.toLocaleLowerCase('en-US').endsWith('.hia')) {
      throw new Error('P1 现在没有打开已保存的 .hia 工程。请先在 P1 里保存工程，或手动选择 .hia 文件');
    }
    const candidate = title.replaceAll('/', '\\');
    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) throw new Error(`找不到 P1 当前的工程文件：${candidate}`);
    chosenFiles.choose(candidate);
    return candidate;
  });
  handle('link:p1-pick-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 Hirender P1 音频工程',
      properties: ['openFile'],
      filters: [{ name: 'Hirender P1 音频工程', extensions: ['hia'] }]
    });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    if (path) chosenFiles.choose(path);
    return path;
  });
  const p1Imports = new Map<string, { senderId: number; controller: AbortController }>();
  handle('link:p1-import-cancel', (event, value: unknown) => {
    const id = z.string().uuid().parse(value);
    const task = p1Imports.get(id);
    if (task?.senderId === event.sender.id) task.controller.abort();
  });
  handle('link:p1-import-project', async (event, payloadValue: unknown) => {
    const payload = linkP1ProjectImportPayloadSchema.parse(payloadValue);
    projectAccess.requireShown(payload.linkProjectPath); chosenFiles.require(payload.p1ProjectPath);
    const id = payload.progressId;
    if (id && p1Imports.has(id)) throw new Error('P1 导入任务编号重复');
    const controller = new AbortController();
    if (id) p1Imports.set(id, { senderId: event.sender.id, controller });
    try {
      const result = await p1ProjectService.importProject(payload.p1ProjectPath, payload.linkProjectPath, {
        signal: controller.signal,
        ...(id ? { onProgress: (progress: Omit<LinkP1ProjectImportProgress, 'id'>) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send('link:p1-import-progress', linkP1ProjectImportProgressSchema.parse({ id, ...progress } satisfies LinkP1ProjectImportProgress));
        } } : {})
      });
      // Each song's MidiStartTime as P1 wrote it: the start its console timeline is lined up with.
      await logger.record({ level: result.skippedItems?.length ? 'warning' : 'info', category: 'operator', device: 'P1', result: 'succeeded',
        message: `已从 P1 读取 ${result.items.length} 首歌${result.skippedItems?.length ? `，${result.skippedItems.length} 首需要修复` : ''}`,
        details: { source: result.sourcePath, songs: result.items.map(item => ({ title: item.title, midiStartTime: item.p1Media.midiStartTime, durationMs: item.referenceAudio.durationMs, ...item.p1Media.sourceTrim ? { trim: item.p1Media.sourceTrim } : {} })),
          skipped: result.skippedItems?.map(item => ({ title: item.title, reason: item.reason })) ?? [] } });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'operator', device: 'P1', result: 'failed', message: `P1 工程读取失败：${error instanceof Error ? error.message : String(error)}` });
      throw error;
    } finally { if (id) p1Imports.delete(id); }
  });
  handle('link:p1-preview-export', (_event, payloadValue: unknown) => {
    const payload = linkP1ProjectExportPreviewPayloadSchema.parse(payloadValue);
    projectAccess.requireShown(payload.linkProjectPath); chosenFiles.require(payload.p1ProjectPath);
    return p1ProjectService.previewExport(payload.p1ProjectPath, payload.linkProjectPath, payload.project);
  });
  handle('link:p1-export-project', async (_event, payloadValue: unknown) => {
    const payload = linkP1ProjectExportPayloadSchema.parse(payloadValue);
    projectAccess.requireShown(payload.linkProjectPath); chosenFiles.require(payload.p1ProjectPath);
    const result = await p1ProjectService.exportProject(
      payload.p1ProjectPath,
      payload.linkProjectPath,
      payload.project,
      payload.expectedSourceSha256
    );
    await logger.record({ level: 'info', category: 'operator', device: 'P1', result: 'succeeded', message: `已写出 P1 工程：${result.outputPath}`,
      details: { songs: result.itemBindings.map(binding => ({ itemId: binding.itemId, midiStartTime: binding.p1Media.midiStartTime })) } });
    return result;
  });
  handle('link:load-profile', () => profileStore.loadProfile());
  handle('link:save-profile', async (_event, payloadValue: unknown) => {
    const result = linkIntegrationProfileSavePayloadSchema.safeParse(payloadValue);
    if (!result.success) {
      const issues = result.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code, message: issue.message }));
      await logger.record({ level: 'error', category: 'device', device: '连接配置', result: 'failed',
        message: '连接配置校验失败', details: { issues } });
      throw new Error(`连接配置校验失败：${issues.map(issue => `${issue.path}：${issue.message}`).join('；')}`);
    }
    const payload = result.data;
    const profile = payload.profile;
    requireChosenPrograms(profile, await profileStore.loadProfile(), chosenPrograms, chosenFolders);
    if (payload.obsPassword !== undefined) knownSecrets.add(payload.obsPassword);
    try {
      if (payload.obsPassword !== undefined) await profileStore.saveCredential(profile.obs.credentialId, payload.obsPassword);
      await profileStore.saveProfile(profile);
    }
    catch (error) {
      await logger.record({ level: 'error', category: 'device', device: '连接配置', result: 'failed',
        message: `连接配置写入失败：${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
  });
  handle('link:security-availability', () => safeStorage.isEncryptionAvailable());
  handle('link:security-preflight', async () => {
    try {
      const profile = await requireProfile(profileStore);
      const password = await profileStore.loadObsPassword(profile.obs.credentialId);
      knownSecrets.add(password);
      const probe = JSON.stringify(redactValue({ password, message: `probe:${password}` }, [password]));
      return {
        credentialDecryptable: true,
        logRedactionReady: password.length === 0 || !probe.includes(password),
        error: null
      };
    } catch (error) {
      return {
        credentialDecryptable: false,
        logRedactionReady: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  const connectObs = async (): Promise<LinkObsSnapshot> => {
    const profile = await requireProfile(profileStore);
    let connected: LinkObsSnapshot;
    try {
      const password = await profileStore.loadObsPassword(profile.obs.credentialId);
      knownSecrets.add(password);
      connected = await obs.connect(profile.obs.webSocketUrl, password, profile.obs.startupTimeoutMs);
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed',
        message: `OBS 连接失败：${error instanceof Error ? error.message : String(error)}`, details: { address: profile.obs.webSocketUrl } });
      throw error;
    }
    // Resolve the local bridge during explicit connection, not inside the one
    // second playback admission window. Discovery failure does not undo auth.
    if (connected.status === 'connected' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.obs.webSocketUrl).hostname)) {
      try { await nativeSeek.prepare(profile.obs.webSocketUrl); }
      catch (error) { await logger.record({ level: 'warning', category: 'device', device: 'OBS 原生媒体',
        message: `OBS 已连接，但联动台的 OBS 媒体组件识别失败：${error instanceof Error ? error.message : String(error)}`, result: 'failed' }); }
    }
    return connected;
  };
  handle('link:obs-disconnect', () => obs.disconnect());
  handle('link:obs-snapshot', () => obs.getSnapshot());
  let inventoryWarningKey = '';
  handle('link:obs-inventory', async (): Promise<LinkObsInventory> => {
    const inventory = await obs.readInventory();
    const warnings = z.record(z.string(), z.string()).parse(inventory.sourceSizeErrors ?? {});
    const key = JSON.stringify(Object.entries(warnings).sort());
    if (key !== inventoryWarningKey && Object.keys(warnings).length > 0) {
      await logger.record({ level: 'warning', category: 'device', device: 'obs', result: 'failed',
        message: '部分 OBS 来源读不到尺寸，其他场景已读取，可以继续播放', details: warnings });
    }
    inventoryWarningKey = key;
    return inventory;
  });
  handle('link:obs-media-scenes-prepare', async (_event, pathValue: unknown, projectValue: unknown, preciseSeekingValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue); const project = parseLinkProject(projectValue);
    const preciseSeeking = z.boolean().parse(preciseSeekingValue);
    if (obs.getSnapshot().status !== 'connected') throw new Error('请先连接 OBS，再同步素材场景');
    await projectAccess.assetFiles(path, projectFileReferences(project).map(file => file.relativePath));
    await projectService.inspectAssets(path, project);
    const targets = materialSceneTargets(project);
    for (const [index, target] of targets.entries()) {
      const { asset } = target;
      const absolutePath = projectService.resolveMediaAsset(path, asset.relativePath);
      if (!(await stat(absolutePath)).isFile()) throw new Error(`素材文件读不了：${asset.name}`);
      const generation = { startedAt: 0 };
      const playbackPath = preciseSeeking && asset.kind === 'video'
        ? await mediaPreviewService.ensureObsSeekVideo(path, asset.relativePath, asset.sha256, 'hardware', () => {
          generation.startedAt = performance.now();
          sendToRenderer('link:obs-media-preparation', obsMediaPreparationSchema.parse({ assetName: asset.name, index, total: targets.length }));
          void logger.record({ level: 'info', category: 'device', device: 'obs', message: `正在准备 OBS 画面：${asset.name}（${index + 1}/${targets.length}）`, result: 'running' })
            .catch((error: unknown) => console.error('定位缓存日志未能写入', error));
        }) : absolutePath;
      if (generation.startedAt) await logger.record({ level: 'info', category: 'device', device: 'obs', message: `OBS 画面已准备好：${asset.name}`,
        result: 'succeeded', details: { elapsedMs: Math.round(performance.now() - generation.startedAt) } });
      await obs.mediaScenes.prepare(project.projectId, asset, absolutePath, playbackPath, obsMediaCachePaths(path, asset.sha256), target);
    }
  });
  handle('link:obs-source-create', (_event, value: unknown) => obs.sources.create(obsSourceCreateSchema.parse(value)));
  handle('link:obs-source-options', (_event, value: unknown) => obs.sources.options(obsSourceNameSchema.parse(value)));
  handle('link:obs-source-cancel', (_event, value: unknown) => obs.sources.cancel(obsSourceNameSchema.parse(value)));
  handle('link:obs-source-apply', async (_event, value: unknown) => {
    const payload = obsSourceApplySchema.parse(value);
    if (payload.projectAsset) await projectAccess.assetFiles(payload.projectAsset.projectPath, [payload.projectAsset.relativePath]);
    else if (payload.settings.path) chosenFiles.require(payload.settings.path);
    const settings = payload.projectAsset ? { ...payload.settings, path: projectService.resolveMediaAsset(payload.projectAsset.projectPath, payload.projectAsset.relativePath) } : payload.settings;
    return obs.sources.apply(payload.inputName, settings);
  });
  obs.liveEditor.subscribe(() => sendToRenderer('link:obs-live-changed', null));
  handle('link:obs-output-status', () => obs.readOutputStatus());
  handle('link:obs-live-scene', () => obs.liveEditor.read());
  const beautyRuntime = new BeautyRuntime(app.isPackaged ? join(process.resourcesPath, 'beauty') : join(__dirname, '../../../../artifacts/beauty-prototype'),
    join(app.getPath('userData'), 'beauty-reports'), obs.beauty, message => {
      void logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message }).catch((error: unknown) => console.error('美颜日志写入失败', error));
    });
  handle('link:beauty-install', async () => {
    try { return await beautyRuntime.install(); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  handle('link:beauty-start', (_event, value: unknown) => beautyRuntime.start(beautyStartSchema.parse(value).sourceName));
  handle('link:beauty-stop', () => beautyRuntime.stop());
  const beautyOutput = new BeautyOutputController(beautyRuntime, obs.beauty, message => {
    void logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message }).catch((error: unknown) => console.error('美颜日志写入失败', error));
  });
  obs.subscribe(state => beautyOutput.connection(state.status === 'connected'));
  obs.subscribeProgramScene(() => beautyOutput.sceneChanged());
  handle('link:beauty-output', (_event, value: unknown) => beautyOutput.configure(beautyBasicValuesSchema.parse(value)));
  handle('link:beauty-status', () => beautyOutput.status());
  const beautyComparison = new BeautyComparison(async target => {
    const profile = await requireProfile(profileStore);
    const pid = await findLocalObsPid(profile.obs.webSocketUrl);
    if (pid === null) throw new Error('美颜对比需要连接本机 OBS');
    return obs.beauty.comparisonPipe(target, pid);
  });
  handle('link:beauty-comparison-frame', async (_event, value: unknown) => {
    if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 未连接');
    try { return await beautyComparison.next(beautyTargetSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: `美颜对比失败：${String(error)}` }); throw error; }
  });
  handle('link:beauty-comparison-close', () => beautyComparison.close());
  mainWindow?.on('hide', () => beautyComparison.close());
  mainWindow?.on('minimize', () => beautyComparison.close());
  app.on('will-quit', () => beautyComparison.close());
  obs.subscribe(state => { if (state.status !== 'connected') beautyComparison.close(); });
  app.on('will-quit', () => beautyRuntime.close());
  handle('link:obs-beauty-read', async (_event, value: unknown) => {
    try { return await obs.beauty.read(beautyTargetSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  handle('link:obs-beauty-apply', async (_event, value: unknown) => {
    try { return await obs.beauty.apply(beautyApplySchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  handle('link:obs-live-edit', async (_event, value: unknown) => {
    try { await obs.liveEditor.edit(obsLiveEditSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  const livePreview = new ObsLivePreview();
  obs.subscribe((state) => { if (state.status !== 'connected') nativeSeek.reset(); });
  handle('link:obs-seek-managed-media', async (_event, value: unknown) => {
    if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 未连接');
    const payload = linkManagedMediaExecutionPayloadSchema.parse(value);
    await projectAccess.assetFiles(payload.projectPath, [payload.event.relativePath]);
    const absolutePath = projectService.resolveMediaAsset(payload.projectPath, payload.event.relativePath);
    const address = (await requireProfile(profileStore)).obs.webSocketUrl;
    try {
      // Resolve the transport before starting a short video: process discovery can outlast the clip.
      await nativeSeek.prepare(address);
      await obs.mediaScenes.seek(payload.event, absolutePath, (name, position) => nativeSeek.seek(address, name, position));
    }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  handle('link:obs-connect', connectObs);
  let localObsConnecting = false;
  handle('link:obs-connect-local', async () => {
    if (runtimeActive) throw new Error('请先停止节目再连接 OBS');
    if (localObsConnecting) throw new Error('正在自动连接 OBS，请稍等');
    localObsConnecting = true;
    try {
      let profile = await requireProfile(profileStore);
      let process = await processManager.refresh('obs', processConfiguration(profile, 'obs'));
      if (process.pid === null) {
        const detection = await integrationDetector.detect();
        const detected = detection.applications.obs;
        if (detected.executablePath && detected.workingDirectory) profile = { ...profile, obs: { ...profile.obs, executablePath: detected.executablePath, workingDirectory: detected.workingDirectory } };
        process = await processManager.refresh('obs', processConfiguration(profile, 'obs'));
      }
      const running = process.pid !== null;
      if (running && process.executablePath) profile = { ...profile, obs: { ...profile.obs, executablePath: process.executablePath, workingDirectory: dirname(process.executablePath) } };
      if (!profile.obs.executablePath) throw new Error('没有找到本机的 OBS，请先安装 OBS 或手动选择程序位置');
      // Before touching its configuration or plugin: an OBS we cannot inspect must not get a second instance.
      if (!running) await processManager.assertNoUnverifiableInstance('obs', profile.obs.executablePath);
      const access = processManager.inspectionAccess('obs');
      if (process.pid !== null && process.executablePath && process.startTime && access === null) throw new Error('还没确认 OBS 程序身份，请重新点“一键连接”');
      const commandLine = process.pid !== null && process.executablePath && process.startTime && access !== null
        ? await readObsCommandLine({ pid: process.pid, executablePath: process.executablePath, startTime: process.startTime, access }, identityHelper) : '';
      let targetPid = process.pid;
      const local = await prepareLocalObsConnection({ obs: profile.obs, roamingDirectory: app.getPath('appData'), running, commandLine });
      knownSecrets.add(local.password);
      profile = { ...profile, updatedAt: new Date().toISOString(), obs: { ...profile.obs, connectionMethod: 'automatic', webSocketUrl: local.address } };
      await profileStore.saveCredential(profile.obs.credentialId, local.password);
      await profileStore.saveProfile(profile);
      await logger.record({ level: 'info', category: 'device', device: 'obs', message: '已自动读取本机 OBS 连接配置', details: { address: local.address, source: local.configurationPath, changed: local.changed } });
      if (!running) {
        try { await bridgeSetup.prepare(); }
        catch (error) { await logger.record({ level: 'warning', category: 'device', device: 'obs', message: `OBS 预览组件需要单独修复：${String(error)}` }); }
        const started = await processManager.start('obs', processConfiguration(profile, 'obs'));
        if (started.pid === null) throw new Error('OBS 还没启动');
        targetPid = started.pid;
        await waitForObsEndpoint(local.address, started.pid, profile.obs.startupTimeoutMs);
      }
      const listeningPid = targetPid === null ? null : await findLocalObsPid(local.address);
      if (targetPid !== null && listeningPid === null) throw obsEndpointNotListening(local.address, targetPid);
      if (targetPid === null || listeningPid !== targetPid) throw new Error('OBS 的连接端口和选定的 OBS 程序对不上，请检查是不是同时开了多个 OBS（密码还没发送）');
      const snapshot = await connectObs();
      return localObsConnectionResultSchema.parse({ version: 1, address: local.address, password: local.password, snapshot });
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: `本机 OBS 自动连接失败：${error instanceof Error ? error.message : String(error)}` });
      throw error;
    } finally { localObsConnecting = false; }
  });
  let liveBridgeInstalled = false;
  let liveBridgeInstallation: Promise<'installed' | 'unchanged'> | null = null;
  const ensureLiveBridge = async (): Promise<void> => {
    if (liveBridgeInstalled) return;
    liveBridgeInstallation ??= installObsLiveBridge(app.isPackaged
      ? join(process.resourcesPath, 'obs/tblink-realtime-preview.dll')
      : join(__dirname, '../../../../tools/obs/native-preview/tblink-realtime-preview.dll'));
    try {
      await liveBridgeInstallation;
      liveBridgeInstalled = true;
    } finally {
      liveBridgeInstallation = null;
    }
  };
  let liveAddress: string | null = null;
  let bridgeMaintenance = false;
  let bridgeMaintenanceTask: Promise<void> | null = null;
  const bridgeSetup = new ObsBridgeSetup({
    install: async (allowElevation) => {
      const result = await installObsLiveBridge(app.isPackaged
        ? join(process.resourcesPath, 'obs/tblink-realtime-preview.dll')
        : join(__dirname, '../../../../tools/obs/native-preview/tblink-realtime-preview.dll'),
      allowElevation ? elevateObsPluginInstall : undefined);
      liveBridgeInstalled = true;
      return result === 'installed';
    },
    process: async () => {
      const profile = await requireProfile(profileStore);
      const snapshot = await processManager.refresh('obs', processConfiguration(profile, 'obs'));
      // Plugin maintenance treats "not found" as "not running"; an elevated OBS would still hold the DLL.
      if (snapshot.pid === null && profile.obs.executablePath) await processManager.assertNoUnverifiableInstance('obs', profile.obs.executablePath);
      return snapshot;
    },
    confirm: async (kind, reason) => {
      const decision = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '修复 OBS 组件',
        message: kind === 'restart' ? '需要重启 OBS 来加载组件' : '请先正常退出 OBS，再继续',
        detail: `${reason}\n\n${kind === 'restart' ? '请先保存 OBS 场景。确认后联动台会先检查推流和录像状态，再正常关闭这次由联动台启动的 OBS，安装组件并重新连接。' : '当前的 OBS 不是这次由联动台启动的，联动台不会关闭它。请保存场景并正常退出 OBS，然后点“已退出，继续”，联动台会完成安装、启动和连接。'}${kind === 'external' && processManager.inspectionAccess('obs') === 'limited' ? '\n\n这个 OBS 正以管理员身份运行。联动台不会提权启动程序，修复后会用普通方式打开 OBS；需要管理员身份时，可以之后自己重新打开 OBS 再点“一键连接”，新组件在两种方式下都能用。' : ''}`,
        buttons: [kind === 'restart' ? '保存好了，重启并修复' : '已退出，继续', '取消'], defaultId: 1, cancelId: 1
      });
      return decision.response === 0;
    },
    stop: async () => {
      if (runtimeActive) throw new Error('请先停止播放，再修复 OBS 组件');
      const profile = await requireProfile(profileStore);
      if (obs.getSnapshot().status !== 'connected') await connectObs();
      await processManager.stop('obs', profile.obs.shutdownTimeoutMs);
      await obs.disconnect();
      nativeSeek.reset();
    },
    start: async () => {
      const profile = await requireProfile(profileStore);
      const started = await processManager.start('obs', processConfiguration(profile, 'obs'));
      if (started.pid === null) throw new Error('OBS 启动后没有找到它的进程');
      await waitForObsEndpoint(profile.obs.webSocketUrl, started.pid, profile.obs.startupTimeoutMs);
    },
    connect: async () => {
      if (obs.getSnapshot().status !== 'connected') {
        const snapshot = await connectObs();
        if (snapshot.status !== 'connected') throw new Error('OBS 组件已安装，但 WebSocket 没有连上，请在「设备连接」里检查设置');
      }
    },
    verify: async () => {
      const profile = await requireProfile(profileStore);
      const probe = new ObsLivePreview();
      try { await probe.next(profile.obs.webSocketUrl); }
      finally { probe.close(); }
    }
  });
  handle('link:obs-bridge-repair', async (): Promise<void> => {
    if (runtimeActive) throw new Error('请先停止播放，再修复 OBS 组件');
    if (bridgeMaintenance) throw new Error('正在修复 OBS 组件，请稍等');
    bridgeMaintenance = true;
    livePreview.close(); liveAddress = null; liveBridgeInstalled = false;
    try {
      await logger.record({ level: 'info', category: 'device', device: 'obs', result: 'running', message: '开始检查 OBS 预览组件：安装、连接和画面验证' });
      bridgeMaintenanceTask = bridgeSetup.repair();
      await bridgeMaintenanceTask;
      await logger.record({ level: 'info', category: 'device', device: 'obs', result: 'succeeded', message: 'OBS 组件安装和画面检查都已通过' });
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) });
      throw error;
    } finally { bridgeMaintenance = false; bridgeMaintenanceTask = null; }
  });
  app.on('before-quit', () => livePreview.close());
  handle('link:obs-live-frame', async () => {
    if (bridgeMaintenanceTask) await bridgeMaintenanceTask;
    if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 未连接');
    try {
      await ensureLiveBridge();
      liveAddress ??= (await requireProfile(profileStore)).obs.webSocketUrl;
      return await livePreview.next(liveAddress);
    }
    catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) });
      throw error;
    }
  });
  handle('link:window-visible', () => Boolean(mainWindow?.isVisible() && !mainWindow.isMinimized()));
  handle('link:obs-live-close', () => { livePreview.close(); liveAddress = null; });
  obs.subscribe((state) => { if (state.status !== 'connected') { livePreview.close(); liveAddress = null; } });
  handle('link:obs-source-screenshot', (_event, payloadValue: unknown): Promise<string> => {
    const payload = linkObsSourcePreviewPayloadSchema.parse(payloadValue);
    return obs.getSourceScreenshot(payload.sourceName, payload.width, payload.height);
  });
  handle('link:obs-preview-script', async () => {
    if (!obs.editorPreview) throw new Error('本机 OBS 预览服务不可用');
    const path = await obs.editorPreview.exportScript();
    shell.showItemInFolder(path);
    return path;
  });
  handle('link:obs-preview-status', () => {
    if (!obs.editorPreview) throw new Error('本机 OBS 预览服务不可用');
    return obs.editorPreview.getStatus();
  });
  handle('link:obs-execute', (_event, actionValue: unknown) => obs.execute(linkActionSchema.parse(actionValue)));
  handle('link:obs-program-source-enabled', (_event, value: unknown) => {
    const request = z.object({ sourceName: z.string().min(1), enabled: z.boolean() }).strict().parse(value);
    return obs.setSourceEnabledInProgramScene(request.sourceName, request.enabled);
  });
  handle('link:obs-execute-managed-media', async (_event, payloadValue: unknown) => {
    const payload = linkManagedMediaExecutionPayloadSchema.parse(payloadValue);
    await projectAccess.assetFiles(payload.projectPath, [payload.event.relativePath]);
    const absolutePath = projectService.resolveMediaAsset(payload.projectPath, payload.event.relativePath);
    const file = await stat(absolutePath);
    if (!file.isFile()) throw new Error(`找不到媒体文件：${absolutePath}`);
    await obs.executeManagedMediaEvent(payload.event, absolutePath);
  });
  handle('link:process-start', async (_event, idValue: unknown): Promise<LinkProcessSnapshot> => {
    const id = linkExternalApplicationIdSchema.parse(idValue);
    const profile = await requireProfile(profileStore);
    // Control connections must not depend on preview plugin maintenance.
    if (id === 'obs') {
      const current = await processManager.refresh(id, processConfiguration(profile, id));
      if (current.pid !== null) return current;
      if (profile.obs.executablePath) await processManager.assertNoUnverifiableInstance('obs', profile.obs.executablePath);
      try { await bridgeSetup.prepare(); }
      catch (error) {
        await logger.record({ level: 'warning', category: 'device', device: 'obs', result: 'failed',
          message: `OBS 预览组件还没准备好，先继续连接 OBS；预览需要单独修复：${String(error)}` });
      }
    }
    const started = await processManager.start(id, processConfiguration(profile, id));
    if (id === 'obs' && started.owned && started.pid !== null) await waitForObsEndpoint(profile.obs.webSocketUrl, started.pid, profile.obs.startupTimeoutMs);
    return started;
  });
  handle('link:process-refresh', async (_event, idValue: unknown) => {
    const id = linkExternalApplicationIdSchema.parse(idValue);
    const profile = await requireProfile(profileStore);
    return processManager.refresh(id, processConfiguration(profile, id));
  });
  handle('link:process-stop', async (_event, idValue: unknown) => {
    const id = linkExternalApplicationIdSchema.parse(idValue);
    const profile = await requireProfile(profileStore);
    const configuration = processConfiguration(profile, id);
    return processManager.stop(id, configuration.shutdownTimeoutMs);
  });
  handle('link:process-snapshots', async () => {
    const profile = await profileStore.loadProfile();
    const ids = ['obs', 'p1', 'ma2', 'ma3d'] as const;
    if (!profile) return ids.map((id) => processManager.getSnapshot(id));
    return Promise.all(ids.map((id) => profile[id]
      ? processManager.refresh(id, processConfiguration(profile, id))
      : Promise.resolve(processManager.getSnapshot(id))));
  });
  // Refused entries reach the log through the IPC failure entry, once per 30 seconds with a repeat count.
  const windowLogRate = new WindowLogRate();
  handle('link:log-record', (_event, entryValue: unknown) => { windowLogRate.take(); return logger.record(parseLogRecord(entryValue)); });
  handle('link:log-query', (_event, filterValue: unknown) => logger.query(parseLogFilter(filterValue)));
  handle('link:log-open-folder', async () => {
    const directory = join(app.getPath('userData'), 'link-logs');
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(`无法打开日志文件夹：${error}`);
  });
  handle('link:log-export', async (_event, rangeValue: unknown) => {
    const range = linkLogExportRangeSchema.parse(rangeValue ?? { days: 7 });
    const result = await dialog.showSaveDialog(mainWindow!, { title: '导出运行日志',
      defaultPath: `${app.getName()}-日志-${new Date().toISOString().replaceAll(':', '-')}.txt`,
      filters: [{ name: '文本日志', extensions: ['txt'] }] });
    if (result.canceled || !result.filePath) return null;
    await logger.exportText(result.filePath, buildIdentityLine(), range);
    return result.filePath;
  });
  /** What the main process knows about this machine and run, added to every diagnostic package. */
  const diagnosticEnvironment = async (): Promise<Record<string, unknown>> => {
    const license = await getLicenseStatus().then(status => ({ ...licenseLogDetails(status), message: status.message }),
      (error: unknown) => ({ error: `授权状态读取失败：${error instanceof Error ? error.message : String(error)}` }));
    const crashDumps = await recentCrashDumps(app.getPath('crashDumps')).catch((error: unknown) => `崩溃转储目录读取失败：${error instanceof Error ? error.message : String(error)}`);
    return {
      appVersion: buildVersion, ...buildIdentity(), packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      osRelease: release(), cpu: cpus()[0]?.model ?? '未知', logicalProcessors: cpus().length,
      totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), uptimeSeconds: Math.round(process.uptime()), versions: process.versions,
      gpuFeatures: app.getGPUFeatureStatus(), processes: app.getAppMetrics(),
      obs: obs.getSnapshot(), ma2: ma2Network.status(), runtimeActive, player: nativePlayer?.status ?? null,
      // Which networks this computer is on, for a console that cannot be reached; hardware addresses are left out.
      networkAdapters: Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => ({ name, address: entry.cidr ?? entry.address }))),
      license, update: updateManager.getStatus(), logSessionId: logger.sessionId,
      crashDumps, crashDumpContentsIncluded: false, collectedAt: new Date().toISOString()
    };
  };
  const feedbackSummary = () => {
    const obsSnapshot = obs.getSnapshot(), ma2Status = ma2Network.status();
    return feedbackEnvironment({ windowsRelease: release(), arch: process.arch, cpu: cpus()[0]?.model ?? '未知', totalMemoryBytes: totalmem(),
      obs: { status: obsSnapshot.status, obsVersion: obsSnapshot.obsVersion }, ma2: { state: ma2Status.state, version: ma2Status.version },
      runtimeActive, playerStatus: nativePlayer?.status?.status ?? null });
  };
  const writeDiagnostic = async (path: string, context: Readonly<Record<string, unknown>>, days: 1 | 7 | 30): Promise<void> => {
    await logger.exportDiagnosticPackage(path, { ...context, environment: await diagnosticEnvironment() }, { days });
  };
  const saveDiagnosticDialog = async (title: string): Promise<string | null> => {
    const result = await dialog.showSaveDialog(mainWindow!, { title,
      defaultPath: `${app.getName()}-诊断-${new Date().toISOString().replaceAll(':', '-')}.tbdiag.gz`,
      filters: [{ name: '团播联动台诊断包', extensions: ['tbdiag.gz'] }] });
    return result.canceled || !result.filePath ? null : result.filePath;
  };
  handle('link:diagnostic-export', async (_event, contextValue: unknown, rangeValue: unknown) => {
    const context = linkDiagnosticContextSchema.parse(contextValue);
    const range = linkLogExportRangeSchema.parse(rangeValue ?? { days: 7 });
    const path = await saveDiagnosticDialog('导出诊断包');
    if (!path) return null;
    await writeDiagnostic(path, context, range.days);
    await logger.record({ level: 'info', category: 'operator', device: '诊断', message: `已导出诊断包（最近 ${range.days} 天）：${path}`, result: 'succeeded' });
    return path;
  });
  // A report goes out even when the license cannot be read: that machine is the one most likely to need help.
  const unreadableIdentity = (error: unknown): FeedbackIdentity =>
    ({ machineCode: null, license: null, licensed: false, licenseSummary: `读取本机授权失败：${error instanceof Error ? error.message : String(error)}`, version: buildVersion });
  const licensedFeedbackIdentity = async (): Promise<FeedbackIdentity> => {
    try {
      const service = await getLicenseService(), status = await service.status();
      return { machineCode: status.machineCode, license: await service.signedLicense(), licensed: status.state === 'active',
        licenseSummary: `${licenseStateLabel[status.state]}${status.state === 'active' ? '' : `：${status.message}`}`, version: buildVersion };
    } catch (error) {
      return unreadableIdentity(error);
    }
  };
  const localTestFeedbackIdentity = async (): Promise<FeedbackIdentity> => {
    try {
      return { machineCode: (await getLocalTestStatus()).machineCode, license: null, licensed: false, licenseSummary: '本地测试模式（不校验授权）', version: buildVersion };
    } catch (error) {
      return unreadableIdentity(error);
    }
  };
  // Keep the local test branch out of any try block: Rollup keeps whatever a try block references, and a release
  // bundle that still carries the local test license is refused at packaging (scripts/require-release-build.mjs).
  const feedbackIdentity = (): Promise<FeedbackIdentity> => localTestAccess ? localTestFeedbackIdentity() : licensedFeedbackIdentity();
  const feedback = new FeedbackService({
    serverUrl: licenseConfig.serverUrl,
    identity: feedbackIdentity,
    environment: feedbackSummary, writeDiagnostic, temporaryDirectory: app.getPath('temp'),
    log: entry => logger.record(entry)
  });
  handle('link:feedback-submit', (_event, draftValue: unknown) => feedback.submit(linkFeedbackDraftSchema.parse(draftValue)));
  handle('link:feedback-save', async (_event, draftValue: unknown): Promise<LinkFeedbackResult> => {
    const draft = linkFeedbackDraftSchema.parse(draftValue);
    const path = await saveDiagnosticDialog('把问题反馈另存为诊断包');
    if (!path) return { outcome: 'cancelled' };
    const identity = await feedbackIdentity();
    await writeDiagnostic(path, feedbackContext(draft, { ...feedbackSummary(), license: identity.licenseSummary.slice(0, 160) }), feedbackRange(draft.occurredAt, Date.now()));
    await logger.record({ level: 'info', category: 'operator', device: '问题反馈', result: 'succeeded',
      message: `问题反馈已另存为文件（${feedbackCategoryLabels[draft.category]}，发生于 ${new Date(draft.occurredAt).toLocaleString('zh-CN', { hour12: false })}）：${path}`,
      details: { category: draft.category, occurredAt: draft.occurredAt, description: draft.description, path } });
    return { outcome: 'saved', path };
  });
}

/** Links stop resolving once their project is closed or replaced (ProjectAccess.assetPath). */
function registerAssetProtocol(access: Pick<ProjectAccess, 'assetPath'>): void {
  protocol.handle('tblink-asset', async (request) => {
    try { await authorizeOutput(); }
    catch (error) { return new Response(error instanceof Error ? error.message : '授权校验失败', { status: 403 }); }
    const url = new URL(request.url);
    const token = url.pathname.slice(1);
    const path = access.assetPath(token);
    if (!path) return new Response('Asset token not found', { status: 404 });
    return assetResponse(path, request, mimeType(path));
  });
}

/** Resolves true once `finish` ran, false when the operator returned to the app. */
async function runQuitFlow(profileStore: SecureProfileStore, processManager: ExternalProcessManager, finish: () => void): Promise<boolean> {
  recordQuitStep('退出前停止灯光试听');
  try { await stopAuditionForQuit?.(); }
  catch (error) {
    // Operator decision 2026-10-19: a console that cannot confirm Off (e.g. disconnected)
    // must not keep the console app open for good; the operator chooses.
    const reason = error instanceof Error ? error.message : String(error);
    recordQuitStep('灯光试听停止未完成', { error: reason });
    const options = { type: 'warning' as const, title: '灯光试听没能停止', message: '退出前没能确认控台已经关掉这次试听。',
      detail: `${reason}\n\n如果仍然退出，控台上可能还保持着当前的灯光，请到控台手动处理。`, buttons: ['返回软件', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true };
    const choice = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (choice.response !== 1) { recordQuitStep('返回软件处理灯光试听'); return false; }
    recordQuitStep('操作员选择仍然退出', { error: reason });
  }
  recordQuitStep('退出前关闭音频和画面');
  await closeNativePlayer();
  const owned = (['p1', 'ma3d', 'ma2', 'obs'] as const)
    .map((id) => processManager.getSnapshot(id))
    .filter((snapshot) => snapshot.owned && snapshot.pid !== null);
  if (owned.length === 0) {
    recordQuitStep('退出前关闭音乐分析');
    await automaticMusic?.close();
    await midiPorts?.dispose();
    if (discardOnQuit) await discardOpenDocumentRecovery();
    allowWindowClose = true;
    settleRepeatedLogs();
    recordQuitStep('退出流程完成');
    finish();
    return true;
  }
  const closeIds: ExternalApplicationId[] = [];
  for (const snapshot of owned) {
    recordQuitStep('确认外部程序', { id: snapshot.id, pid: snapshot.pid });
    const decision = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: '逐项确认外部程序',
      message: `${snapshot.id} 是这次由联动台启动的`,
      detail: `PID ${String(snapshot.pid)}\n${snapshot.executablePath ?? '路径未知'}\n\n退出联动台时要怎么处理这个程序？`,
      buttons: ['取消退出', '保留它，继续', '正常关闭它'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (decision.response === 0) return false;
    if (decision.response === 2) closeIds.push(snapshot.id);
  }
  if (closeIds.length > 0) {
    const profile = await requireProfile(profileStore);
    const failures: string[] = [];
    for (const id of ['p1', 'ma3d', 'ma2', 'obs'] as const) {
      if (!closeIds.includes(id)) continue;
      const snapshot = processManager.getSnapshot(id);
      if (!snapshot.owned || snapshot.pid === null) continue;
      try {
        await processManager.stop(id, processConfiguration(profile, id).shutdownTimeoutMs);
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: '有些外部程序还在运行',
        message: '以下程序没有关闭（联动台不会强制结束程序）：',
        detail: failures.join('\n'),
        buttons: ['确认并退出']
      });
    }
  }
  recordQuitStep('退出前关闭音乐分析');
  await automaticMusic?.close();
  await midiPorts?.dispose();
  if (discardOnQuit) await discardOpenDocumentRecovery();
  allowWindowClose = true;
  settleRepeatedLogs();
  recordQuitStep('退出流程完成');
  finish();
  return true;
}

/** After 不保存: the open document's recovery copy is removed. A failure is logged and never blocks
 * the action; the copy is then offered again the next time the project opens. */
async function discardOpenDocumentRecovery(): Promise<void> {
  const { projectPath, projectId } = documentState;
  if (!recoveryCopies || !projectId) return;
  try {
    await recoveryCopies.discard({ version: 1, projectPath, projectId });
    recordQuitStep('已按“不保存”清除恢复副本', { projectPath });
  } catch (error) {
    recordQuitStep('恢复副本没能清除，下次打开工程时还会提示', { projectPath, error: error instanceof Error ? error.message : String(error) });
  }
}

function recoveryPrompt(offer: RecoveryOffer): Electron.MessageBoxOptions {
  const time = (value: Date): string => value.toLocaleString('zh-CN', { hour12: false });
  const detail = offer.kind === 'file'
    ? [`位置：${offer.projectPath}`, ...offer.movedFrom === undefined ? [] : [`原位置：${offer.movedFrom}（工程文件已移到当前位置）`],
      `未保存改动的最后修改：${time(offer.copySavedAt)}`, `工程文件上次保存：${time(offer.fileModifiedAt)}`, '',
      '恢复：载入这些改动，保存后才写入工程文件。', '丢弃：把恢复副本移到回收站，打开工程文件里的内容。',
      ...offer.copySavedAt < offer.fileModifiedAt ? ['', '恢复副本比工程文件旧，工程文件可能在别处改过，请确认后再选择。'] : []]
    : [`未保存改动的最后修改：${time(offer.copySavedAt)}`, '', '恢复：打开这些内容，保存时选择位置。', '丢弃：把恢复副本移到回收站。'];
  return { type: 'question', title: '发现未保存的改动', noLink: true, buttons: ['恢复', '丢弃'], defaultId: 0, cancelId: 0,
    message: offer.kind === 'file' ? `工程「${offer.name}」有未保存的改动。` : `未命名工程「${offer.name}」有未保存的改动。`, detail: detail.join('\n') };
}

/** Each quit stage with the flags that gate it, so a hang names its stage. */
/** Repeats merged into a summary still owed are written before the app goes. */
function settleRepeatedLogs(): void {
  void ipcLogger?.settleRepeats().catch((error: unknown) => console.error('合并的重复日志未能写入', error));
}

function recordQuitStep(step: string, details: Record<string, unknown> = {}): void {
  void ipcLogger?.record({ level: 'info', category: 'system', device: '退出流程', message: step,
    details: { runtimeActive, nativePlayback: nativePlaybackActive(), documentDirty: documentState.dirty, allowWindowClose, quitFlowRunning,
      windows: BrowserWindow.getAllWindows().length, ...details } })
    .catch((error: unknown) => console.error('退出流程日志未能写入', error));
}

let runtimeExitWarningOpen = false;
function showRuntimeActiveExitWarning(): void {
  recordQuitStep('联动还没停止，暂不退出');
  if (runtimeExitWarningOpen) return;
  runtimeExitWarningOpen = true;
  const options = {
    type: 'warning' as const,
    title: '联动还没停止',
    message: '音频或联动还在运行。',
    detail: '请回到播放器停止播放。如果还有画面联动，等相关来源清理完再退出。',
    buttons: ['返回软件'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  // Keep native status and stop IPC responsive while the warning is visible.
  const warning = mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
  void warning.catch((error: unknown) => console.error('显示运行退出提示失败', error)).finally(() => { runtimeExitWarningOpen = false; });
}

function processConfiguration(profile: IntegrationProfile, id: ExternalApplicationId) {
  if (id === 'obs') {
    const root = join(dirname(profile.obs.executablePath), '../..');
    const portable = profile.obs.arguments.some((argument) => argument === '--portable' || argument === '-p')
      || existsSync(join(root, 'portable_mode')) || existsSync(join(root, 'obs_portable_mode'));
    if (!portable) return profile.obs;
    if (!process.env.ProgramData) throw new Error('找不到 OBS 组件所在的文件夹');
    const plugins = join(process.env.ProgramData, 'obs-studio/plugins');
    return { ...profile.obs, environment: {
      OBS_PLUGINS_PATH: join(plugins, 'tblink-realtime-preview/bin/64bit').replaceAll('\\', '/'),
      OBS_PLUGINS_DATA_PATH: plugins.replaceAll('\\', '/')
    } };
  }
  const configuration = profile[id];
  if (!configuration) throw new Error(`${id === 'ma2' ? 'MA2 onPC' : id === 'ma3d' ? 'MA 3D' : 'P1'} 的程序路径还没设置，请在设备设置里选择程序`);
  return configuration;
}

async function requireProfile(store: SecureProfileStore) {
  const profile = await store.loadProfile();
  if (!profile) throw new Error('这台电脑还没有设备设置');
  return profile;
}

function handle<Arguments extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Arguments) => Result | Promise<Result>,
  authorization: 'wrapper' | 'listener' = 'wrapper'
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args: Arguments) => {
    const started = performance.now();
    try {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('拒绝非主窗口的 IPC 请求');
      // Native playback captures cancellation before awaiting authorization. Its
      // request adapter performs the same license check before calling the service.
      if (authorization === 'wrapper') await authorizeProduct(channel, args[0]);
      return await listener(event, ...args);
    } catch (error) {
      recordIpcFailure(channel, performance.now() - started, error);
      throw error;
    }
  });
}

const ipcFailureWindowMs = 30_000;
const ipcFailures = new Map<string, { loggedAt: number; suppressed: number }>();

/** The renderer only receives translated copy; the original stays in the run log.
 * Polled channels repeat the same failure, so one entry per cause per window. */
function recordIpcFailure(channel: string, elapsedMs: number, error: unknown): void {
  const technicalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!ipcLogger) { console.error(`IPC ${channel} 失败（运行日志尚未就绪）`, error); return; }
  const key = `${channel}\n${technicalError}`, now = Date.now(), previous = ipcFailures.get(key);
  if (previous && now - previous.loggedAt < ipcFailureWindowMs) { previous.suppressed++; return; }
  ipcFailures.set(key, { loggedAt: now, suppressed: 0 });
  void ipcLogger.record({ level: 'error', category: 'system', device: 'IPC', message: `${channel} 失败：${technicalError.split('\n')[0]!.slice(0, 300)}`,
    result: 'failed', details: { channel, elapsedMs: Math.round(elapsedMs), technicalError: technicalError.slice(0, 8000),
      ...(previous ? { repeatsSinceLastEntry: previous.suppressed } : {}) } })
    .catch((logError: unknown) => console.error(`IPC ${channel} 失败日志未能写入`, logError, error));
}

function sendToRenderer(channel: string, payload: unknown): void {
  const window = mainWindow;
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function safeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return sanitized || '未命名工程';
}

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.flac') return 'audio/flac';
  if (extension === '.ogg') return 'audio/ogg';
  if (extension === '.m4a' || extension === '.aac') return 'audio/mp4';
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function parseLogRecord(
  value: unknown
): Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'> {
  const entry = linkLogRecordSchema.parse(value);
  return {
    level: entry.level,
    category: entry.category,
    message: entry.message,
    ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}),
    ...(entry.itemId !== undefined ? { itemId: entry.itemId } : {}),
    ...(entry.cueId !== undefined ? { cueId: entry.cueId } : {}),
    ...(entry.actionId !== undefined ? { actionId: entry.actionId } : {}),
    ...(entry.executionId !== undefined ? { executionId: entry.executionId } : {}),
    ...(entry.device !== undefined ? { device: entry.device } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.details !== undefined ? { details: entry.details } : {})
  };
}

function parseLogFilter(value: unknown): LinkLogFilter {
  const filter = linkLogFilterSchema.parse(value ?? {});
  return {
    ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
    ...(filter.itemId !== undefined ? { itemId: filter.itemId } : {}),
    ...(filter.cueId !== undefined ? { cueId: filter.cueId } : {}),
    ...(filter.device !== undefined ? { device: filter.device } : {}),
    ...(filter.result !== undefined ? { result: filter.result } : {}),
    ...(filter.limit !== undefined ? { limit: filter.limit } : {})
  };
}

void bootstrap().catch((error: unknown) => {
  dialog.showErrorBox('团播联动台启动失败', error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});
