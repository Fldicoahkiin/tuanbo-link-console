import type { ObsLiveScene, ObsLiveEdit, AudioBeatAnalysis, AudioSegment } from '@tb/schema';
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
  tokenConfigured: boolean;
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
  sourcePath: string;
  sourceSha256: string;
  playlists: P1PlaylistBinding[];
  items: Array<{
    title: string;
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
  id: 'obs' | 'p1';
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
  applications: Record<LinkProcessSnapshot['id'], LinkDetectedApplication>;
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
  exportMa2Plugin: () => Promise<string | null>;
  exportObsPreviewScript: () => Promise<string>;
  getObsPreviewStatus: () => Promise<{ ready: boolean; message: string }>;
  discoverMa2(): Promise<import('@tb/schema').Ma2Discovery>;
  cancelMa2Discovery(): Promise<void>;
  checkMa2Capabilities(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  getMa2NetworkStatus(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  saveMa2Network(payload: import('@tb/schema').Ma2NetworkSave): Promise<import('@tb/schema').Ma2NetworkStatus>;
  connectMa2Network(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  disconnectMa2Network(): Promise<import('@tb/schema').Ma2NetworkStatus>;
  exchangeMa2(payload: import('@tb/schema').Ma2BridgeRequest): Promise<string>;
  previewMa2(payload: import('@tb/schema').Ma2ReadRequest): Promise<import('@tb/schema').Ma2TimecodePreview>;
  createMa2(payload: import('@tb/schema').Ma2CreateRequest): Promise<import('@tb/schema').Ma2TimecodePreview>;
  readMa2Executor(payload: import('@tb/schema').Ma2ExecutorReadRequest): Promise<import('@tb/schema').Ma2ExecutorPreview>;
  compareMa2(payload: import('@tb/schema').Ma2CompareRequest): Promise<import('./ma2-sync').Ma2SyncPreview>;
  applyMa2(payload: import('@tb/schema').Ma2ApplyRequest): Promise<import('@tb/schema').Ma2ApplyResult>;
  getAppInfo(): Promise<LinkAppInfo>;
  getUpdateStatus(): Promise<LinkUpdateStatus>;
  saveUpdateToken(token: string): Promise<LinkUpdateStatus>;
  clearUpdateToken(): Promise<LinkUpdateStatus>;
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
  renderAudioSegments(payload: { projectPath: string; source: ReferenceAudio; segments: AudioSegment[] }): Promise<ReferenceAudio>;
  saveWaveformCache(payload: { projectPath: string; sha256: string; peaks: number[] }): Promise<void>;
  inspectProjectAssets(path: string, project: LinkProject): Promise<LinkProjectAssetInspection>;
  detectCurrentP1Project(): Promise<string>;
  pickP1Project(): Promise<string | null>;
  importP1Project(payload: { p1ProjectPath: string; linkProjectPath: string }): Promise<LinkP1ProjectImportResult>;
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
  editObsLiveScene(edit: ObsLiveEdit): Promise<void>;
  onObsLiveChanged(listener: () => void): () => void;
  getObsLiveFrame(): Promise<{ width: number; height: number; sequence: number; timestampNs: string; rgba: Uint8Array }>;
  closeObsLivePreview(): Promise<void>;
  getObsSourceScreenshot(payload: { sourceName: string; width?: number; height?: number }): Promise<string>;
  executeObsAction(action: LinkAction): Promise<void>;
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
  }): Promise<LinkLogEntryDto[]>;
  exportDiagnosticPackage(context: Readonly<Record<string, unknown>>): Promise<string | null>;
  onObsStatus(listener: (snapshot: LinkObsSnapshot) => void): () => void;
  onObsInventoryChanged(listener: () => void): () => void;
  onProcessStatus(listener: (snapshot: LinkProcessSnapshot) => void): () => void;
  onUpdateStatus(listener: (status: LinkUpdateStatus) => void): () => void;
};

export type LinkFileBridge = {
  getPathForFile(file: File): string;
};
