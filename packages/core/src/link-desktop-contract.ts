import type { ObsLiveScene, ObsLiveEdit, AudioBeatAnalysis, AudioSegment, AudioTrack } from '@tb/schema';
import type { ObsSourceDraft, ObsSourceKind, ObsSourceOption, ObsSourceSettings } from '@tb/schema';
import type {
  IntegrationProfile,
  LinkAction,
  LinkMediaAsset,
  LinkMediaKind,
  LinkProject,
  P1MediaBinding,
  P1PlaylistBinding,
  ReferenceAudio,
  SceneItemTransform
} from '@tb/schema';

export type LinkAppInfo = {
  name: '团播联动台';
  version: string;
  platform: string;
  architecture: string;
  electronVersion: string;
  nodeVersion: string;
  availableDiskBytes: number;
};

/** Keep large project graphs out of Electron's synchronous contextBridge copy.
 * The renderer facade decodes/validates these documents in its worker. */
export type LinkDesktopBridgeApi = Omit<LinkDesktopApi, 'pickOpenProject' | 'openProject' | 'saveProject'> & {
  pickProjectDocument(): Promise<{ version: 1; path: string; content: string } | null>;
  openProjectDocument(path: string): Promise<{ version: 1; path: string; content: string }>;
  saveProjectDocument(path: string | null, content: string): Promise<string | null>;
};

export type LinkUpdatePhase =
  | 'disabled'
  | 'notConfigured'
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type LinkUpdateStatus = {
  phase: LinkUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  progressPercent: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  feedConfigured: boolean;
  message: string;
};

export type LinkProjectFile = {
  path: string;
  project: LinkProject;
};

export type LinkProjectAssetInspection = {
  referenceAudio: Record<string, { audioAvailable: boolean; waveformAvailable: boolean }>;
  media: Record<string, { fileAvailable: boolean }>;
};

export type LinkP1ProjectImportResult = {
  sourceOrder?: string[];
  skippedItems?: import('@tb/schema').P1ImportIssue[];
  sourcePath: string;
  sourceSha256: string;
  playlists: P1PlaylistBinding[];
  items: Array<{
    title: string;
    importNotes?: string;
    referenceAudio: ReferenceAudio;
    p1Media: P1MediaBinding;
  }>;
};

export type LinkP1ProjectExportPreview = {
  sourcePath: string;
  targetPath: string;
  sourceSha256: string;
  playlistCount: number;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  ignoredCount: number;
};

export type LinkP1ProjectExportResult = {
  skippedItems?: import('@tb/schema').P1ImportIssue[];
  outputPath: string;
  sourceSha256: string;
  playlists: P1PlaylistBinding[];
  itemBindings: Array<{ itemId: string; p1Media: P1MediaBinding }>;
};

export type LinkObsSnapshot = {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  obsVersion: string | null;
  webSocketVersion: string | null;
  error: string | null;
};

export type LinkObsInventory = {
  scenes: string[];
  inputs: string[];
  inputKinds: Record<string, string>;
  inputAudioStates: Record<string, { supported: boolean; muted: boolean | null; error: string | null }>;
  sceneItems: Record<string, string[]>;
  filters: Record<string, string[]>;
  transitions: string[];
  videoSettings?: { baseWidth: number; baseHeight: number; outputWidth?: number; outputHeight?: number };
  sourceSizes: Record<string, { width: number; height: number }>;
  /** Unresolved optional source geometry; other scenes remain usable. */
  sourceSizeErrors?: Record<string, string>;
  sceneItemTransforms?: Record<string, Record<string, LinkObsSceneItemTransform>>;
};

export type LinkObsSceneItemTransform = SceneItemTransform & {
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  alignment: number;
};

export type LinkProcessSnapshot = {
  id: 'obs' | 'p1' | 'ma2' | 'ma3d';
  status: 'notRunning' | 'starting' | 'running' | 'reconnecting' | 'stopping' | 'error';
  pid: number | null;
  processName: string | null;
  executablePath: string | null;
  startTime: string | null;
  windowTitle: string | null;
  fileVersion: string | null;
  owned: boolean;
  error: string | null;
};

