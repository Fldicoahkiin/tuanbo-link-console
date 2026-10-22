import { ma2LayoutDirectoryRequestSchema, ma2LayoutUpdateRequestSchema } from '@tb/schema';
import { projectArchiveSettingsActionSchema } from '@tb/schema';
import { ma2ExecutorPageRequestSchema, ma2ExecutorUpdateRequestSchema, ma2ExecutorInputSchema } from '@tb/schema';
import { ma2SongCheckRequestSchema, ma2SongSyncRequestSchema } from '@tb/schema';
import { materialSceneTargets } from '@tb/core/link';
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
import { internalDistribution, internalDistributionStatus } from './link/internal-distribution';
import licensePublicKeys from './link/license-public-keys.json';
import licenseConfig from './link/license-config.json';
import { LicenseAccess, needsProductLicense } from './link/license-access';
import { licenseRequestSchema } from '@tb/schema';
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
import { ma2AutoBindRequestSchema } from '@tb/schema';
import { prepareMa2AutoBindings } from './link/ma2-auto-bind-service';
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
import { Ma2DiscoveryService } from './link/ma2-discovery';
import { Ma2NetworkSetup } from './link/ma2-network-setup';
import { ma2NetworkSetupRequestSchema } from '@tb/schema';
import { Ma2NetworkManager } from './link/ma2-network-manager';
import { ma2PlaybackRequestSchema, ma2NetworkSaveSchema, ma2LiveConnectSchema, ma2LiveInputSchema, ma2LiveRequestSchema } from '@tb/schema';
import ma2PluginLua from '../../../../tools/ma2/tblink_bridge.lua?raw';
import ma2PluginXml from '../../../../tools/ma2/tblink_bridge.xml?raw';
import ma2PluginInstructions from '../../../../tools/ma2/README.md?raw';
import { compareMa2LightingReadback } from './link/ma2-comparison';
import { convertMa2Snapshot } from './link/ma2-timecode-conversion';
import { readFile, stat, statfs, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { assetResponse } from './link/asset-response';
import { ProjectDocumentService } from './link/project-document-service';
import { ProjectArchiveSettingsStore, projectArchives } from './link/project-archives';
import { cpus, release, totalmem, freemem } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { projectDocumentTextSchema } from '@tb/schema';
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
  linkDocumentDirtySchema,
  linkRuntimeActiveSchema,
  linkInternalAudioCaptureSchema,
  linkExternalApplicationIdSchema,
  linkFilePathSchema,
  linkIntegrationProfileSavePayloadSchema,
  linkLogFilterSchema,
  linkLogRecordSchema,
  linkMediaAssetImportPayloadSchema,
  linkMediaAssetResolvePayloadSchema,
  linkMediaPreviewPayloadSchema,
  linkMediaInspectionPayloadSchema,
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
import { LinkProjectService } from './link/link-project-service';
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
import { SecureProfileStore } from './link/secure-profile-store';
import { WindowsIntegrationDetector } from './link/windows-integration-detector';
import { LoopMidiService } from './link/loop-midi-service';
import { loopMidiActionSchema, loopMidiStatusSchema } from '@tb/schema';
import { LinkUpdateManager } from './link/update-manager';
import desktopPackage from '../../package.json';
import ffmpegPath from 'ffmpeg-static';
import { NativeAudioCache } from './link/native-audio-cache';
import { NativePlayerService } from './link/native-player-service';
import { NativeMidiCheckService } from './link/native-midi-check';
import { NativePlayerUiPublisher } from './link/native-player-ui-publisher';
import { NativeProgramHost } from './link/native-program-host';
import { NativeProgramService } from './link/native-program-service';
import { NativePlaybackRequests } from './link/native-playback-requests';
import { NativeObsHost } from './link/native-obs-host';
import { NativeObsRequests } from './link/native-obs-requests';
import { NativeObsPreloadPool } from './link/native-obs-preload';
import { createNativeObsOutputs } from './link/native-obs-outputs';
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
if (internalDistribution) app.setName(internalDistribution.channel === 'portable-test' ? '团播联动台功能测试版' : '团播联动台内测');
crashReporter.start({ uploadToServer: false });

let mainWindow: BrowserWindow | null = null;
let documentDirty = false;
let runtimeActive = false;
let releaseRendererRuntime: () => Promise<void> = () => Promise.resolve();
let automaticMusic: AutomaticMusicRuntime | null = null;
let authorizeOutput: () => Promise<void> = () => Promise.reject(new Error('授权服务尚未就绪'));
let authorizeProduct: (channel: string, value: unknown) => Promise<void> = () => Promise.reject(new Error('授权服务尚未就绪'));
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

async function closeNativePlayer(): Promise<void> {
  await nativeProgram?.close();
  const player = nativePlayer;
  nativePlayerShutdown ??= (async () => {
    const results = await Promise.allSettled([player?.close(), nativeObs?.stop(), nativeObsPreload?.close(), musicMonitor?.stop()]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (failures.length) throw new AggregateError(failures, '正式音频或画面关闭未完成，请查看日志');
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
const midiHealth = new WindowsMidiHealth(() => probeWindowsMidi(midiProbeExecutable(app.isPackaged ? process.resourcesPath : undefined)));

const projectService = new LinkProjectService();
const projectDocuments = new ProjectDocumentService();
const p1ProjectService = new P1ProjectService(projectService);
const mediaMetadataProbe = new MediaMetadataProbe();
const mediaPreviewService = new MediaPreviewService(projectService);
const assetTokens = new Map<string, string>();
const knownSecrets = new Set<string>();

async function bootstrap(): Promise<void> {
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
  const processManager = new ExternalProcessManager(new WindowsProcessTools(), obs);
  const integrationDetector = new WindowsIntegrationDetector();
  const logger = new LinkRunLogger(join(app.getPath('userData'), 'link-logs'), () => [...knownSecrets]);
  ipcLogger = logger;
  await logger.record({ level: 'info', category: 'system', message: `团播联动台 ${desktopPackage.version} 已启动`,
    details: { appVersion: desktopPackage.version, packaged: app.isPackaged, platform: process.platform, arch: process.arch, windows: release(), versions: process.versions } })
    .catch((error: unknown) => dialog.showErrorBox('运行日志无法写入', error instanceof Error ? error.message : String(error)));
  app.on('child-process-gone', (_event, details) => {
    void logger.record({ level: 'error', category: 'device', device: 'Electron',
      message: `Electron ${details.type} 进程退出：${details.reason}，退出码 ${details.exitCode}`,
      result: 'failed' }).catch((error: unknown) => console.error('记录 Electron 子进程崩溃失败', error));
  });
  const updateManager = new LinkUpdateManager(
    desktopPackage.version,
    app.isPackaged,
    (status) => sendToRenderer('link:update-status', status),
    undefined,
    internalDistribution ? '' : undefined
  );
  registerAssetProtocol();
  registerIpc(profileStore, obs, processManager, logger, integrationDetector, updateManager);
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
  restoreMainWindow = () => {
    if (mainWindow || quitFlowRunning) return;
    allowWindowClose = false;
    createMainWindow(obs, logger);
  };

  obs.subscribe((snapshot) => sendToRenderer('link:obs-status', snapshot));
  obs.subscribeInventoryChanges(() => sendToRenderer('link:obs-inventory-changed', null));
  processManager.subscribe((snapshot) => sendToRenderer('link:process-status', snapshot));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) restoreMainWindow?.();
  });
  app.on('window-all-closed', () => {
    recordQuitStep('所有窗口已关闭');
    if (process.platform !== 'darwin' && (allowWindowClose || !quitFlowRunning)) app.quit();
  });
  app.on('before-quit', (event) => {
    recordQuitStep('收到退出请求');
    if (allowWindowClose || quitFlowRunning) return;
    event.preventDefault();
    if (runtimeActive || nativePlaybackActive()) {
      showRuntimeActiveExitWarning();
      return;
    }
    quitFlowRunning = true;
    void obs.sources.discardPending().then(() => runQuitFlow(profileStore, processManager))
      .catch((error: unknown) => {
        recordQuitStep('退出流程失败', { error: error instanceof Error ? error.message : String(error) });
        dialog.showErrorBox('退出流程失败', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        quitFlowRunning = false;
        if (allowWindowClose && BrowserWindow.getAllWindows().length === 0) app.quit();
      });
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
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void closeNativePlayer().then(() => releaseRendererRuntime()).catch((error: unknown) => {
      void logger.record({ level: 'error', category: 'device', device: '正式音频', message: `界面退出后停止音频失败：${String(error)}`, result: 'failed' })
        .catch((loggingError: unknown) => console.error('记录音频停止失败', loggingError));
    });
    void logger.record({ level: 'error', category: 'device', device: 'Electron',
      message: `Electron 界面进程退出：${details.reason}，退出码 ${details.exitCode}；故障转储目录：${app.getPath('crashDumps')}`,
      result: 'failed' }).catch((error: unknown) => console.error('记录 Electron 界面崩溃失败', error));
  });
  mainWindow.on('unresponsive', () => {
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
      if (runtimeActive || documentDirty) {
        dialog.showMessageBoxSync(mainWindow!, {
          type: 'info', title: '刷新开发界面',
          message: runtimeActive ? '停止播放后再按 Alt+R 刷新。' : '保存工程后再按 Alt+R 刷新。',
          buttons: ['知道了'], noLink: true
        });
        return;
      }
      void obs.sources.discardPending().then(() => mainWindow?.webContents.reload()).catch((error: unknown) => dialog.showErrorBox('刷新失败', error instanceof Error ? error.message : String(error)));
    });
  }

  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    // Chromium requires the audio-device visibility check to enumerate output
    // endpoints. Actual capture requests remain denied below.
    // MIDI must pass the asynchronous, isolated driver probe below. Granting it
    // here would let Chromium enter a stalled Windows MIDI service directly.
    return permission === 'media' && details.mediaType === 'audio';
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'midi' || permission === 'midiSysex') {
      void authorizeOutput().then(() => midiHealth.check()).then((result) => callback(result === 'ready'), (error: unknown) => {
        console.error('MIDI 检测组件失败', error);
        callback(false);
      });
      return;
    }
    callback(permission === 'speaker-selection');
  });
  mainWindow.on('close', (event) => {
    recordQuitStep('窗口关闭请求');
    if (allowWindowClose) return;
    if (runtimeActive || nativePlaybackActive()) {
      event.preventDefault();
      showRuntimeActiveExitWarning();
      return;
    }
    if (documentDirty) {
      const response = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        title: '工程尚未保存',
        message: '当前工程包含未保存修改。',
        detail: '返回联动台保存工程，或明确放弃本次修改。',
        buttons: ['返回工程', '放弃修改并退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (response === 0) {
        event.preventDefault();
        return;
      }
      // Keep the unsaved mark: the quit flow may still be cancelled (lighting
      // audition or an external program), and the edits are then still here.
      // A completed quit closes the window with allowWindowClose set.
    }
    event.preventDefault();
    app.quit();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void mainWindow.loadURL(rendererUrl);
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
  const nativeSeek = new ObsNativeSeek();
  const programObsListeners = new Set<(status: import('@tb/schema').NativeObsStatus) => void>();
  const obsPreload = new NativeObsPreloadPool({
    authorize: async request => {
      await authorizeProduct('link:native-obs-prepare', request);
      if (nativePlaybackActive() || nativeObs?.status && !['stopped', 'failed'].includes(nativeObs.status.state)) throw new Error('播放或画面会话活动时不能预备另一个节目');
      await nativeObs?.stop();
      if (nativePlaybackActive()) throw new Error('音频已开始准备，不能另行启动节目预备');
    },
    create: (request, positionMs) => createNativeObsOutputs(request, { obs, projects: projectService, media: mediaPreviewService,
      profiles: profileStore, seek: nativeSeek, logger,
      logFailure: error => {
        if (nativeObs?.status?.sessionId === request.sessionId) nativeObs.disconnect(error.message);
        else console.error('已结束画面会话的运行日志未能落盘', error);
      },
      audioIdentity: () => { if (!nativePlayer) throw new Error('正式音频尚未准备'); return nativePlayer.audioCaptureIdentity; } }, positionMs)
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
        itemId: request.nextFiles.snapshot.item.id, message: decoderPrepared ? '下一节目画面预备完成' : '下一节目文件预备完成，共用来源等待交接', result: 'succeeded',
        details: { elapsedMs: performance.now() - started, decoderPrepared } });
    },
    changed: status => { sendToRenderer('link:native-obs-status', status); for (const listener of programObsListeners) listener(status); },
    error: message => { void logger.record({ level: 'error', category: 'device', device: '后台画面', message, result: 'failed',
      details: { requests: obs.getRequestDiagnostics() } })
      .catch((error: unknown) => console.error('后台画面日志写入失败', error)); }
  });
  const obsRequests = new NativeObsRequests(nativeObs, value => authorizeProduct('link:native-obs-prepare', value));
  handle('link:native-obs-preload', (_event, value: unknown) => obsPreload.preload(value), 'listener');
  handle('link:native-obs-preload-cancel', (_event, value: import('@tb/schema').NativeObsStop) => obsPreload.cancel(value));
  handle('link:native-obs-prepare', (_event, value: unknown) => obsRequests.prepare(value), 'listener');
  handle('link:native-obs-stop', (_event, value: unknown) => obsRequests.stop(value));
  handle('link:native-obs-status', () => nativeObs?.status ?? null);
  obs.subscribe(state => { if (state.status !== 'connected') {
    nativeObs?.disconnect(state.error || 'OBS 已断开');
    void obsPreload.close().catch((error: unknown) => { void logger.record({ level: 'error', category: 'device', device: '后台画面', message: `关闭节目预备失败：${String(error)}`, result: 'failed' })
      .catch((failure: unknown) => console.error('节目预备清理日志写入失败', failure)); });
  } });
  const player = (): NativePlayerService => {
    if (nativePlayerShutdown) throw new Error('正式音频引擎正在关闭或关闭失败，请查看运行日志');
    if (!nativePlayer) {
      if (!ffmpegPath) throw new Error('FFmpeg 音频解码组件未安装');
      let lastClockBoundary = '';
      const measured = (phase: string, elapsedMs: number): void => { void logger.record({ level: 'info', category: 'system', device: '正式音频', message: `正式音频准备：${phase}`, details: { elapsedMs } })
        .catch((error: unknown) => console.error('正式音频计时日志写入失败', error)); };
      nativePlayer = new NativePlayerService({
        checkDeviceHealth: async () => {
          const result = await midiHealth.check();
          if (result !== 'ready') throw new Error(midiHealthMessage(result));
        },
        executable: app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe')
          : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe'),
        cache: new NativeAudioCache(join(app.getPath('userData'), 'native-audio-streams'), ffmpegPath.replace('app.asar', 'app.asar.unpacked'), undefined, undefined, measured),
        resolveAudio: (projectPath, relativePath) => projectService.resolveReferenceAudio(projectPath, relativePath),
        changed: (status, qpc100ns) => {
          nativeObs?.observe(status, qpc100ns); nativeProgramHost?.observe(status, qpc100ns); nativePlayerUi.publish(status);
          if (qpc100ns && qpc100ns !== '0' && (status.status === 'playing' || status.status === 'ended')) {
            const boundary = `${status.sessionId}:${status.generation}:${status.status}`;
            if (boundary !== lastClockBoundary) {
              lastClockBoundary = boundary;
              void logger.record({ level: 'info', category: 'state', device: '正式音频', itemId: status.itemId,
                message: status.status === 'playing' ? '设备时钟确认开始输出' : '设备时钟确认到达曲尾',
                details: { playbackSessionId: status.sessionId, generation: status.generation, positionMs: status.positionMs, qpc100ns, enginePid: status.enginePid } })
                .catch((error: unknown) => console.error('正式音频边界日志写入失败', error));
            }
          }
        },
        beforeControl: request => {
          nativeObs?.interrupt(request); nativeProgramHost?.interrupt(request);
          if (request.kind === 'stop' || request.kind === 'seek') void obsPreload.cancelNext(request.sessionId)
            .catch((error: unknown) => { void logger.record({ level: 'error', category: 'device', device: '后台画面',
              message: `下一节目预备清理失败：${String(error)}`, result: 'failed' })
              .catch((failure: unknown) => console.error('节目预备清理日志写入失败', failure)); });
        },
        measured,
        error: message => { void logger.record({ level: 'error', category: 'device', device: '正式音频', message, result: 'failed' })
          .catch((error: unknown) => console.error('正式音频日志写入失败', error)); }
      });
    }
    return nativePlayer;
  };
  handle('link:native-player-devices', (_event, value: unknown) => player().devices(nativeDeviceQueryRequestSchema.parse(value).scope));
  const midiCheck = new NativeMidiCheckService(app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe')
    : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe'), () => runtimeActive || nativePlaybackActive());
  handle('link:native-midi-check', async (_event, value: import('@tb/schema').NativeMidiCheck) => {
    try {
      await midiCheck.check(value);
      await logger.record({ level: 'info', category: 'device', device: 'midi', message: `Windows MIDI 接口已实际打开并释放：${value.portName}（未发送时间码）`, result: 'succeeded' });
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'midi', message: error instanceof Error ? error.message : String(error), result: 'failed' });
      throw error;
    }
  });
  handle('link:native-player-status', () => nativePlayer?.status ?? null);
  const playbackRequests = new NativePlaybackRequests(player, (channel, value) => authorizeProduct(channel, value));
  handle('link:native-player-prepare', (_event, value: unknown) => playbackRequests.prepare(value), 'listener');
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
      await logger.record({ level: status.state === 'active' ? 'info' : 'error', category: 'system', message: `启动授权校验：${status.state}`, result: status.state === 'active' ? 'succeeded' : 'failed' });
      return service;
    });
    return licenseService;
  };
  const getLicenseStatus = async () => internalDistribution ? internalDistributionStatus(internalDistribution, await readMachineCode()) : localTestAccess ? getLocalTestStatus() : (await getLicenseService()).status();
  handle('link:license-status', getLicenseStatus);
  let licenseChanging = false;
  const licenseAccess = new LicenseAccess(getLicenseStatus);
  releaseRendererRuntime = async () => {
    // Only release close protection after every owned output acknowledged stop.
    await licenseAccess.setActive(false);
    runtimeActive = false;
  };
  authorizeOutput = async () => {
    if (licenseChanging) throw new Error('请等待授权操作完成后再执行设备输出');
    await licenseAccess.requireOutput();
    if (licenseChanging) throw new Error('授权正在更换，请完成后重新执行');
  };
  authorizeProduct = async (channel, value) => {
    const protectedCall = needsProductLicense(channel, value);
    if (protectedCall && licenseChanging) throw new Error('请等待授权操作完成后再使用产品功能');
    await licenseAccess.authorize(channel, value);
    if (protectedCall && licenseChanging) throw new Error('授权正在更换，请完成后重试');
  };
  handle('link:license-require-output', () => authorizeOutput());
  const changeOnlineLicense = async (code?: string) => {
    if (runtimeActive || licenseChanging) throw new Error('请停止播放，并等待上一项授权操作完成');
    licenseChanging = true;
    try {
      const service = await getLicenseService();
      const result = code === undefined ? await service.refreshOnline() : await service.activateCode(code);
      await logger.record({ level: 'info', category: 'system', message: '在线授权已验证并保存', result: 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'system', message: '在线授权验证失败，请查看授权设置中的错误提示', result: 'failed' });
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
    if (runtimeActive || licenseChanging) throw new Error('请停止播放并等待授权操作完成后再更换授权');
    licenseChanging = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow!, { title: '导入本机授权', properties: ['openFile'], filters: [{ name: '团播联动台授权', extensions: ['tbllicense'] }] });
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      if ((await stat(file)).size > 16384) throw new Error('授权文件超过大小限制');
      const token = await readFile(file, 'utf8');
      if (runtimeActive) throw new Error('播放已开始，请停止后再导入授权');
      const status = await (await getLicenseService()).activate(token);
      await logger.record({ level: 'info', category: 'system', message: '已导入本机授权', result: 'succeeded' });
      return status;
    } finally { licenseChanging = false; }
  });
  const ma2Connections = new Ma2Connections(() => runtimeActive);
  const loopMidiService = new LoopMidiService();
  const ma2NetworkSetup = new Ma2NetworkSetup(join(app.getPath('userData'), 'ma2-network-addresses.json'));
  const ma2Network = new Ma2NetworkManager(app.getPath('userData'), profileStore, () => runtimeActive || nativePlaybackActive(), ma2PluginLua, host => ma2NetworkSetup.connectionAddress(host), async (host, peers) => {
    if (!isLocalMa2Address(host)) return;
    const profile = await profileStore.loadProfile();
    if (!profile?.ma2) return;
    const selected = await processManager.refresh('ma2', processConfiguration(profile, 'ma2'));
    if (selected.pid === null) throw new Error('选定的 MA2 onPC 尚未运行，请先点击一键连接');
    await assertMa2ConnectionOwner(selected.pid, peers);
  }, async (host, port) => {
    if (!isLocalMa2Address(host)) return;
    const profile = await profileStore.loadProfile();
    if (!profile?.ma2) return;
    const selected = await processManager.refresh('ma2', processConfiguration(profile, 'ma2'));
    if (selected.pid === null) throw new Error(`本机 MA2 onPC 未运行，未尝试登录 ${host}:${port}。请先点击一键连接按顺序启动 onPC，或在 MA2 设置中核对控台地址。`);
    const started = performance.now();
    const outcome = await waitForMa2Listener(selected.pid, port, profile.ma2.startupTimeoutMs);
    if (outcome === 'waited') await logger.record({ level: 'info', category: 'device', device: 'MA2', result: 'succeeded',
      message: `MA2 onPC 远程端口 ${port} 已就绪`, details: { pid: selected.pid, waitedMs: Math.round(performance.now() - started) } });
  }, (level, message) => {
    void logger.record({ level, category: 'device', device: 'MA2', message }).catch((error: unknown) => console.error('MA2 连接提示日志未能保存', error));
  });
  const ma2Reads = new Map<string, { senderId: number; controller: AbortController }>();
  ma2Network.setCueDeletionProjectReader(path => projectService.open(path));
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
    await logger.record({ level: result.hosts.some(host => host.identity === 'ma2') ? 'info' : 'warning', category: 'device', device: 'MA2', message: `自动发现完成：${result.hosts.filter(host => host.identity === 'ma2').length} 台已识别控台，${result.hosts.filter(host => host.identity === 'candidate').length} 个待确认地址`, details: { hosts: result.hosts, ranges: result.ranges, warnings: result.warnings } });
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
    if(result.phase==='failed')throw new Error('试听停止未完成，请在灯光工作台查看失败目标并处理后再退出。');
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
      const answer=await dialog.showMessageBox(mainWindow!,{type:'warning',title:'核对原控台输出',message:`已在原控台确认 ${label} 停止了吗？`,detail:`原连接：${target.network.host}:${target.network.port}。仅在你已确认该目标停止后清除记录；此操作不会发送关灯指令。`,buttons:['取消','已确认停止，清除记录'],defaultId:0,cancelId:0,noLink:true});
      if(answer.response!==1)return ma2Audition.status();
      const result=ma2Audition.acknowledgeClosed(request.targetId);
      await logger.record({level:'warning',category:'operator',device:'MA2',message:'操作员确认原控台目标已停止，清除旧连接试听记录（未发送指令）',details:{target}});
      return result;
    }
    const result=await ma2Audition.stop();await logger.record({level:result.phase==='failed'?'error':'info',category:'operator',device:'MA2',message:result.phase==='failed'?'停止试听未完成':'试听关闭指令已发送',details:{targets:result.targets}});return result;
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
  nativeProgram = new NativeProgramService((project, request, callbacks) => {
    const notice = (message: string, itemId: string | null): void => {
      void logger.record({ level: 'warning', category: 'state', device: '正式播放器', projectId: project.projectId,
        ...(itemId ? { itemId } : {}), message }).catch((error: unknown) => console.error('后台节目提示日志未能保存', error));
    };
    const host = new NativeProgramHost(project, request.projectPath, request.revision, {
      executable: app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe')
        : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe'),
      audio: () => nativePlayer?.status ?? null, authorize: () => authorizeOutput(), configuration: () => callbacks.configuration(),
      preciseSeeking: () => callbacks.configuration().preciseSeeking, changed: state => callbacks.changed(state),
      midiChanged: state => { if (state.state === 'running' || state.state === 'ready') callbacks.cueChanged(state.currentCueId); },
      obsChanged: state => { if (state.state === 'running' || state.state === 'ready') callbacks.cueChanged(state.currentCueId); }, notice,
      api: {
        prepareNativePlayback: value => playbackRequests.prepare(value), controlNativePlayback: value => playbackRequests.control(value),
        getNativePlaybackDevices: scope => player().devices(scope), prepareNativeObs: value => obsRequests.prepare(value),
        stopNativeObs: value => obsRequests.stop(value), preloadNativeObs: value => obsPreload.preload(value),
        cancelNativeObsPreload: value => obsPreload.cancel(value),
        onNativeObsStatus: listener => { programObsListeners.add(listener); return () => { programObsListeners.delete(listener); }; }
      },
      network: {
        getMa2NetworkStatus: async () => { await ma2NetworkReady; return ma2Network.status(); },
        cancelMa2Playback: sessionId => { ma2Network.cancelPlayback(sessionId); return Promise.resolve(); },
        playMa2Cue: async value => { await authorizeOutput(); return sendMa2Cue(value); }
      }
    });
    nativeProgramHost = host;
    return { controller: host.controller, close: async () => { await host.close(); if (nativeProgramHost === host) nativeProgramHost = null; } };
  }, event => sendToRenderer('link:native-program-event', event), () => authorizeOutput());
  // Session registration captures cancellation synchronously; output adapters
  // validate and authorize every actual audio, OBS, MIDI and lighting request.
  handle('link:native-program-open', (_event, value: unknown) => nativeProgram!.open(value), 'listener');
  handle('link:native-program-control', (_event, value: unknown) => nativeProgram!.control(value), 'listener');
  handle('link:ma2-export-plugin', async () => {
    const selected = await dialog.showOpenDialog({ title: '选择 MA2 插件导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const directory = await mkdtemp(join(selected.filePaths[0], 'TBLINK-MA2-Bridge-'));
    try {
      for (const [name, content] of [['tblink_bridge.lua', ma2PluginLua], ['tblink_bridge.xml', ma2PluginXml], ['安装说明.md', ma2PluginInstructions]]) {
        if (!name || content === undefined) throw new Error('MA2 插件资源缺失');
        await writeFile(join(directory, name), content, { flag: 'wx' });
      }
      await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: 'MA2 插件已导出', result: 'succeeded' });
      return directory;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `插件导出未完成：${error instanceof Error ? error.message : String(error)}`, result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-network-save', async (_event, payload: unknown) => { await ma2NetworkReady; return ma2Network.save(ma2NetworkSaveSchema.parse(payload)); });
  handle('link:ma2-network-connect', async () => {
    await ma2NetworkReady;
    const result = await ma2Network.connect();
    await logger.record({ level: result.error ? 'error' : 'info', category: 'device', device: 'MA2', message: result.error ?? (result.state === 'connected' ? `MA2 ${result.version} 网络登录已确认` : 'MA2 连接已取消'), result: result.error ? 'failed' : result.state === 'connected' ? 'succeeded' : 'skipped' });
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
    if (runtimeActive) throw new Error('请停止播放后扫描控台');
    const task = beginMa2Read(event, request.progressId);
    try {
      await ma2NetworkReady;
      if (task.signal.aborted) throw new Error('扫描已取消');
      if (request.projectPath && (!request.projectId || (await projectService.open(request.projectPath)).projectId !== request.projectId)) throw new Error('读取检查点的工程身份不一致');
      const recovery = request.projectPath && request.projectId ? new Ma2ReadRecovery(request.projectPath, request.projectId, request.network ? `${request.network.host}:${request.network.port}` : '本机 onPC') : undefined;
      const checkpoint = recovery?.checkpoint.bind(recovery);
      const catalog = request.network ? await ma2Network.readCatalog(request.network, task.report, task.signal, request.targets, checkpoint, request.expectedSource) : await readMa2Catalog((await getMa2Connection(request)).bridge, () => runtimeActive, undefined, task.report, task.signal, { targets: request.targets, checkpoint, expectedSource: request.expectedSource });
      for (const entry of catalog.entries) if (entry.error) await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `Timecode ${entry.target} 扫描失败：${entry.error}`, result: 'failed' });
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `已扫描 ${catalog.entries.length} 条 Timecode，${catalog.entries.filter(entry => entry.error).length} 条读取异常`, result: catalog.entries.some(entry => entry.error) ? 'failed' : 'succeeded' });
      return catalog;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `控台目录扫描未完成：${error instanceof Error ? error.message : String(error)}`, result: 'failed' });
      throw error;
    } finally { task.finish(); }
  });
  handle('link:ma2-effect-library', async (event, value: unknown) => {
    const request = ma2CatalogRequestSchema.parse(value);
    const task = beginMa2Read(event, request.progressId);
    try {
      await ma2NetworkReady;
      if (task.signal.aborted) throw new Error('素材读取已取消');
      if (request.projectPath && (!request.projectId || (await projectService.open(request.projectPath)).projectId !== request.projectId)) throw new Error('素材检查点的工程身份不一致');
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
    const request = ma2CueDeletePrepareSchema.parse(value); const task = beginMa2Read(event,request.progressId);
    try { return await ma2Network.prepareCueDeletion(request,task.report); }
    catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`空 Cue 删除清单核对失败：${String(error)}`,result:'failed'}); throw error; }
    finally { task.finish(); }
  });
  handle('link:ma2-cue-delete-commit', async (event,value:unknown) => {
    if (ma2Reads.size) throw new Error('请等待当前控台读取结束');
    const request = ma2CueDeleteCommitSchema.parse(value); const task = beginMa2Read(event,request.progressId);
    try {
      const result = await ma2Network.commitCueDeletion(request,task.report);
      await logger.record({level:result.error?'error':'info',category:'device',device:'MA2',message:`空 Cue 删除已确认 ${result.deleted.length} 项；备份 ${result.backups.join('；')}；${result.error??'回读通过'}`,result:result.error?'failed':'succeeded'});
      return result;
    } catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`空 Cue 删除未完成：${String(error)}`,result:'failed'}); throw error; }
    finally { task.finish(); }
  });
  handle('link:ma2-song-check', async (_event, value: unknown) => ma2Network.checkSong(ma2SongCheckRequestSchema.parse(value)));
  handle('link:ma2-song-sync', async (event, value: unknown) => {
    const request = ma2SongSyncRequestSchema.parse(value);
    const task = beginMa2Read(event, request.progressId);
    try {
      const result = await ma2Network.syncSong(request, task.report, task.signal);
      if (result.changed) await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `歌曲序列 ${result.binding.sequence} · ${result.binding.executor ? `执行器 ${result.binding.executor}` : `Layout ${result.binding.layout}`} 已写入并回读，备份 ${result.backupFile}`, result: 'succeeded' });
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
  handle('link:ma2-executor-page', async (_event, value: unknown) => {
    try { return await ma2Network.readExecutorPage(ma2ExecutorPageRequestSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `读取执行器页面失败：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-executor-update', async (_event, value: unknown) => {
    const request = ma2ExecutorUpdateRequestSchema.parse(value);
    try {
      const result = await ma2Network.updateExecutor(request);
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `执行器 ${request.page}.${request.slot} ${request.action.kind} 已回读，备份 ${result.backupFile}`, result: 'succeeded' });
      return result;
    } catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `执行器修改待核对：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-executor-input', async (_event, value: unknown) => {
    try { await ma2Network.inputExecutor(ma2ExecutorInputSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `执行器按键未完成：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-executor-release', async () => {
    try { await ma2Network.releaseExecutors(); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `执行器松开未回读：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-layout-update', async (_event, value: unknown) => {
    try { const result = await ma2Network.updateLayout(ma2LayoutUpdateRequestSchema.parse(value)); await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `Layout ${result.layout} 名称与位置已回读`, result: 'succeeded' }); return result; }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `Layout 修改未完成：${String(error)}`, result: 'failed' }); throw error; }
  });
  handle('link:ma2-new-cue', async (_event,value:unknown) => {
    try { const result=await ma2Network.newCue(ma2NewCueRequestSchema.parse(value));await logger.record({level:'info',category:'device',device:'MA2',message:`新建序列 ${result.sequence}，Layout ${result.layout.layout} 已回读核对`,result:'succeeded'});return result; }
    catch(error) { await logger.record({level:'error',category:'device',device:'MA2',message:`新建 Cue 未完成：${String(error)}`,result:'failed'});throw error; }
  });
  handle('link:ma2-auto-bind', async (_event, value: unknown) => {
    const request = ma2AutoBindRequestSchema.parse(value);
    try {
      const result = await prepareMa2AutoBindings((await getMa2Connection(request)).bridge, request, () => runtimeActive || nativePlaybackActive());
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `自动关联已核对：${result.plan.assignments.length} 个执行位置`, result: 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `自动关联未完成：${String(error)}`, result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-rename', async (_event, value: unknown) => {
    const request = ma2RenameRequestSchema.parse(value);
    try {
      const result = await renameMa2Object((await getMa2Connection(request)).bridge, request);
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `控台改名已回读：Sequence ${result.sequence} ${result.kind === 'single' ? `Cue ${result.cue}` : ''} → ${result.name}；备份 ${result.backupFile}`, result: 'succeeded' });
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
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `Timecode ${request.target} 创建回读已核对`, result: 'succeeded' });
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
    return compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map(request.choices));
  });
  handle('link:ma2-apply', async (_event, value: unknown) => {
    const request = ma2ApplyRequestSchema.parse(value);
    const { service } = await getMa2Connection(request);
    await logger.record({ level: 'info', category: 'operator', device: 'MA2', message: `开始同步 Timecode ${request.readback.target}`, result: 'running' });
    const result = await service.apply(request);
    await logger.record({ level: result.status === 'verified' ? 'info' : 'error', category: 'device', device: 'MA2', message: result.status === 'verified' ? 'MA2 回读已核对，等待节目应用' : result.message, result: result.status === 'verified' ? 'succeeded' : 'failed', details: result.status === 'verified' ? { backupFile: result.backupFile } : { stage: result.stage, mayHaveWritten: result.mayHaveWritten, backupFile: result.backupFile } });
    return result;
  });
  handle('link:app-info', async (): Promise<LinkAppInfo> => {
    const disk = await statfs(app.getPath('userData'));
    return {
      name: '团播联动台',
      version: desktopPackage.version,
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
    if (runtimeActive || nativePlaybackActive()) throw new Error('联动尚未停止；请先到集成中心停止联动并完成 OBS 清理，再安装更新');
    if (documentDirty) throw new Error('当前工程尚未保存，保存后才能安装更新');
    const decision = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: '安装团播联动台更新',
      message: '联动台将退出并安装已下载的新版本。',
      detail: 'OBS 与 P1 会保持运行。更新完成后联动台将重新启动。',
      buttons: ['取消', '退出并安装'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (decision.response !== 1) return;
    if (runtimeActive || nativePlaybackActive() || documentDirty) throw new Error('播放或工程状态已变化，请停止联动并保存工程后重新安装');
    await closeNativePlayer();
    allowWindowClose = true;
    try {
      updateManager.install();
    } catch (error) {
      allowWindowClose = false;
      throw error;
    }
  });
  handle('link:set-document-dirty', (_event, dirtyValue: unknown) => {
    documentDirty = linkDocumentDirtySchema.parse(dirtyValue);
  });
  handle('link:set-runtime-active', async (_event, activeValue: unknown) => {
    if (licenseChanging && activeValue === true) throw new Error('请等待授权操作完成后再播放');
    const active = linkRuntimeActiveSchema.parse(activeValue);
    await licenseAccess.setActive(active);
    if (active && licenseChanging) { await licenseAccess.setActive(false); throw new Error('授权正在更换，请完成后重新播放'); }
    runtimeActive = active;
  });
  handle('link:window-control', (event, actionValue: unknown) => {
    const action = linkWindowControlActionSchema.parse(actionValue);
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) throw new Error('无法定位当前联动台窗口');
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
    return result.canceled ? null : result.filePaths[0] ?? null;
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
    return { version: 1, path, content: await projectDocuments.read(path) };
  });
  handle('link:open-project', async (_event, pathValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue);
    return { version: 1, path, content: await projectDocuments.read(path) };
  });
  handle('link:save-project', async (_event, pathValue: unknown, projectValue: unknown) => {
    const content = projectDocumentTextSchema.parse(projectValue);
    let destination = linkOptionalFilePathSchema.parse(pathValue);
    if (!destination) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '保存团播联动工程',
        defaultPath: `${safeFileName(await projectDocuments.inspect(content))}.tblink`,
        filters: [{ name: '团播联动工程', extensions: ['tblink'] }]
      });
      if (result.canceled || !result.filePath) return null;
      destination = result.filePath;
    }
    try { await projectDocuments.save(destination, content); }
    catch (error) {
      await logger.record({ level:'error', category:'system', message:'工程保存失败，未确认落盘', result:'failed', details:{ path:destination, error:error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    return destination;
  });
  const archiveSettings = new ProjectArchiveSettingsStore(join(app.getPath('userData'), 'link-integrations', 'archive-settings.json'), join(app.getPath('documents'), '团播联动台', '存档'));
  // A failed trim leaves the extra archive in place and is logged; it never blocks the sync that archived.
  handle('link:project-archives', (_event, payload: unknown) => projectArchives(payload, projectDocuments, archiveSettings, path => shell.showItemInFolder(path), async path => {
    try { await shell.trashItem(path); return true; }
    catch (error) { await logger.record({ level: 'warning', category: 'system', message: '自动存档超出保留数量，移到回收站未完成', details: { path, error: error instanceof Error ? error.message : String(error) } }); return false; }
  }));
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
    return projectService.importReferenceAudio(payload.projectPath, payload.sourcePath, payload.durationMs);
  });
  handle('link:resolve-reference-audio-url', (_event, payloadValue: unknown) => {
    const payload = linkReferenceAudioResolvePayloadSchema.parse(payloadValue);
    const path = projectService.resolveReferenceAudio(payload.projectPath, payload.relativePath);
    return createAssetUrl(path);
  });
  handle('link:import-media-asset', async (_event, payloadValue: unknown) => {
    const payload = linkMediaAssetImportPayloadSchema.parse(payloadValue);
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
  handle('link:resolve-media-asset-url', (_event, payloadValue: unknown) => {
    const payload = linkMediaAssetResolvePayloadSchema.parse(payloadValue);
    return createAssetUrl(projectService.resolveMediaAsset(payload.projectPath, payload.relativePath));
  });
  handle('link:ensure-media-preview-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.parse(payloadValue);
    const path = payload.kind === 'video'
      ? await mediaPreviewService.ensureVideoPreview(payload.projectPath, payload.relativePath, payload.sha256)
      : projectService.resolveMediaAsset(payload.projectPath, payload.relativePath);
    return createAssetUrl(path);
  });
  handle('link:ensure-media-thumbnail-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.strict().parse(payloadValue);
    if (payload.kind === 'audio') throw new Error('音频素材使用类型图标');
    return createAssetUrl(await mediaPreviewService.ensureThumbnail(payload.projectPath, payload.relativePath, payload.sha256));
  });
  handle('link:ensure-media-audio-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.parse(payloadValue);
    if (payload.kind === 'image') throw new Error('图片素材不包含音轨');
    return createAssetUrl(await mediaPreviewService.ensureAudioPreview(payload.projectPath, payload.relativePath, payload.sha256));
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
  handle('link:automatic-music-start', (_event, value: unknown) => {
    return automaticMusic!.start(automaticMusicRequestSchema.parse(value));
  });
  handle('link:automatic-music-control', (_event, value: unknown) => {
    const request = automaticMusicControlSchema.parse(value);
    if (request.action === 'cancel') return automaticMusic!.cancel(request.taskId);
    automaticMusic!.resume(request.taskId);
  });
  app.once('before-quit', () => musicAnalysis.close());
  musicMonitor = new MusicMonitorService(app.isPackaged ? join(process.resourcesPath, 'playback-engine/tblink-playback.exe') : process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? join(__dirname, '../../../../tools/playback-engine/bin/tblink-playback.exe'), projectService, obs, error => { void logger.record({ level: 'error', category: 'device', device: '编排监听', message: error.message, result: 'failed' }).catch((failure: unknown) => console.error('监听日志保存失败', failure)); }, status => sendToRenderer('link:music-monitor-status', status));
  handle('link:start-music-monitor', (_event, value: unknown) => musicMonitor!.start(musicMonitorRequestSchema.parse(value)));
  handle('link:stop-music-monitor', () => musicMonitor!.stop());
  handle('link:analyze-music', (_event, value: unknown) => {
    if (runtimeActive) throw new Error('请停止正式播放后分析音乐');
    const request = musicAnalysisRequestSchema.parse(value);
    return musicAnalysis.analyze(request.taskId, request.projectPath, request.source);
  });
  handle('link:cancel-music-analysis', (_event, value: unknown) => { musicAnalysis.cancel(musicAnalysisControlSchema.parse(value).taskId); });
  handle('link:analyze-audio-beats', (_event, value: unknown) => {
    const payload = audioAnalysisRequestSchema.parse(value);
    return audioEditService.analyze(payload.projectPath, payload.source);
  });
  handle('link:render-audio-segments', (_event, value: unknown) => {
    const payload = audioRenderRequestSchema.parse(value);
    if (runtimeActive) throw new Error('请停止播放后编辑音频');
    return payload.tracks ? audioEditService.mix(payload.projectPath, payload.tracks) : audioEditService.render(payload.projectPath, payload.source, payload.segments);
  });
  handle('link:generate-waveform', (_event, payloadValue: unknown) => {
    const payload = linkWaveformGeneratePayloadSchema.parse(payloadValue);
    const sourcePath = assetTokens.get(new URL(payload.url).pathname.slice(1));
    if (!sourcePath) throw new Error('波形素材链接已失效，请重新打开节目');
    return waveformService.ensure(payload.projectPath, sourcePath, payload.sha256, payload.durationMs);
  });
  handle('link:load-waveform-cache', (_event, payloadValue: unknown) => {
    const payload = linkWaveformCachePayloadSchema.parse(payloadValue);
    return projectService.loadWaveformCache(payload.projectPath, payload.sha256);
  });
  handle('link:save-waveform-cache', (_event, payloadValue: unknown) => {
    const payload = linkWaveformCacheSavePayloadSchema.parse(payloadValue);
    return projectService.saveWaveformCache(payload.projectPath, payload.sha256, payload.peaks);
  });
  handle('link:inspect-project-assets', (_event, pathValue: unknown, projectValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue);
    return projectService.inspectAssets(path, parseLinkProject(projectValue));
  });
  handle('link:inspect-media-assets', (_event, value: unknown) => {
    const payload = linkMediaInspectionPayloadSchema.parse(value);
    return projectService.inspectMediaAssets(payload.projectPath, payload.assets);
  });
  handle('link:p1-detect-current-project', async () => {
    const detection = await integrationDetector.detect();
    const title = detection.applications.p1.windowTitle?.trim() ?? '';
    if (!title.toLocaleLowerCase('en-US').endsWith('.hia')) {
      throw new Error('P1 当前没有打开已保存的 .hia 音频工程；请先在 P1 保存工程，或手动选择 .hia 文件');
    }
    const candidate = title.replaceAll('/', '\\');
    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) throw new Error(`P1 当前工程文件不存在：${candidate}`);
    return candidate;
  });
  handle('link:p1-pick-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 Hirender P1 音频工程',
      properties: ['openFile'],
      filters: [{ name: 'Hirender P1 音频工程', extensions: ['hia'] }]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  const p1Imports = new Map<string, { senderId: number; controller: AbortController }>();
  handle('link:p1-import-cancel', (event, value: unknown) => {
    const id = z.string().uuid().parse(value);
    const task = p1Imports.get(id);
    if (task?.senderId === event.sender.id) task.controller.abort();
  });
  handle('link:p1-import-project', async (event, payloadValue: unknown) => {
    const payload = linkP1ProjectImportPayloadSchema.parse(payloadValue);
    const id = payload.progressId;
    if (id && p1Imports.has(id)) throw new Error('P1 导入任务编号重复');
    const controller = new AbortController();
    if (id) p1Imports.set(id, { senderId: event.sender.id, controller });
    try {
      return await p1ProjectService.importProject(payload.p1ProjectPath, payload.linkProjectPath, {
        signal: controller.signal,
        ...(id ? { onProgress: (progress: Omit<LinkP1ProjectImportProgress, 'id'>) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send('link:p1-import-progress', linkP1ProjectImportProgressSchema.parse({ id, ...progress } satisfies LinkP1ProjectImportProgress));
        } } : {})
      });
    } finally { if (id) p1Imports.delete(id); }
  });
  handle('link:p1-preview-export', (_event, payloadValue: unknown) => {
    const payload = linkP1ProjectExportPreviewPayloadSchema.parse(payloadValue);
    return p1ProjectService.previewExport(payload.p1ProjectPath, payload.linkProjectPath, payload.project);
  });
  handle('link:p1-export-project', (_event, payloadValue: unknown) => {
    const payload = linkP1ProjectExportPayloadSchema.parse(payloadValue);
    return p1ProjectService.exportProject(
      payload.p1ProjectPath,
      payload.linkProjectPath,
      payload.project,
      payload.expectedSourceSha256
    );
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
      await logger.record({ level: 'info', category: 'device', device: 'obs', result: 'running',
        message: '正在连接 OBS WebSocket', details: { address: profile.obs.webSocketUrl, passwordProvided: password.length > 0 } });
      connected = await obs.connect(profile.obs.webSocketUrl, password, profile.obs.startupTimeoutMs);
      await logger.record({ level: 'info', category: 'device', device: 'obs', result: 'succeeded',
        message: 'OBS WebSocket 已连接', details: { address: profile.obs.webSocketUrl, obsVersion: connected.obsVersion } });
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
        message: `OBS 网络已连接，但本机媒体桥识别失败：${error instanceof Error ? error.message : String(error)}`, result: 'failed' }); }
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
        message: '部分 OBS 来源尺寸不可用；其他场景已读取，可继续播放', details: warnings });
    }
    inventoryWarningKey = key;
    return inventory;
  });
  handle('link:obs-media-scenes-prepare', async (_event, pathValue: unknown, projectValue: unknown, preciseSeekingValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue); const project = parseLinkProject(projectValue);
    const preciseSeeking = z.boolean().parse(preciseSeekingValue);
    if (obs.getSnapshot().status !== 'connected') throw new Error('请先连接 OBS，再同步素材独立场景');
    await projectService.inspectAssets(path, project);
    const targets = materialSceneTargets(project);
    for (const [index, target] of targets.entries()) {
      const { asset } = target;
      const absolutePath = projectService.resolveMediaAsset(path, asset.relativePath);
      if (!(await stat(absolutePath)).isFile()) throw new Error(`素材文件不可读：${asset.name}`);
      const generation = { startedAt: 0 };
      const playbackPath = preciseSeeking && asset.kind === 'video'
        ? await mediaPreviewService.ensureObsSeekVideo(path, asset.relativePath, asset.sha256, 'hardware', () => {
          generation.startedAt = performance.now();
          sendToRenderer('link:obs-media-preparation', obsMediaPreparationSchema.parse({ assetName: asset.name, index, total: targets.length }));
          void logger.record({ level: 'info', category: 'device', device: 'obs', message: `正在生成 OBS 定位缓存：${asset.name}（${index + 1}/${targets.length}）`, result: 'running' })
            .catch((error: unknown) => console.error('定位缓存日志未能写入', error));
        }) : absolutePath;
      if (generation.startedAt) await logger.record({ level: 'info', category: 'device', device: 'obs', message: `OBS 定位缓存已生成：${asset.name}`,
        result: 'succeeded', details: { elapsedMs: Math.round(performance.now() - generation.startedAt) } });
      await obs.mediaScenes.prepare(project.projectId, asset, absolutePath, playbackPath, obsMediaCachePaths(path, asset.sha256), target);
    }
  });
  handle('link:obs-source-create', (_event, value: unknown) => obs.sources.create(obsSourceCreateSchema.parse(value)));
  handle('link:obs-source-options', (_event, value: unknown) => obs.sources.options(obsSourceNameSchema.parse(value)));
  handle('link:obs-source-cancel', (_event, value: unknown) => obs.sources.cancel(obsSourceNameSchema.parse(value)));
  handle('link:obs-source-apply', (_event, value: unknown) => {
    const payload = obsSourceApplySchema.parse(value);
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
    if (localObsConnecting) throw new Error('正在自动连接 OBS，请等待当前操作完成');
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
      if (!profile.obs.executablePath) throw new Error('尚未找到本机 OBS，请先安装 OBS 或选择程序位置');
      const commandLine = process.pid !== null && process.executablePath && process.startTime
        ? await readObsCommandLine({ pid: process.pid, executablePath: process.executablePath, startTime: process.startTime }) : '';
      let targetPid = process.pid;
      const local = await prepareLocalObsConnection({ obs: profile.obs, roamingDirectory: app.getPath('appData'), running, commandLine });
      knownSecrets.add(local.password);
      profile = { ...profile, updatedAt: new Date().toISOString(), obs: { ...profile.obs, connectionMethod: 'automatic', webSocketUrl: local.address } };
      await profileStore.saveCredential(profile.obs.credentialId, local.password);
      await profileStore.saveProfile(profile);
      await logger.record({ level: 'info', category: 'device', device: 'obs', message: '已自动读取本机 OBS 连接配置', details: { address: local.address, source: local.configurationPath, changed: local.changed } });
      if (!running) {
        try { await bridgeSetup.prepare(); }
        catch (error) { await logger.record({ level: 'warning', category: 'device', device: 'obs', message: `预览组件需单独维护：${String(error)}` }); }
        const started = await processManager.start('obs', processConfiguration(profile, 'obs'));
        if (started.pid === null) throw new Error('OBS 尚未启动');
        targetPid = started.pid;
        await waitForObsEndpoint(local.address, started.pid, profile.obs.startupTimeoutMs);
      }
      const listeningPid = targetPid === null ? null : await findLocalObsPid(local.address);
      if (targetPid !== null && listeningPid === null) throw obsEndpointNotListening(local.address, targetPid);
      if (targetPid === null || listeningPid !== targetPid) throw new Error('OBS 连接端口与选定进程不一致，请检查是否同时运行了多个 OBS；尚未发送密码');
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
      return processManager.refresh('obs', processConfiguration(profile, 'obs'));
    },
    confirm: async (kind, reason) => {
      const decision = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '维护 OBS 内置组件',
        message: kind === 'restart' ? '需要正常重启 OBS 以加载组件' : '请先在 OBS 内正常退出，再继续',
        detail: `${reason}\n\n${kind === 'restart' ? '请先保存 OBS 场景。确认后联动台会检查推流与录像状态，正常关闭本次启动的 OBS，部署组件并重新连接。' : '当前 OBS 不是本次由联动台启动，软件不会关闭它。请保存场景并正常退出 OBS；点击继续后，软件将完成部署、启动和连接。'}`,
        buttons: [kind === 'restart' ? '保存好了，重启并修复' : '已退出，继续', '取消'], defaultId: 1, cancelId: 1
      });
      return decision.response === 0;
    },
    stop: async () => {
      if (runtimeActive) throw new Error('请先停止节目播放，再维护 OBS 组件');
      const profile = await requireProfile(profileStore);
      if (obs.getSnapshot().status !== 'connected') await connectObs();
      await processManager.stop('obs', profile.obs.shutdownTimeoutMs);
      await obs.disconnect();
      nativeSeek.reset();
    },
    start: async () => {
      const profile = await requireProfile(profileStore);
      const started = await processManager.start('obs', processConfiguration(profile, 'obs'));
      if (started.pid === null) throw new Error('OBS 启动后未返回进程');
      await waitForObsEndpoint(profile.obs.webSocketUrl, started.pid, profile.obs.startupTimeoutMs);
    },
    connect: async () => {
      if (obs.getSnapshot().status !== 'connected') {
        const snapshot = await connectObs();
        if (snapshot.status !== 'connected') throw new Error('OBS 组件已部署，但 WebSocket 未连接；请在设备连接中检查配置');
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
    if (runtimeActive) throw new Error('请先停止节目播放，再维护 OBS 组件');
    if (bridgeMaintenance) throw new Error('OBS 组件维护正在进行');
    bridgeMaintenance = true;
    livePreview.close(); liveAddress = null; liveBridgeInstalled = false;
    try {
      await logger.record({ level: 'info', category: 'device', device: 'obs', result: 'running', message: '开始检查 OBS 预览组件：部署、连接及真实视频帧验证' });
      bridgeMaintenanceTask = bridgeSetup.repair();
      await bridgeMaintenanceTask;
      await logger.record({ level: 'info', category: 'device', device: 'obs', result: 'succeeded', message: 'OBS 内置组件部署及真实视频帧检查通过' });
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
  handle('link:obs-activate-managed-output', () => obs.activateManagedOutput());
  handle('link:obs-internal-audio', async (_event, value: unknown) => {
    if (!mainWindow) throw new Error('主控窗口不存在');
    const profile = await requireProfile(profileStore);
    const payload = linkInternalAudioCaptureSchema.parse(value);
    if (payload.enabled && nativePlayer?.status && nativePlayer.status.status !== 'stopped') {
      const identity = nativePlayer.audioCaptureIdentity;
      return obs.setInternalAudioCapture(true, identity.executable, identity.title, identity.audioDeviceId, payload.sceneNames, identity.windowClass);
    }
    return obs.setInternalAudioCapture(payload.enabled, basename(process.execPath), mainWindow.getTitle(), profile.internalPlayer?.audioOutputDeviceId ?? 'default', payload.sceneNames);
  });
  handle('link:obs-execute-managed-media', async (_event, payloadValue: unknown) => {
    const payload = linkManagedMediaExecutionPayloadSchema.parse(payloadValue);
    const absolutePath = projectService.resolveMediaAsset(payload.projectPath, payload.event.relativePath);
    const file = await stat(absolutePath);
    if (!file.isFile()) throw new Error(`正式媒体文件不存在：${absolutePath}`);
    await obs.executeManagedMediaEvent(payload.event, absolutePath);
  });
  handle('link:process-start', async (_event, idValue: unknown): Promise<LinkProcessSnapshot> => {
    const id = linkExternalApplicationIdSchema.parse(idValue);
    const profile = await requireProfile(profileStore);
    // Control connections must not depend on preview plugin maintenance.
    if (id === 'obs') {
      const current = await processManager.refresh(id, processConfiguration(profile, id));
      if (current.pid !== null) return current;
      try { await bridgeSetup.prepare(); }
      catch (error) {
        await logger.record({ level: 'warning', category: 'device', device: 'obs', result: 'failed',
          message: `OBS 预览组件尚未就绪，继续启动控制连接；预览需单独修复：${String(error)}` });
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
  handle('link:log-record', (_event, entryValue: unknown) => logger.record(parseLogRecord(entryValue)));
  handle('link:log-query', (_event, filterValue: unknown) => logger.query(parseLogFilter(filterValue)));
  handle('link:log-open-folder', async () => {
    const directory = join(app.getPath('userData'), 'link-logs');
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(`无法打开日志文件夹：${error}`);
  });
  handle('link:log-export', async () => {
    const result = await dialog.showSaveDialog(mainWindow!, { title: '导出运行日志',
      defaultPath: `团播联动台-日志-${new Date().toISOString().replaceAll(':', '-')}.txt`,
      filters: [{ name: '文本日志', extensions: ['txt'] }] });
    if (result.canceled || !result.filePath) return null;
    await logger.exportText(result.filePath);
    return result.filePath;
  });
  handle('link:diagnostic-export', async (_event, contextValue: unknown) => {
    const context = linkDiagnosticContextSchema.parse(contextValue);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出脱敏诊断包',
      defaultPath: `团播联动台-诊断-${new Date().toISOString().replaceAll(':', '-')}.tbdiag.gz`,
      filters: [{ name: '团播联动台诊断包', extensions: ['tbdiag.gz'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await logger.exportDiagnosticPackage(result.filePath, { ...context, environment: {
      appVersion: desktopPackage.version, packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      osRelease: release(), cpu: cpus()[0]?.model ?? '未知', logicalProcessors: cpus().length,
      totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), versions: process.versions,
      gpuFeatures: app.getGPUFeatureStatus(), processes: app.getAppMetrics(),
      obs: obs.getSnapshot(), ma2: ma2Network.status(), runtimeActive, collectedAt: new Date().toISOString(),
      crashDumpContentsIncluded: false
    } });
    return result.filePath;
  });
}

function registerAssetProtocol(): void {
  protocol.handle('tblink-asset', async (request) => {
    try { await authorizeOutput(); }
    catch (error) { return new Response(error instanceof Error ? error.message : '授权校验失败', { status: 403 }); }
    const url = new URL(request.url);
    const token = url.pathname.slice(1);
    const path = assetTokens.get(token);
    if (!path) return new Response('Asset token not found', { status: 404 });
    return assetResponse(path, request, mimeType(path));
  });
}

async function runQuitFlow(profileStore: SecureProfileStore, processManager: ExternalProcessManager): Promise<void> {
  recordQuitStep('退出前停止灯光试听');
  try { await stopAuditionForQuit?.(); }
  catch (error) {
    // Operator decision 2026-10-19: a console that cannot confirm Off (e.g. disconnected)
    // must not keep the console app open for good; the operator chooses.
    const reason = error instanceof Error ? error.message : String(error);
    recordQuitStep('灯光试听停止未完成', { error: reason });
    const options = { type: 'warning' as const, title: '灯光试听未能停止', message: '退出前没有确认控台已关闭本次试听。',
      detail: `${reason}\n\n仍然退出时，控台上可能保留当前灯光状态，请到控台手动处理。`, buttons: ['返回软件', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true };
    const choice = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (choice.response !== 1) { recordQuitStep('返回软件处理灯光试听'); return; }
    recordQuitStep('操作员选择仍然退出', { error: reason });
  }
  recordQuitStep('退出前关闭正式音频与画面');
  await closeNativePlayer();
  const owned = (['p1', 'ma3d', 'ma2', 'obs'] as const)
    .map((id) => processManager.getSnapshot(id))
    .filter((snapshot) => snapshot.owned && snapshot.pid !== null);
  if (owned.length === 0) {
    recordQuitStep('退出前关闭音乐分析');
    await automaticMusic?.close();
    allowWindowClose = true;
    recordQuitStep('退出流程完成');
    app.quit();
    return;
  }
  const closeIds: ExternalApplicationId[] = [];
  for (const snapshot of owned) {
    recordQuitStep('确认外部程序', { id: snapshot.id, pid: snapshot.pid });
    const decision = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: '逐项确认外部程序',
      message: `${snapshot.id} 由本次联动台启动`,
      detail: `PID ${String(snapshot.pid)}\n${snapshot.executablePath ?? '路径未知'}\n\n请选择退出联动台时如何处理此程序。`,
      buttons: ['取消退出', '保留并继续确认', '请求正常关闭'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (decision.response === 0) return;
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
        title: '部分外部程序保持运行',
        message: '联动台没有强制结束以下程序：',
        detail: failures.join('\n'),
        buttons: ['确认并退出']
      });
    }
  }
  recordQuitStep('退出前关闭音乐分析');
  await automaticMusic?.close();
  allowWindowClose = true;
  recordQuitStep('退出流程完成');
  app.quit();
}

/** Each quit stage with the flags that gate it, so a hang names its stage. */
function recordQuitStep(step: string, details: Record<string, unknown> = {}): void {
  void ipcLogger?.record({ level: 'info', category: 'system', device: '退出流程', message: step,
    details: { runtimeActive, nativePlayback: nativePlaybackActive(), documentDirty, allowWindowClose, quitFlowRunning,
      windows: BrowserWindow.getAllWindows().length, ...details } })
    .catch((error: unknown) => console.error('退出流程日志未能写入', error));
}

let runtimeExitWarningOpen = false;
function showRuntimeActiveExitWarning(): void {
  recordQuitStep('运行会话未停止，拒绝退出');
  if (runtimeExitWarningOpen) return;
  runtimeExitWarningOpen = true;
  const options = {
    type: 'warning' as const,
    title: '联动尚未停止',
    message: '当前音频或联动会话尚未停止。',
    detail: '请返回播放器停止播放；仍有画面联动时，等待相关来源完成清理后再退出。',
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
    if (!process.env.ProgramData) throw new Error('无法定位 OBS 内置组件目录');
    const plugins = join(process.env.ProgramData, 'obs-studio/plugins');
    return { ...profile.obs, environment: {
      OBS_PLUGINS_PATH: join(plugins, 'tblink-realtime-preview/bin/64bit').replaceAll('\\', '/'),
      OBS_PLUGINS_DATA_PATH: plugins.replaceAll('\\', '/')
    } };
  }
  const configuration = profile[id];
  if (!configuration) throw new Error(`${id === 'ma2' ? 'MA2 onPC' : id === 'ma3d' ? 'MA 3D' : 'P1'} 程序路径尚未配置，请在设备设置中选择程序`);
  return configuration;
}

async function requireProfile(store: SecureProfileStore) {
  const profile = await store.loadProfile();
  if (!profile) throw new Error('尚未配置本机集成档案');
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

function createAssetUrl(path: string): string {
  const token = crypto.randomUUID();
  assetTokens.set(token, path);
  return `tblink-asset://local/${token}`;
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
