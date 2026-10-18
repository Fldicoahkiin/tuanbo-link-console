import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { ma2AutoBindRequestSchema, ma2AutoBindResultSchema } from '@tb/schema';
import { ma2RenameRequestSchema, ma2RenameResultSchema } from '@tb/schema';
import { nativeProgramOpenSchema, nativeProgramControlSchema, nativeProgramEventSchema } from '@tb/schema';
import { ma2AuditionRequestSchema,ma2AuditionControlSchema,ma2AuditionStateSchema } from '@tb/schema';
import { musicAnalysisRequestSchema, musicAnalysisProgressSchema, musicAnalysisControlSchema, musicAnalysisResultSchema } from '@tb/schema';
import { automaticMusicRequestSchema, automaticMusicControlSchema, automaticMusicJobSchema, automaticMusicStatusSchema } from '@tb/schema';
import { musicMonitorRequestSchema, musicMonitorStatusSchema } from '@tb/schema';
import { projectArchiveRequestSchema, projectArchiveResultSchema } from '@tb/schema';
import { toUserErrorMessage } from '@tb/core/link';
import { ma2ReadProgressSchema, linkP1ProjectImportProgressSchema } from '@tb/schema';
import { nativePlaybackDevicesSchema, nativePlayerPrepareSchema, nativePlayerControlSchema, nativePlayerStatusSchema, nativeMidiCheckSchema } from '@tb/schema';
import { nativeObsPrepareSchema, nativeObsPreloadSchema, nativeObsStopSchema, nativeObsStatusSchema, obsMediaPreparationSchema } from '@tb/schema';
import type { LinkDesktopApi, LinkDesktopBridgeApi, LinkFileBridge, LinkObsSnapshot, LinkProcessSnapshot, LinkUpdateStatus } from '@tb/core/link';

