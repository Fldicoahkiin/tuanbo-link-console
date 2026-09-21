import { ibtExecutable } from './link/ibt-beat-service';
import { LicenseService } from './link/license-service';
import { writeFileAtomically } from './link/atomic-file';
import { readLicenseMachineCode } from './link/license-machine';
import licensePublicKeys from './link/license-public-keys.json';
import { licenseRequestSchema } from '@tb/schema';
import { installObsLiveBridge } from './link/obs-live-install';
import { existsSync } from 'node:fs';
import { elevateObsPluginInstall } from './link/obs-plugin-elevation';
import { ObsBridgeSetup } from './link/obs-bridge-setup';
import { waitForObsEndpoint } from './link/obs-startup';
import { obsLiveEditSchema } from '@tb/schema';
import { ObsLivePreview } from './link/obs-live-preview';
import { ObsNativeSeek } from './link/obs-native-seek';
import { obsSourceCreateSchema, obsSourceNameSchema, obsSourceApplySchema, ma2BridgeRequestSchema, ma2ReadRequestSchema, ma2CompareRequestSchema, ma2ApplyRequestSchema, ma2CreateRequestSchema } from '@tb/schema';
import { createMa2Timecode } from './link/ma2-create';
import { ma2CatalogRequestSchema } from '@tb/schema';
import { readMa2Catalog } from './link/ma2-catalog';
import { readMa2EffectLibrary } from './link/ma2-effect-library';
import { ma2ExecutorReadRequestSchema } from '@tb/schema';
import { readMa2Executor } from './link/ma2-executor-read';
import { Ma2Connections } from './link/ma2-connections';
import { Ma2DiscoveryService } from './link/ma2-discovery';
import { Ma2NetworkManager } from './link/ma2-network-manager';
import { ma2NetworkSaveSchema } from '@tb/schema';
import ma2PluginLua from '../../../../tools/ma2/tblink_bridge.lua?raw';
import ma2PluginXml from '../../../../tools/ma2/tblink_bridge.xml?raw';
import ma2PluginInstructions from '../../../../tools/ma2/README.md?raw';
import { compareMa2LightingReadback } from './link/ma2-comparison';
import { convertMa2Snapshot } from './link/ma2-timecode-conversion';
import { open, readFile, stat, statfs, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import {
  app,
  BrowserWindow,
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
  linkUpdateTokenSchema,
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
import { WaveformService } from './link/waveform-service';
import { AudioEditService } from './link/audio-edit-service';
import { audioAnalysisRequestSchema, audioRenderRequestSchema } from '@tb/schema';
import { ObsWebSocketAdapter } from './link/obs-websocket-adapter';
import { ObsEditorPreview } from './link/obs-editor-preview';
import { P1ProjectService } from './link/p1-project-service';
import { LinkRunLogger, redactValue, type LinkLogEntry, type LinkLogFilter } from './link/run-logger';
import { SecureProfileStore } from './link/secure-profile-store';
import { WindowsIntegrationDetector } from './link/windows-integration-detector';
import { LoopMidiService } from './link/loop-midi-service';
import { loopMidiActionSchema, loopMidiStatusSchema } from '@tb/schema';
import { LinkUpdateManager } from './link/update-manager';

protocol.registerSchemesAsPrivileged([{
  scheme: 'tblink-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

let mainWindow: BrowserWindow | null = null;
let documentDirty = false;
let runtimeActive = false;
let allowWindowClose = false;
let quitFlowRunning = false;

const projectService = new LinkProjectService();
const p1ProjectService = new P1ProjectService(projectService);
const mediaMetadataProbe = new MediaMetadataProbe();
const mediaPreviewService = new MediaPreviewService(projectService);
const assetTokens = new Map<string, string>();
const knownSecrets = new Set<string>();
const UPDATE_CREDENTIAL_ID = 'github.update.token';

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => {
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
  const updateManager = new LinkUpdateManager(
    app.getVersion(),
    app.isPackaged,
    (status) => sendToRenderer('link:update-status', status)
  );
  updateManager.setTokenConfigured(await profileStore.hasCredential(UPDATE_CREDENTIAL_ID));
  registerAssetProtocol();
  registerIpc(profileStore, obs, processManager, logger, integrationDetector, updateManager);
  createMainWindow(obs);

  obs.subscribe((snapshot) => sendToRenderer('link:obs-status', snapshot));
  obs.subscribeInventoryChanges(() => sendToRenderer('link:obs-inventory-changed', null));
  processManager.subscribe((snapshot) => sendToRenderer('link:process-status', snapshot));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(obs);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !quitFlowRunning) app.quit();
  });
  app.on('before-quit', (event) => {
    if (allowWindowClose || quitFlowRunning) return;
    event.preventDefault();
    if (runtimeActive) {
      showRuntimeActiveExitWarning();
      return;
    }
    quitFlowRunning = true;
    void obs.sources.discardPending().then(() => runQuitFlow(profileStore, processManager))
      .catch((error: unknown) => dialog.showErrorBox('退出流程失败', error instanceof Error ? error.message : String(error)))
      .finally(() => { quitFlowRunning = false; });
  });
}

function createMainWindow(obs: ObsWebSocketAdapter): void {
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
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  mainWindow.setMenu(null);
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
    return permission === 'midi' || permission === 'midiSysex' || (permission === 'media' && details.mediaType === 'audio');
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'midi' || permission === 'midiSysex' || permission === 'speaker-selection');
  });
  mainWindow.on('close', (event) => {
    if (allowWindowClose) return;
    if (runtimeActive) {
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
      documentDirty = false;
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
  let licenseService: LicenseService | undefined;
  const getLicenseService = async (): Promise<LicenseService> => {
    if (!licenseService) licenseService = new LicenseService(app.getPath('userData'), await readLicenseMachineCode(), licensePublicKeys);
    return licenseService;
  };
  handle('link:license-status', async () => (await getLicenseService()).status());
  handle('link:license-export-request', async () => {
    const status = await (await getLicenseService()).status();
    const result = await dialog.showSaveDialog(mainWindow!, { title: '导出本机授权申请', defaultPath: '团播联动台-授权申请.json', filters: [{ name: '授权申请', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFileAtomically(result.filePath, JSON.stringify(licenseRequestSchema.parse({ version: 1, product: 'tuanbo-link-console', machineCode: status.machineCode }), null, 2));
    return true;
  });
  handle('link:license-import', async () => {
    if (runtimeActive) throw new Error('请停止播放后再更换授权');
    const result = await dialog.showOpenDialog(mainWindow!, { title: '导入本机授权', properties: ['openFile'], filters: [{ name: '团播联动台授权', extensions: ['tbllicense'] }] });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    if ((await stat(file)).size > 16384) throw new Error('授权文件超过大小限制');
    const token = await readFile(file, 'utf8');
    if (runtimeActive) throw new Error('播放已开始，请停止后再导入授权');
    const status = await (await getLicenseService()).activate(token);
    await logger.record({ level: 'info', category: 'system', message: '已导入本机授权', result: 'succeeded' });
    return status;
  });
  const ma2Connections = new Ma2Connections(() => runtimeActive);
  const loopMidiService = new LoopMidiService();
  const ma2Network = new Ma2NetworkManager(app.getPath('userData'), profileStore, () => runtimeActive);
  const ma2Discovery = new Ma2DiscoveryService();
  app.once('will-quit', () => ma2Discovery.cancel());
  handle('link:ma2-discover', async () => { await ma2NetworkReady; if (runtimeActive) throw new Error('请停止播放后搜索控台'); return ma2Discovery.search(ma2Network.status().profiles ?? []); });
  handle('link:ma2-discovery-cancel', () => ma2Discovery.cancel());
  handle('link:ma2-capabilities', async () => { await ma2NetworkReady; return ma2Network.checkCapabilities(); });
  const ma2NetworkReady = ma2Network.initialize();
  app.once('will-quit', () => ma2Network.disconnect());
  const getMa2Connection = async (request: { dataDirectory: string; network?: import('@tb/schema').Ma2NetworkTarget | undefined }) => {
    await ma2NetworkReady;
    return request.network ? ma2Network.get(request.network) : ma2Connections.get(request.dataDirectory);
  };
  handle('link:ma2-network-status', async () => { await ma2NetworkReady; return ma2Network.status(); });
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
  handle('link:ma2-network-disconnect', async () => { await ma2NetworkReady; return ma2Network.disconnect(); });
  handle('link:ma2-exchange', async (_event, value: unknown) => {
    const request = ma2BridgeRequestSchema.parse(value);
    return (await getMa2Connection(request)).bridge.request(request.operation, request.target, request.expected, request.desired);
  });
  handle('link:ma2-preview', async (_event, value: unknown) => {
    const request = ma2ReadRequestSchema.parse(value);
    const snapshot = await (await getMa2Connection(request)).bridge.request('SNAPSHOT', request.target);
    return convertMa2Snapshot(snapshot, request.target, [], request.timeOriginMs);
  });
  handle('link:ma2-catalog', async (_event, value: unknown) => {
    const request = ma2CatalogRequestSchema.parse(value);
    if (runtimeActive) throw new Error('请停止播放后扫描控台');
    try {
      const catalog = await readMa2Catalog((await getMa2Connection(request)).bridge, () => runtimeActive);
      for (const entry of catalog.entries) if (entry.error) await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `Timecode ${entry.target} 扫描失败：${entry.error}`, result: 'failed' });
      await logger.record({ level: 'info', category: 'device', device: 'MA2', message: `已扫描 ${catalog.entries.length} 条 Timecode，${catalog.entries.filter(entry => entry.error).length} 条读取异常`, result: catalog.entries.some(entry => entry.error) ? 'failed' : 'succeeded' });
      return catalog;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `控台目录扫描未完成：${error instanceof Error ? error.message : String(error)}`, result: 'failed' });
      throw error;
    }
  });
  handle('link:ma2-effect-library', async (_event, value: unknown) => {
    const request = ma2CatalogRequestSchema.parse(value);
    try {
      const result = await readMa2EffectLibrary((await getMa2Connection(request)).bridge, () => runtimeActive);
      await logger.record({ level: result.errors.length ? 'error' : 'info', category: 'device', device: 'MA2', message: `效果库读取 ${result.sequences.length} 条序列；异常：${JSON.stringify(result.errors)}`, result: result.errors.length ? 'failed' : 'succeeded' });
      return result;
    } catch (error) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: `效果库读取失败：${String(error)}`, result: 'failed' });
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
      version: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      availableDiskBytes: disk.bavail * disk.bsize
    };
  });
  handle('link:update-status', async (): Promise<LinkUpdateStatus> => {
    const configured = await profileStore.hasCredential(UPDATE_CREDENTIAL_ID);
    const status = updateManager.getStatus();
    return status.tokenConfigured === configured ? status : updateManager.setTokenConfigured(configured);
  });
  handle('link:update-save-token', async (_event, tokenValue: unknown): Promise<LinkUpdateStatus> => {
    const token = linkUpdateTokenSchema.parse(tokenValue);
    await profileStore.saveCredential(UPDATE_CREDENTIAL_ID, token);
    knownSecrets.add(token);
    return updateManager.setTokenConfigured(true);
  });
  handle('link:update-clear-token', async (): Promise<LinkUpdateStatus> => {
    await profileStore.deleteCredential(UPDATE_CREDENTIAL_ID);
    return updateManager.setTokenConfigured(false);
  });
  handle('link:update-check', async (): Promise<LinkUpdateStatus> => {
    const configured = await profileStore.hasCredential(UPDATE_CREDENTIAL_ID);
    if (!configured) return updateManager.check(null);
    const token = await profileStore.loadCredential(UPDATE_CREDENTIAL_ID);
    knownSecrets.add(token);
    return updateManager.check(token);
  });
  handle('link:update-download', (): Promise<LinkUpdateStatus> => updateManager.download());
  handle('link:update-install', async () => {
    if (runtimeActive) throw new Error('联动尚未停止；请先到集成中心停止联动并完成 OBS 清理，再安装更新');
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
    allowWindowClose = true;
    updateManager.install();
  });
  handle('link:set-document-dirty', (_event, dirtyValue: unknown) => {
    documentDirty = linkDocumentDirtySchema.parse(dirtyValue);
  });
  handle('link:set-runtime-active', (_event, activeValue: unknown) => {
    runtimeActive = linkRuntimeActiveSchema.parse(activeValue);
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
    await Promise.all((['obs', 'p1'] as const).map(async (id) => {
      const application = detection.applications[id];
      if (!application.executablePath || !application.workingDirectory) return;
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
    return { path, project: await projectService.open(path) };
  });
  handle('link:open-project', async (_event, pathValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue);
    return { path, project: await projectService.open(path) };
  });
  handle('link:save-project', async (_event, pathValue: unknown, projectValue: unknown) => {
    const project = parseLinkProject(projectValue);
    let destination = linkOptionalFilePathSchema.parse(pathValue);
    if (!destination) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '保存团播联动工程',
        defaultPath: `${safeFileName(project.name)}.tblink`,
        filters: [{ name: '团播联动工程', extensions: ['tblink'] }]
      });
      if (result.canceled || !result.filePath) return null;
      destination = result.filePath;
    }
    await projectService.save(destination, project);
    return destination;
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
  handle('link:ensure-media-audio-url', async (_event, payloadValue: unknown) => {
    const payload = linkMediaPreviewPayloadSchema.parse(payloadValue);
    if (payload.kind === 'image') throw new Error('图片素材不包含音轨');
    return createAssetUrl(await mediaPreviewService.ensureAudioPreview(payload.projectPath, payload.relativePath, payload.sha256));
  });
  const waveformService = new WaveformService(projectService);
  const audioEditService = new AudioEditService(projectService, ibtExecutable(app.isPackaged ? process.resourcesPath : undefined));
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
  handle('link:p1-import-project', (_event, payloadValue: unknown) => {
    const payload = linkP1ProjectImportPayloadSchema.parse(payloadValue);
    return p1ProjectService.importProject(payload.p1ProjectPath, payload.linkProjectPath);
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
    const payload = linkIntegrationProfileSavePayloadSchema.parse(payloadValue);
    const profile = payload.profile;
    if (payload.obsPassword !== undefined) {
      await profileStore.saveCredential(profile.obs.credentialId, payload.obsPassword);
      knownSecrets.add(payload.obsPassword);
    }
    await profileStore.saveProfile(profile);
  });
  handle('link:security-availability', () => safeStorage.isEncryptionAvailable());
  handle('link:security-preflight', async () => {
    try {
      const profile = await requireProfile(profileStore);
      const password = await profileStore.loadCredential(profile.obs.credentialId);
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
    const password = await profileStore.loadCredential(profile.obs.credentialId);
    knownSecrets.add(password);
    const snapshot = await obs.connect(profile.obs.webSocketUrl, password, profile.obs.startupTimeoutMs);
    if (snapshot.status === 'connected' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.obs.webSocketUrl).hostname)) await nativeSeek.prepare(profile.obs.webSocketUrl);
    return snapshot;
  };
  handle('link:obs-disconnect', () => obs.disconnect());
  handle('link:obs-snapshot', () => obs.getSnapshot());
  handle('link:obs-inventory', (): Promise<LinkObsInventory> => obs.readInventory());
  handle('link:obs-media-scenes-prepare', async (_event, pathValue: unknown, projectValue: unknown, preciseSeekingValue: unknown) => {
    const path = linkFilePathSchema.parse(pathValue); const project = parseLinkProject(projectValue);
    const preciseSeeking = z.boolean().parse(preciseSeekingValue);
    if (obs.getSnapshot().status !== 'connected') throw new Error('请先连接 OBS，再同步素材独立场景');
    await projectService.inspectAssets(path, project);
    for (const asset of project.mediaAssets) {
      const absolutePath = projectService.resolveMediaAsset(path, asset.relativePath);
      if (!(await stat(absolutePath)).isFile()) throw new Error(`素材文件不可读：${asset.name}`);
      const cachePath = join(dirname(path), 'cache', 'obs-seek-jpeg2000', `${asset.sha256}.mkv`);
      const playbackPath = preciseSeeking && asset.kind === 'video'
        ? await mediaPreviewService.ensureObsSeekVideo(path, asset.relativePath, asset.sha256) : absolutePath;
      await obs.mediaScenes.prepare(project.projectId, asset, absolutePath, playbackPath, cachePath);
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
  handle('link:obs-live-edit', async (_event, value: unknown) => {
    try { await obs.liveEditor.edit(obsLiveEditSchema.parse(value)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  const livePreview = new ObsLivePreview();
  const nativeSeek = new ObsNativeSeek();
  obs.subscribe((state) => { if (state.status !== 'connected') nativeSeek.reset(); });
  handle('link:obs-seek-managed-media', async (_event, value: unknown) => {
    if (obs.getSnapshot().status !== 'connected') throw new Error('OBS 未连接');
    const payload = linkManagedMediaExecutionPayloadSchema.parse(value);
    const absolutePath = projectService.resolveMediaAsset(payload.projectPath, payload.event.relativePath);
    const address = (await requireProfile(profileStore)).obs.webSocketUrl;
    try { await obs.mediaScenes.seek(payload.event, absolutePath, (name, position) => nativeSeek.seek(address, name, position)); }
    catch (error) { await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) }); throw error; }
  });
  handle('link:obs-connect', connectObs);
  let liveBridgeInstalled = false;
  let liveBridgeInstallation: Promise<'installed' | 'unchanged'> | null = null;
  const ensureLiveBridge = async (): Promise<void> => {
    if (liveBridgeInstalled) return;
    liveBridgeInstallation ??= installObsLiveBridge(app.isPackaged
      ? join(process.resourcesPath, 'obs/tblink-realtime-preview.dll')
      : join(app.getAppPath(), '../../tools/obs/native-preview/tblink-realtime-preview.dll'));
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
        : join(app.getAppPath(), '../../tools/obs/native-preview/tblink-realtime-preview.dll'),
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
  handle('link:obs-activate-managed-output', () => obs.activateManagedOutput());
  handle('link:obs-internal-audio', async (_event, value: unknown) => {
    if (!mainWindow) throw new Error('主控窗口不存在');
    const profile = await requireProfile(profileStore);
    const payload = linkInternalAudioCaptureSchema.parse(value);
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
    // OBS loads native modules at startup; deploy the bundled bridge before launch.
    if (id === 'obs') {
      try { await bridgeSetup.prepare(); }
      catch (error) {
        await logger.record({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: String(error) });
        throw error;
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
    if (!profile) return (['obs', 'p1'] as const).map((id) => processManager.getSnapshot(id));
    return Promise.all((['obs', 'p1'] as const)
      .map((id) => processManager.refresh(id, processConfiguration(profile, id))));
  });
  handle('link:log-record', (_event, entryValue: unknown) => logger.record(parseLogRecord(entryValue)));
  handle('link:log-query', (_event, filterValue: unknown) => logger.query(parseLogFilter(filterValue)));
  handle('link:diagnostic-export', async (_event, contextValue: unknown) => {
    const context = linkDiagnosticContextSchema.parse(contextValue);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出脱敏诊断包',
      defaultPath: `团播联动台-诊断-${new Date().toISOString().replaceAll(':', '-')}.tbdiag.gz`,
      filters: [{ name: '团播联动台诊断包', extensions: ['tbdiag.gz'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await logger.exportDiagnosticPackage(result.filePath, context);
    return result.filePath;
  });
}

function registerAssetProtocol(): void {
  protocol.handle('tblink-asset', async (request) => {
    const url = new URL(request.url);
    const token = url.pathname.slice(1);
    const path = assetTokens.get(token);
    if (!path) return new Response('Asset token not found', { status: 404 });
    const fileStat = await stat(path);
    const range = request.headers.get('range');
    const baseHeaders = {
      'Content-Type': mimeType(path),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    if (!range) {
      const content = await readFile(path);
      return new Response(content, { headers: { ...baseHeaders, 'Content-Length': String(fileStat.size) } });
    }
    const bounds = parseByteRange(range, fileStat.size);
    if (!bounds) return new Response('Invalid byte range', { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${fileStat.size}` } });
    const length = bounds.end - bounds.start + 1;
    const content = Buffer.allocUnsafe(length);
    const file = await open(path, 'r');
    try {
      await file.read(content, 0, length, bounds.start);
    } finally {
      await file.close();
    }
    return new Response(content, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(length),
        'Content-Range': `bytes ${bounds.start}-${bounds.end}/${fileStat.size}`
      }
    });
  });
}

async function runQuitFlow(profileStore: SecureProfileStore, processManager: ExternalProcessManager): Promise<void> {
  const owned = (['p1', 'obs'] as const)
    .map((id) => processManager.getSnapshot(id))
    .filter((snapshot) => snapshot.owned && snapshot.pid !== null);
  if (owned.length === 0) {
    allowWindowClose = true;
    app.quit();
    return;
  }
  const closeIds: ExternalApplicationId[] = [];
  for (const snapshot of owned) {
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
    for (const id of ['p1', 'obs'] as const) {
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
  allowWindowClose = true;
  app.quit();
}

function showRuntimeActiveExitWarning(): void {
  const options = {
    type: 'warning' as const,
    title: '联动尚未停止',
    message: '当前运行会话仍可能控制 OBS 输出。',
    detail: '请到集成中心点击“停止联动”并等待状态回到“待机”；联动台会先隐藏和停止全部受管来源，再允许退出。',
    buttons: ['返回集成中心'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBoxSync(mainWindow, options);
  else dialog.showMessageBoxSync(options);
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
  return profile.p1;
}

async function requireProfile(store: SecureProfileStore) {
  const profile = await store.loadProfile();
  if (!profile) throw new Error('尚未配置本机集成档案');
  return profile;
}

function handle<Arguments extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Arguments) => Result | Promise<Result>
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
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

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
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
    ...(filter.result !== undefined ? { result: filter.result } : {})
  };
}

void bootstrap().catch((error: unknown) => {
  dialog.showErrorBox('团播联动台启动失败', error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});