export type LinkDetectedApplication = {
  id: LinkProcessSnapshot['id'];
  executablePath: string | null;
  workingDirectory: string | null;
  processName: string | null;
  windowTitle: string | null;
  version: string | null;
  running: boolean;
};

export type LinkLocalIntegrationDetection = {
  detectedAt: string;
  applications: Record<'obs' | 'p1', LinkDetectedApplication> & Partial<Record<'ma2' | 'ma3d', LinkDetectedApplication>>;
};

export type LinkLogEntryDto = {
  id: string;
  sessionId: string;
  timestamp: string;
  monotonicMs: number;
  level: 'info' | 'warning' | 'error';
  category: 'state' | 'action' | 'device' | 'preflight' | 'operator' | 'system';
  message: string;
  projectId?: string;
  itemId?: string;
  cueId?: string;
  actionId?: string;
  executionId?: string;
  device?: string;
  result?: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  details?: Readonly<Record<string, unknown>>;
};

export type LinkDesktopApi = {
  openNativeProgram(request: import('@tb/schema').NativeProgramOpen): Promise<void>;
  controlNativeProgram(request: import('@tb/schema').NativeProgramControl): Promise<void>;
  onNativeProgramEvent(listener: (event: import('@tb/schema').NativeProgramEvent) => void): () => void;
  projectArchives(request: import('@tb/schema').ProjectArchiveRequest): Promise<import('@tb/schema').ProjectArchiveResult>;
  projectArchiveSettings(request: import('@tb/schema').ProjectArchiveSettingsAction): Promise<import('@tb/schema').ProjectArchiveSettingsStatus>;
  prepareNativeObs(request: import('@tb/schema').NativeObsPrepare): Promise<import('@tb/schema').NativeObsStatus>;
  preloadNativeObs(request: import('@tb/schema').NativeObsPreload): Promise<void>;
  cancelNativeObsPreload(request: import('@tb/schema').NativeObsStop): Promise<void>;
  stopNativeObs(request: import('@tb/schema').NativeObsStop): Promise<void>;
  getNativeObsStatus(): Promise<import('@tb/schema').NativeObsStatus | null>;
  onNativeObsStatus(listener: (status: import('@tb/schema').NativeObsStatus) => void): () => void;
  onObsMediaPreparation(listener: (progress: import('@tb/schema').ObsMediaPreparation) => void): () => void;
  getNativePlaybackDevices(scope?: import('@tb/schema').NativeDeviceQueryRequest['scope']): Promise<import('@tb/schema').NativePlaybackDevices>;
  checkNativeMidiOutput(request: import('@tb/schema').NativeMidiCheck): Promise<void>;
  prepareNativePlayback(request: import('@tb/schema').NativePlayerPrepare): Promise<import('@tb/schema').NativePlayerStatus>;
  controlNativePlayback(request: import('@tb/schema').NativePlayerControl): Promise<import('@tb/schema').NativePlayerStatus>;
  getNativePlaybackStatus(): Promise<import('@tb/schema').NativePlayerStatus | null>;
  onNativePlaybackStatus(listener: (status: import('@tb/schema').NativePlayerStatus) => void): () => void;
  recheckMidi(): Promise<void>;
  getLicenseStatus(): Promise<import('@tb/schema').LicenseStatus>;
  exportLicenseRequest(): Promise<boolean>;
  importLicense(): Promise<import('@tb/schema').LicenseStatus | null>;
  activateLicenseCode(code: string): Promise<import('@tb/schema').LicenseStatus>;
  refreshOnlineLicense(): Promise<import('@tb/schema').LicenseStatus>;
  getPurchaseCatalog(): Promise<import('@tb/schema').PurchaseCatalogResponse>;
  listPurchases(): Promise<import('@tb/schema').PurchaseReceipt[]>;
  createPurchase(request: import('@tb/schema').PurchaseRequest): Promise<import('@tb/schema').PurchaseReceipt>;
  refreshPurchase(localId: string): Promise<import('@tb/schema').PurchaseReceipt>;
  openPurchasePayment(localId: string): Promise<void>;
  copyPurchaseCode(localId: string, licenseId: string): Promise<void>;
  requireOutputLicense(): Promise<void>;
  exportMa2Plugin: () => Promise<string | null>;
  exportObsPreviewScript: () => Promise<string>;
  getObsPreviewStatus: () => Promise<{ ready: boolean; message: string }>;
  discoverMa2(): Promise<import('@tb/schema').Ma2Discovery>;
  getMa2NetworkSetup(): Promise<import('@tb/schema').Ma2NetworkSetupState>;
  planMa2NetworkSetup(request: import('@tb/schema').Ma2NetworkSetupRequest): Promise<import('@tb/schema').Ma2NetworkSetupPlan>;
  applyMa2NetworkSetup(id: string): Promise<import('@tb/schema').Ma2NetworkSetupState>;
  restoreMa2NetworkSetup(id: string): Promise<import('@tb/schema').Ma2NetworkSetupState>;
  cancelMa2Discovery(): Promise<void>;
  checkMa2Capabilities(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  playMa2Cue(payload: import('@tb/schema').Ma2PlaybackRequest): Promise<void>;
  cancelMa2Playback(sessionId: string): Promise<void>;
  playMa2Audition(payload: import('@tb/schema').Ma2AuditionRequest): Promise<void>;
  controlMa2Audition(payload: import('@tb/schema').Ma2AuditionControl): Promise<import('@tb/schema').Ma2AuditionState>;
  onMa2AuditionState(listener:(state:import('@tb/schema').Ma2AuditionState)=>void):()=>void;
  getMa2NetworkStatus(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  /** Show file loaded on the connected network console. */
  getMa2CurrentShow(): Promise<string>;
  saveMa2Network(payload: import('@tb/schema').Ma2NetworkSave): Promise<import('@tb/schema').Ma2NetworkStatus>;
  connectMa2Network(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  disconnectMa2Network(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  exchangeMa2(payload: import('@tb/schema').Ma2BridgeRequest): Promise<string>;
  previewMa2(payload: import('@tb/schema').Ma2ReadRequest): Promise<import('@tb/schema').Ma2TimecodePreview>;
  readMa2Catalog(payload: import('@tb/schema').Ma2CatalogRequest, onProgress?: (progress: import('@tb/schema').Ma2ReadProgress) => void): Promise<import('@tb/schema').Ma2Catalog>;
  readMa2EffectLibrary(payload: import('@tb/schema').Ma2CatalogRequest, onProgress?: (progress: import('@tb/schema').Ma2ReadProgress) => void): Promise<import('@tb/schema').Ma2EffectLibrary>;
  listMa2Layouts(payload: import('@tb/schema').Ma2LayoutDirectoryRequest): Promise<import('@tb/schema').Ma2LayoutDirectory>;
  listMa2ExecutorPages(payload: import('@tb/schema').Ma2LayoutDirectoryRequest): Promise<import('@tb/schema').Ma2ExecutorPageDirectory>;
  readMa2ExecutorPage(payload: import('@tb/schema').Ma2ExecutorPageRequest): Promise<import('@tb/schema').Ma2ExecutorPage>;
  updateMa2Executor(payload: import('@tb/schema').Ma2ExecutorUpdateRequest): Promise<import('@tb/schema').Ma2ExecutorUpdateResult>;
  inputMa2Executor(payload: import('@tb/schema').Ma2ExecutorInput): Promise<void>;
  releaseMa2Executors(): Promise<void>;
  connectMa2Live(payload: import('@tb/schema').Ma2LiveConnect): Promise<import('@tb/schema').Ma2LiveSnapshot>;
  readMa2Live(payload: import('@tb/schema').Ma2LiveRequest): Promise<import('@tb/schema').Ma2LiveSnapshot>;
  inputMa2Live(payload: import('@tb/schema').Ma2LiveInput): Promise<void>;
  releaseMa2Live(): Promise<void>;
  updateMa2Layout(payload: import('@tb/schema').Ma2LayoutUpdateRequest): Promise<import('@tb/schema').Ma2LayoutSnapshot>;
  readMa2Layout(payload: import('@tb/schema').Ma2LayoutReadRequest): Promise<import('@tb/schema').Ma2LayoutSnapshot>;
  prepareMa2CueDeletion(payload: import('@tb/schema').Ma2CueDeletePrepare, onProgress?: (progress: import('@tb/schema').Ma2ReadProgress) => void): Promise<import('@tb/schema').Ma2CueDeletePlan>;
  commitMa2CueDeletion(payload: import('@tb/schema').Ma2CueDeleteCommit, onProgress?: (progress: import('@tb/schema').Ma2ReadProgress) => void): Promise<import('@tb/schema').Ma2CueDeleteResult>;
  syncMa2Song(payload: import('@tb/schema').Ma2SongSyncRequest, onProgress?: (progress: import('@tb/schema').Ma2ReadProgress) => void): Promise<import('@tb/schema').Ma2SongSyncResult>;
  checkMa2Song(payload: import('@tb/schema').Ma2SongCheckRequest): Promise<boolean>;
  createMa2Cue(payload: import('@tb/schema').Ma2NewCueRequest): Promise<import('@tb/schema').Ma2NewCueResult>;
  cancelMa2Read(id: string): Promise<void>;
  createMa2(payload: import('@tb/schema').Ma2CreateRequest): Promise<import('@tb/schema').Ma2TimecodePreview>;
  readMa2Executor(payload: import('@tb/schema').Ma2ExecutorReadRequest): Promise<import('@tb/schema').Ma2ExecutorPreview>;
  compareMa2(payload: import('@tb/schema').Ma2CompareRequest): Promise<import('./ma2-sync').Ma2SyncPreview>;
  applyMa2(payload: import('@tb/schema').Ma2ApplyRequest): Promise<import('@tb/schema').Ma2ApplyResult>;
  prepareMa2AutoBindings(payload: import('@tb/schema').Ma2AutoBindRequest): Promise<import('@tb/schema').Ma2AutoBindResult>;
  renameMa2Object(payload: import('@tb/schema').Ma2RenameRequest): Promise<import('@tb/schema').Ma2RenameResult>;
  getAppInfo(): Promise<LinkAppInfo>;
  getUpdateStatus(): Promise<LinkUpdateStatus>;
  checkForUpdates(): Promise<LinkUpdateStatus>;
  downloadUpdate(): Promise<LinkUpdateStatus>;
  installUpdate(): Promise<void>;
  setDocumentDirty(dirty: boolean): Promise<void>;
  setRuntimeActive(active: boolean): Promise<void>;
  controlWindow(action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void>;
  detectLocalIntegrations(): Promise<LinkLocalIntegrationDetection>;
  loopMidi(action: 'detect' | 'start' | 'download'): Promise<import('@tb/schema').LoopMidiStatus>;
  pickExecutable(): Promise<string | null>;
  createProject(name: string): Promise<LinkProject>;
  pickOpenProject(): Promise<LinkProjectFile | null>;
  openProject(path: string): Promise<LinkProjectFile>;
  saveProject(path: string | null, project: LinkProject): Promise<string | null>;
  importReferenceAudio(payload: { projectPath: string; sourcePath: string; durationMs: number }): Promise<ReferenceAudio>;
  resolveReferenceAudioUrl(payload: { projectPath: string; relativePath: string }): Promise<string>;
  importMediaAsset(payload: {
    projectPath: string;
    sourcePath: string;
    name: string;
    kind: LinkMediaKind;
    durationMs?: number;
    width?: number;
    height?: number;
  }): Promise<LinkMediaAsset>;
  resolveMediaAssetUrl(payload: { projectPath: string; relativePath: string }): Promise<string>;
  ensureMediaPreviewUrl(payload: { projectPath: string; relativePath: string; sha256: string; kind: LinkMediaKind }): Promise<string>;
  ensureMediaAudioUrl(payload: { projectPath: string; relativePath: string; sha256: string; kind: LinkMediaKind }): Promise<string>;
  loadWaveformCache(payload: { projectPath: string; sha256: string }): Promise<number[] | null>;
  generateWaveform(payload: { projectPath: string; sha256: string; url: string; durationMs: number }): Promise<number[]>;
  analyzeAudioBeats(payload: { projectPath: string; source: ReferenceAudio }): Promise<AudioBeatAnalysis>;
  analyzeMusic(payload: import('@tb/schema').MusicAnalysisRequest, onProgress?: (progress: import('@tb/schema').MusicAnalysisProgress) => void): Promise<import('@tb/schema').MusicAnalysisResult>;
  cancelMusicAnalysis(payload: { version: 1; taskId: string }): Promise<void>;
  getAutomaticMusicStatus(): Promise<import('@tb/schema').AutomaticMusicStatus>;
  startAutomaticMusicAnalysis(payload: import('@tb/schema').AutomaticMusicRequest): Promise<import('@tb/schema').AutomaticMusicJob>;
  controlAutomaticMusicAnalysis(payload: { version: 1; taskId: string; action: 'cancel' | 'resume' }): Promise<void>;
  onAutomaticMusicJob(listener: (job: import('@tb/schema').AutomaticMusicJob) => void): () => void;
  startMusicMonitor(payload: import('@tb/schema').MusicMonitorRequest): Promise<import('@tb/schema').MusicMonitorStatus>;
  onMusicMonitorStatus(listener: (status: import('@tb/schema').MusicMonitorStatus) => void): () => void;
  stopMusicMonitor(): Promise<void>;
  renderAudioSegments(payload: { projectPath: string; source: ReferenceAudio; segments: AudioSegment[]; tracks?: AudioTrack[] }): Promise<ReferenceAudio>;
  saveWaveformCache(payload: { projectPath: string; sha256: string; peaks: number[] }): Promise<void>;
  inspectProjectAssets(path: string, project: LinkProject): Promise<LinkProjectAssetInspection>;
  inspectMediaAssets(payload: import('@tb/schema').LinkMediaInspectionPayload): Promise<LinkProjectAssetInspection['media']>;
  ensureMediaThumbnailUrl(payload: { projectPath: string; relativePath: string; sha256: string; kind: LinkMediaKind }): Promise<string>;
  detectCurrentP1Project(): Promise<string>;
  pickP1Project(): Promise<string | null>;
  importP1Project(payload: { p1ProjectPath: string; linkProjectPath: string; progressId?: string }, onProgress?: (progress: import('@tb/schema').LinkP1ProjectImportProgress) => void): Promise<LinkP1ProjectImportResult>;
  cancelP1Import(id: string): Promise<void>;
  previewP1ProjectExport(payload: {
    p1ProjectPath: string;
    linkProjectPath: string;
    project: LinkProject;
  }): Promise<LinkP1ProjectExportPreview>;
  exportP1Project(payload: {
    p1ProjectPath: string;
    linkProjectPath: string;
    project: LinkProject;
    expectedSourceSha256: string;
  }): Promise<LinkP1ProjectExportResult>;
  loadIntegrationProfile(): Promise<IntegrationProfile | null>;
  saveIntegrationProfile(payload: { profile: IntegrationProfile; obsPassword?: string }): Promise<void>;
  getSecurityAvailability(): Promise<boolean>;
  getSecurityPreflight(): Promise<{ credentialDecryptable: boolean; logRedactionReady: boolean; error: string | null }>;
  connectObs(): Promise<LinkObsSnapshot>;
  connectLocalObs(): Promise<import('@tb/schema').LocalObsConnectionResult>;
  disconnectObs(): Promise<void>;
  getObsSnapshot(): Promise<LinkObsSnapshot>;
  createObsSource(payload: { kind: ObsSourceKind; name: string; sceneName: string }): Promise<ObsSourceDraft>;
  readObsSourceOptions(inputName: string): Promise<ObsSourceOption[]>;
  applyObsSource(payload: { inputName: string; settings: ObsSourceSettings; projectAsset?: { projectPath: string; relativePath: string } }): Promise<void>;
  cancelObsSource(inputName: string): Promise<void>;
  readObsInventory(): Promise<LinkObsInventory>;
  prepareObsMediaScenes(projectPath: string, project: LinkProject, preciseSeeking: boolean): Promise<void>;
  readObsOutputStatus(): Promise<{ streaming: boolean; recording: boolean }>;
  readObsLiveScene(): Promise<ObsLiveScene>;
  readObsBeauty(target: import('@tb/schema').BeautyTarget): Promise<import('@tb/schema').BeautyFilterState>;
  applyObsBeauty(payload: import('@tb/schema').BeautyApply): Promise<import('@tb/schema').BeautyFilterState>;
  installBeautyRuntime(): Promise<string>;
  startBeautyRuntime(payload: import('@tb/schema').BeautyStart): Promise<import('@tb/schema').BeautyRuntimeState>;
  stopBeautyRuntime(): Promise<void>;
  readBeautyRuntime(): Promise<import('@tb/schema').BeautyRuntimeState>;
  syncBeautyOutput(values: import('@tb/schema').BeautyApply['values']): Promise<import('@tb/schema').BeautyFilterState | null>;
  readBeautyComparison(target: import('@tb/schema').BeautyTarget): Promise<import('@tb/schema').BeautyComparisonFrame>;
  closeBeautyComparison(): Promise<void>;
  editObsLiveScene(edit: ObsLiveEdit): Promise<void>;
  onObsLiveChanged(listener: () => void): () => void;
  getWindowVisible(): Promise<boolean>;
  onWindowVisibilityChanged(listener: (visible: boolean) => void): () => void;
  getObsLiveFrame(): Promise<{ width: number; height: number; sequence: number; timestampNs: string; rgba: Uint8Array }>;
  closeObsLivePreview(): Promise<void>;
  repairObsBridge(): Promise<void>;
  getObsSourceScreenshot(payload: { sourceName: string; width?: number; height?: number }): Promise<string>;
  executeObsAction(action: LinkAction): Promise<void>;
  /** Full-scene mode: show or hide a source in the scene currently on program. */
  setObsProgramSourceEnabled(sourceName: string, enabled: boolean): Promise<void>;
  activateManagedObsOutput(): Promise<void>;
  setInternalAudioCapture(enabled: boolean, sceneNames?: string[]): Promise<void>;
  executeManagedMediaEvent(payload: { projectPath: string; event: import('./managed-media-timeline').ManagedMediaEvent }): Promise<void>;
  seekManagedMedia(payload: { projectPath: string; event: import('./managed-media-timeline').ManagedMediaEvent }): Promise<void>;
  startExternalApplication(id: LinkProcessSnapshot['id']): Promise<LinkProcessSnapshot>;
  refreshExternalApplication(id: LinkProcessSnapshot['id']): Promise<LinkProcessSnapshot>;
  stopExternalApplication(id: LinkProcessSnapshot['id']): Promise<LinkProcessSnapshot>;
  getExternalSnapshots(): Promise<LinkProcessSnapshot[]>;
  recordLog(entry: Omit<LinkLogEntryDto, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>): Promise<LinkLogEntryDto>;
  queryLogs(filter?: {
    sessionId?: string;
    itemId?: string;
    cueId?: string;
    device?: string;
    result?: LinkLogEntryDto['result'];
    limit?: number;
  }): Promise<LinkLogEntryDto[]>;
  exportDiagnosticPackage(context: Readonly<Record<string, unknown>>): Promise<string | null>;
  exportLogs(): Promise<string | null>;
  openLogsFolder(): Promise<void>;
  onObsStatus(listener: (snapshot: LinkObsSnapshot) => void): () => void;
  onObsInventoryChanged(listener: () => void): () => void;
  onProcessStatus(listener: (snapshot: LinkProcessSnapshot) => void): () => void;
  onUpdateStatus(listener: (status: LinkUpdateStatus) => void): () => void;
};

export type LinkFileBridge = {
  getPathForFile(file: File): string;
};