/** Translate IPC wrappers once, before errors reach any user-facing view. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T; }
  catch (cause) {
    const error = new Error(toUserErrorMessage(cause));
    error.name = '';
    throw error;
  }
}

async function readMa2<T>(channel: string, payload: import('@tb/schema').Ma2CatalogRequest, onProgress?: (progress: import('@tb/schema').Ma2ReadProgress) => void): Promise<T> {
  if (!onProgress || !payload.progressId) return invoke(channel, payload);
  const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    const progress = ma2ReadProgressSchema.safeParse(value);
    if (progress.success && progress.data.id === payload.progressId) onProgress(progress.data);
  };
  ipcRenderer.on('link:ma2-read-progress', listener);
  try { return await invoke(channel, payload); }
  finally { ipcRenderer.removeListener('link:ma2-read-progress', listener); }
}

const tbLink: LinkDesktopBridgeApi = {
  openNativeProgram: request => invoke('link:native-program-open', nativeProgramOpenSchema.parse(request)),
  controlNativeProgram: request => invoke('link:native-program-control', nativeProgramControlSchema.parse(request)),
  onNativeProgramEvent: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(nativeProgramEventSchema.parse(value));
    ipcRenderer.on('link:native-program-event', receive);
    return () => ipcRenderer.removeListener('link:native-program-event', receive);
  },
  projectArchives: async request => projectArchiveResultSchema.parse(await invoke('link:project-archives', projectArchiveRequestSchema.parse(request))),
  preloadNativeObs: request => invoke('link:native-obs-preload', nativeObsPreloadSchema.parse(request)),
  cancelNativeObsPreload: request => invoke('link:native-obs-preload-cancel', nativeObsStopSchema.parse(request)),
  prepareNativeObs: async request => nativeObsStatusSchema.parse(await invoke('link:native-obs-prepare', nativeObsPrepareSchema.parse(request))),
  stopNativeObs: request => invoke('link:native-obs-stop', nativeObsStopSchema.parse(request)),
  getNativeObsStatus: async () => nativeObsStatusSchema.nullable().parse(await invoke('link:native-obs-status')),
  onNativeObsStatus: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(nativeObsStatusSchema.parse(value));
    ipcRenderer.on('link:native-obs-status', receive);
    return () => ipcRenderer.removeListener('link:native-obs-status', receive);
  },
  onObsMediaPreparation: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(obsMediaPreparationSchema.parse(value));
    ipcRenderer.on('link:obs-media-preparation', receive);
    return () => ipcRenderer.removeListener('link:obs-media-preparation', receive);
  },
  getNativePlaybackDevices: async (scope = 'all') => nativePlaybackDevicesSchema.parse(await invoke('link:native-player-devices', { version: 1, scope })),
  checkNativeMidiOutput: request => invoke('link:native-midi-check', nativeMidiCheckSchema.parse(request)),
  prepareNativePlayback: async request => nativePlayerStatusSchema.parse(await invoke('link:native-player-prepare', nativePlayerPrepareSchema.parse(request))),
  controlNativePlayback: async request => nativePlayerStatusSchema.parse(await invoke('link:native-player-control', nativePlayerControlSchema.parse(request))),
  getNativePlaybackStatus: async () => nativePlayerStatusSchema.nullable().parse(await invoke('link:native-player-status')),
  onNativePlaybackStatus: listener => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(nativePlayerStatusSchema.parse(value));
    ipcRenderer.on('link:native-player-status', receive);
    return () => ipcRenderer.removeListener('link:native-player-status', receive);
  },
  recheckMidi: () => invoke('link:midi-recheck'),
  getLicenseStatus: () => invoke('link:license-status'),
  exportLicenseRequest: () => invoke('link:license-export-request'),
  importLicense: () => invoke('link:license-import'),
  activateLicenseCode: (code) => invoke('link:license-activate-code', code),
  refreshOnlineLicense: () => invoke('link:license-refresh-online'),
  getPurchaseCatalog: () => invoke('link:purchase-catalog'),
  listPurchases: () => invoke('link:purchase-list'),
  createPurchase: (request) => invoke('link:purchase-create', request),
  refreshPurchase: (localId) => invoke('link:purchase-refresh', localId),
  openPurchasePayment: (localId) => invoke('link:purchase-open-payment', localId),
  copyPurchaseCode: (localId, licenseId) => invoke('link:purchase-copy-code', localId, licenseId),
  requireOutputLicense: () => invoke('link:license-require-output'),
  exportMa2Plugin: () => invoke('link:ma2-export-plugin'),
  exportObsPreviewScript: () => invoke('link:obs-preview-script'),
  getObsPreviewStatus: () => invoke('link:obs-preview-status'),
  discoverMa2: () => invoke('link:ma2-discover'),
  getMa2NetworkSetup: () => invoke('link:ma2-network-setup-state'),
  planMa2NetworkSetup: request => invoke('link:ma2-network-setup-plan', request),
  applyMa2NetworkSetup: id => invoke('link:ma2-network-setup-apply', id),
  restoreMa2NetworkSetup: id => invoke('link:ma2-network-setup-restore', id),
  cancelMa2Discovery: () => invoke('link:ma2-discovery-cancel'),
  checkMa2Capabilities: () => invoke('link:ma2-capabilities'),
  playMa2Cue: (payload) => invoke('link:ma2-play-cue', payload),
  cancelMa2Playback: (sessionId) => invoke('link:ma2-play-cancel', sessionId),
  playMa2Audition: request=>invoke('link:ma2-audition-play',ma2AuditionRequestSchema.parse(request)),
  controlMa2Audition: async request=>ma2AuditionStateSchema.parse(await invoke('link:ma2-audition-control',ma2AuditionControlSchema.parse(request))),
  onMa2AuditionState: listener=>{const receive=(_event:Electron.IpcRendererEvent,input:unknown):void=>listener(ma2AuditionStateSchema.parse(input));ipcRenderer.on('link:ma2-audition-state',receive);return()=>ipcRenderer.removeListener('link:ma2-audition-state',receive);},
  getMa2NetworkStatus: () => invoke('link:ma2-network-status'),
  saveMa2Network: (payload) => invoke('link:ma2-network-save', payload),
  connectMa2Network: () => invoke('link:ma2-network-connect'),
  disconnectMa2Network: () => invoke('link:ma2-network-disconnect'),
  exchangeMa2: (payload) => invoke('link:ma2-exchange', payload),
  previewMa2: (payload) => invoke('link:ma2-preview', payload),
  readMa2Catalog: (payload, onProgress) => readMa2('link:ma2-catalog', payload, onProgress),
  readMa2EffectLibrary: (payload, onProgress) => readMa2('link:ma2-effect-library', payload, onProgress),
  cancelMa2Read: (id) => invoke('link:ma2-read-cancel', id),
  createMa2: (payload) => invoke('link:ma2-create', payload),
  readMa2Executor: (payload) => invoke('link:ma2-executor', payload),
  compareMa2: (payload) => invoke('link:ma2-compare', payload),
  applyMa2: (payload) => invoke('link:ma2-apply', payload),
  prepareMa2AutoBindings: async payload => ma2AutoBindResultSchema.parse(await invoke('link:ma2-auto-bind', ma2AutoBindRequestSchema.parse(payload))),
  renameMa2Object: async payload => ma2RenameResultSchema.parse(await invoke('link:ma2-rename', ma2RenameRequestSchema.parse(payload))),
  getAppInfo: () => invoke('link:app-info'),
  getUpdateStatus: () => invoke('link:update-status'),
  checkForUpdates: () => invoke('link:update-check'),
  downloadUpdate: () => invoke('link:update-download'),
  installUpdate: () => invoke('link:update-install'),
  setDocumentDirty: (dirty) => invoke('link:set-document-dirty', dirty),
  setRuntimeActive: (active) => invoke('link:set-runtime-active', active),
  controlWindow: (action) => invoke('link:window-control', action),
  detectLocalIntegrations: () => invoke('link:detect-local-integrations'),
  loopMidi: (action) => invoke('link:loop-midi', action),
  pickExecutable: () => invoke('link:pick-executable'),
  createProject: (name) => invoke('link:create-project', name),
  pickProjectDocument: () => invoke('link:pick-open-project'),
  openProjectDocument: (path) => invoke('link:open-project', path),
  saveProjectDocument: (path, content) => invoke('link:save-project', path, content),
  importReferenceAudio: (payload) => invoke('link:import-reference-audio', payload),
  resolveReferenceAudioUrl: (payload) => invoke('link:resolve-reference-audio-url', payload),
  importMediaAsset: (payload) => invoke('link:import-media-asset', payload),
  resolveMediaAssetUrl: (payload) => invoke('link:resolve-media-asset-url', payload),
  ensureMediaPreviewUrl: (payload) => invoke('link:ensure-media-preview-url', payload),
  ensureMediaThumbnailUrl: (payload) => invoke('link:ensure-media-thumbnail-url', payload),
  ensureMediaAudioUrl: (payload) => invoke('link:ensure-media-audio-url', payload),
  loadWaveformCache: (payload) => invoke('link:load-waveform-cache', payload),
  generateWaveform: (payload) => invoke('link:generate-waveform', payload),
  analyzeAudioBeats: (payload) => invoke('link:analyze-audio-beats', payload),
  analyzeMusic: async (input, onProgress) => {
    const payload = musicAnalysisRequestSchema.parse(input);
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => { const progress = musicAnalysisProgressSchema.parse(value); if (progress.taskId === payload.taskId) onProgress?.(progress); };
    ipcRenderer.on('link:music-analysis-progress', listener);
    try { return musicAnalysisResultSchema.parse(await invoke('link:analyze-music', payload)); }
    finally { ipcRenderer.removeListener('link:music-analysis-progress', listener); }
  },
  cancelMusicAnalysis: payload => invoke('link:cancel-music-analysis', musicAnalysisControlSchema.parse(payload)),
  getAutomaticMusicStatus: async () => automaticMusicStatusSchema.parse(await invoke('link:automatic-music-status')),
  startAutomaticMusicAnalysis: async payload => automaticMusicJobSchema.parse(await invoke('link:automatic-music-start', automaticMusicRequestSchema.parse(payload))),
  controlAutomaticMusicAnalysis: payload => invoke('link:automatic-music-control', automaticMusicControlSchema.parse(payload)),
  onAutomaticMusicJob: listener => { const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(automaticMusicJobSchema.parse(value)); ipcRenderer.on('link:automatic-music-job', receive); return () => { ipcRenderer.removeListener('link:automatic-music-job', receive); }; },
  startMusicMonitor: async payload => musicMonitorStatusSchema.parse(await invoke('link:start-music-monitor', musicMonitorRequestSchema.parse(payload))),
  onMusicMonitorStatus: listener => { const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(musicMonitorStatusSchema.parse(value)); ipcRenderer.on('link:music-monitor-status', receive); return () => { ipcRenderer.removeListener('link:music-monitor-status', receive); }; },
  stopMusicMonitor: () => invoke('link:stop-music-monitor'),
  renderAudioSegments: (payload) => invoke('link:render-audio-segments', payload),
  saveWaveformCache: (payload) => invoke('link:save-waveform-cache', payload),
  inspectProjectAssets: (path, project) => invoke('link:inspect-project-assets', path, project),
  inspectMediaAssets: (payload) => invoke('link:inspect-media-assets', payload),
  detectCurrentP1Project: () => invoke('link:p1-detect-current-project'),
  pickP1Project: () => invoke('link:p1-pick-project'),
  importP1Project: async (payload, onProgress) => {
    if (!onProgress || !payload.progressId) return invoke('link:p1-import-project', payload);
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const progress = linkP1ProjectImportProgressSchema.safeParse(value);
      if (progress.success && progress.data.id === payload.progressId) onProgress(progress.data);
    };
    ipcRenderer.on('link:p1-import-progress', listener);
    try { return await invoke('link:p1-import-project', payload); }
    finally { ipcRenderer.removeListener('link:p1-import-progress', listener); }
  },
  cancelP1Import: (id) => invoke('link:p1-import-cancel', id),
  previewP1ProjectExport: (payload) => invoke('link:p1-preview-export', payload),
  exportP1Project: (payload) => invoke('link:p1-export-project', payload),
  loadIntegrationProfile: () => invoke('link:load-profile'),
  saveIntegrationProfile: (payload) => invoke('link:save-profile', payload),
  getSecurityAvailability: () => invoke('link:security-availability'),
  getSecurityPreflight: () => invoke('link:security-preflight'),
  connectObs: () => invoke('link:obs-connect'),
  connectLocalObs: () => invoke('link:obs-connect-local'),
  disconnectObs: () => invoke('link:obs-disconnect'),
  getObsSnapshot: () => invoke('link:obs-snapshot'),
  createObsSource: (payload) => invoke('link:obs-source-create', payload),
  readObsSourceOptions: (name) => invoke('link:obs-source-options', name),
  applyObsSource: (payload) => invoke('link:obs-source-apply', payload),
  cancelObsSource: (name) => invoke('link:obs-source-cancel', name),
  readObsInventory: () => invoke('link:obs-inventory'),
  prepareObsMediaScenes: (projectPath, project, preciseSeeking) => invoke('link:obs-media-scenes-prepare', projectPath, project, preciseSeeking),
  readObsOutputStatus: () => invoke('link:obs-output-status'),
  readObsLiveScene: () => invoke('link:obs-live-scene'),
  readObsBeauty: target => invoke('link:obs-beauty-read', target),
  applyObsBeauty: payload => invoke('link:obs-beauty-apply', payload),
  installBeautyRuntime: () => invoke('link:beauty-install'),
  startBeautyRuntime: payload => invoke('link:beauty-start', payload),
  stopBeautyRuntime: () => invoke('link:beauty-stop'),
  readBeautyRuntime: () => invoke('link:beauty-status'),
  syncBeautyOutput: values => invoke('link:beauty-output', values),
  readBeautyComparison: target => invoke('link:beauty-comparison-frame', target),
  closeBeautyComparison: () => invoke('link:beauty-comparison-close'),
  editObsLiveScene: (edit) => invoke('link:obs-live-edit', edit),
  onObsLiveChanged: (listener) => { const notify = (): void => listener(); ipcRenderer.on('link:obs-live-changed', notify); return () => { ipcRenderer.removeListener('link:obs-live-changed', notify); }; },
  getObsLiveFrame: () => invoke('link:obs-live-frame'),
  getWindowVisible: () => invoke('link:window-visible'),
  onWindowVisibilityChanged: (listener) => {
    const notify = (_event: Electron.IpcRendererEvent, visible: unknown): void => {
      if (typeof visible !== 'boolean') throw new Error('窗口可见状态无效');
      listener(visible);
    };
    ipcRenderer.on('link:window-visible', notify);
    return () => { ipcRenderer.removeListener('link:window-visible', notify); };
  },
  closeObsLivePreview: () => invoke('link:obs-live-close'),
  repairObsBridge: () => invoke('link:obs-bridge-repair'),
  getObsSourceScreenshot: (payload) => invoke('link:obs-source-screenshot', payload),
  executeObsAction: (action) => invoke('link:obs-execute', action),
  activateManagedObsOutput: () => invoke('link:obs-activate-managed-output'),
  setInternalAudioCapture: (enabled, sceneNames) => invoke('link:obs-internal-audio', { enabled, sceneNames }),
  executeManagedMediaEvent: (payload) => invoke('link:obs-execute-managed-media', payload),
  seekManagedMedia: (payload) => invoke('link:obs-seek-managed-media', payload),
  startExternalApplication: (id) => invoke('link:process-start', id),
  refreshExternalApplication: (id) => invoke('link:process-refresh', id),
  stopExternalApplication: (id) => invoke('link:process-stop', id),
  getExternalSnapshots: () => invoke('link:process-snapshots'),
  recordLog: (entry) => invoke('link:log-record', entry),
  queryLogs: (filter) => invoke('link:log-query', filter),
  exportDiagnosticPackage: (context) => invoke('link:diagnostic-export', context),
  exportLogs: () => invoke('link:log-export'),
  openLogsFolder: () => invoke('link:log-open-folder'),
  onObsStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: LinkObsSnapshot) => listener(snapshot);
    ipcRenderer.on('link:obs-status', wrapped);
    return () => ipcRenderer.removeListener('link:obs-status', wrapped);
  },
  onObsInventoryChanged: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('link:obs-inventory-changed', wrapped);
    return () => ipcRenderer.removeListener('link:obs-inventory-changed', wrapped);
  },
  onProcessStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: LinkProcessSnapshot) => listener(snapshot);
    ipcRenderer.on('link:process-status', wrapped);
    return () => ipcRenderer.removeListener('link:process-status', wrapped);
  },
  onUpdateStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: LinkUpdateStatus) => listener(status);
    ipcRenderer.on('link:update-status', wrapped);
    return () => ipcRenderer.removeListener('link:update-status', wrapped);
  }
};

const tbFile: LinkFileBridge = {
  getPathForFile: (file) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld('tbLink', tbLink);
contextBridge.exposeInMainWorld('tbFile', tbFile);

export type { LinkDesktopApi, LinkFileBridge };
