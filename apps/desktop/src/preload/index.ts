import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { LinkDesktopApi, LinkFileBridge, LinkObsSnapshot, LinkProcessSnapshot, LinkUpdateStatus } from '@tb/core/link';

const tbLink: LinkDesktopApi = {
  exportMa2Plugin: () => ipcRenderer.invoke('link:ma2-export-plugin'),
  exportObsPreviewScript: () => ipcRenderer.invoke('link:obs-preview-script'),
  getObsPreviewStatus: () => ipcRenderer.invoke('link:obs-preview-status'),
  discoverMa2: () => ipcRenderer.invoke('link:ma2-discover'),
  cancelMa2Discovery: () => ipcRenderer.invoke('link:ma2-discovery-cancel'),
  checkMa2Capabilities: () => ipcRenderer.invoke('link:ma2-capabilities'),
  getMa2NetworkStatus: () => ipcRenderer.invoke('link:ma2-network-status'),
  saveMa2Network: (payload) => ipcRenderer.invoke('link:ma2-network-save', payload),
  connectMa2Network: () => ipcRenderer.invoke('link:ma2-network-connect'),
  disconnectMa2Network: () => ipcRenderer.invoke('link:ma2-network-disconnect'),
  exchangeMa2: (payload) => ipcRenderer.invoke('link:ma2-exchange', payload),
  previewMa2: (payload) => ipcRenderer.invoke('link:ma2-preview', payload),
  createMa2: (payload) => ipcRenderer.invoke('link:ma2-create', payload),
  readMa2Executor: (payload) => ipcRenderer.invoke('link:ma2-executor', payload),
  compareMa2: (payload) => ipcRenderer.invoke('link:ma2-compare', payload),
  applyMa2: (payload) => ipcRenderer.invoke('link:ma2-apply', payload),
  getAppInfo: () => ipcRenderer.invoke('link:app-info'),
  getUpdateStatus: () => ipcRenderer.invoke('link:update-status'),
  saveUpdateToken: (token) => ipcRenderer.invoke('link:update-save-token', token),
  clearUpdateToken: () => ipcRenderer.invoke('link:update-clear-token'),
  checkForUpdates: () => ipcRenderer.invoke('link:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('link:update-download'),
  installUpdate: () => ipcRenderer.invoke('link:update-install'),
  setDocumentDirty: (dirty) => ipcRenderer.invoke('link:set-document-dirty', dirty),
  setRuntimeActive: (active) => ipcRenderer.invoke('link:set-runtime-active', active),
  controlWindow: (action) => ipcRenderer.invoke('link:window-control', action),
  detectLocalIntegrations: () => ipcRenderer.invoke('link:detect-local-integrations'),
  loopMidi: (action) => ipcRenderer.invoke('link:loop-midi', action),
  pickExecutable: () => ipcRenderer.invoke('link:pick-executable'),
  createProject: (name) => ipcRenderer.invoke('link:create-project', name),
  pickOpenProject: () => ipcRenderer.invoke('link:pick-open-project'),
  openProject: (path) => ipcRenderer.invoke('link:open-project', path),
  saveProject: (path, project) => ipcRenderer.invoke('link:save-project', path, project),
  importReferenceAudio: (payload) => ipcRenderer.invoke('link:import-reference-audio', payload),
  resolveReferenceAudioUrl: (payload) => ipcRenderer.invoke('link:resolve-reference-audio-url', payload),
  importMediaAsset: (payload) => ipcRenderer.invoke('link:import-media-asset', payload),
  resolveMediaAssetUrl: (payload) => ipcRenderer.invoke('link:resolve-media-asset-url', payload),
  ensureMediaPreviewUrl: (payload) => ipcRenderer.invoke('link:ensure-media-preview-url', payload),
  ensureMediaAudioUrl: (payload) => ipcRenderer.invoke('link:ensure-media-audio-url', payload),
  loadWaveformCache: (payload) => ipcRenderer.invoke('link:load-waveform-cache', payload),
  generateWaveform: (payload) => ipcRenderer.invoke('link:generate-waveform', payload),
  analyzeAudioBeats: (payload) => ipcRenderer.invoke('link:analyze-audio-beats', payload),
  renderAudioSegments: (payload) => ipcRenderer.invoke('link:render-audio-segments', payload),
  saveWaveformCache: (payload) => ipcRenderer.invoke('link:save-waveform-cache', payload),
  inspectProjectAssets: (path, project) => ipcRenderer.invoke('link:inspect-project-assets', path, project),
  detectCurrentP1Project: () => ipcRenderer.invoke('link:p1-detect-current-project'),
  pickP1Project: () => ipcRenderer.invoke('link:p1-pick-project'),
  importP1Project: (payload) => ipcRenderer.invoke('link:p1-import-project', payload),
  previewP1ProjectExport: (payload) => ipcRenderer.invoke('link:p1-preview-export', payload),
  exportP1Project: (payload) => ipcRenderer.invoke('link:p1-export-project', payload),
  loadIntegrationProfile: () => ipcRenderer.invoke('link:load-profile'),
  saveIntegrationProfile: (payload) => ipcRenderer.invoke('link:save-profile', payload),
  getSecurityAvailability: () => ipcRenderer.invoke('link:security-availability'),
  getSecurityPreflight: () => ipcRenderer.invoke('link:security-preflight'),
  connectObs: () => ipcRenderer.invoke('link:obs-connect'),
  disconnectObs: () => ipcRenderer.invoke('link:obs-disconnect'),
  getObsSnapshot: () => ipcRenderer.invoke('link:obs-snapshot'),
  createObsSource: (payload) => ipcRenderer.invoke('link:obs-source-create', payload),
  readObsSourceOptions: (name) => ipcRenderer.invoke('link:obs-source-options', name),
  applyObsSource: (payload) => ipcRenderer.invoke('link:obs-source-apply', payload),
  cancelObsSource: (name) => ipcRenderer.invoke('link:obs-source-cancel', name),
  readObsInventory: () => ipcRenderer.invoke('link:obs-inventory'),
  prepareObsMediaScenes: (projectPath, project, preciseSeeking) => ipcRenderer.invoke('link:obs-media-scenes-prepare', projectPath, project, preciseSeeking),
  readObsOutputStatus: () => ipcRenderer.invoke('link:obs-output-status'),
  readObsLiveScene: () => ipcRenderer.invoke('link:obs-live-scene'),
  editObsLiveScene: (edit) => ipcRenderer.invoke('link:obs-live-edit', edit),
  onObsLiveChanged: (listener) => { const notify = (): void => listener(); ipcRenderer.on('link:obs-live-changed', notify); return () => { ipcRenderer.removeListener('link:obs-live-changed', notify); }; },
  getObsLiveFrame: () => ipcRenderer.invoke('link:obs-live-frame'),
  closeObsLivePreview: () => ipcRenderer.invoke('link:obs-live-close'),
  getObsSourceScreenshot: (payload) => ipcRenderer.invoke('link:obs-source-screenshot', payload),
  executeObsAction: (action) => ipcRenderer.invoke('link:obs-execute', action),
  activateManagedObsOutput: () => ipcRenderer.invoke('link:obs-activate-managed-output'),
  setInternalAudioCapture: (enabled, sceneNames) => ipcRenderer.invoke('link:obs-internal-audio', { enabled, sceneNames }),
  executeManagedMediaEvent: (payload) => ipcRenderer.invoke('link:obs-execute-managed-media', payload),
  seekManagedMedia: (payload) => ipcRenderer.invoke('link:obs-seek-managed-media', payload),
  startExternalApplication: (id) => ipcRenderer.invoke('link:process-start', id),
  refreshExternalApplication: (id) => ipcRenderer.invoke('link:process-refresh', id),
  stopExternalApplication: (id) => ipcRenderer.invoke('link:process-stop', id),
  getExternalSnapshots: () => ipcRenderer.invoke('link:process-snapshots'),
  recordLog: (entry) => ipcRenderer.invoke('link:log-record', entry),
  queryLogs: (filter) => ipcRenderer.invoke('link:log-query', filter),
  exportDiagnosticPackage: (context) => ipcRenderer.invoke('link:diagnostic-export', context),
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
