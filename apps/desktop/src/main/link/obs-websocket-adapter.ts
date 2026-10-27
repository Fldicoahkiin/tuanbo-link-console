import { ObsLiveEditor } from './obs-live-editor';
import { ObsBeauty } from './obs-beauty';
import { ObsRequestScheduler } from './obs-request-scheduler';
import { encodeObsAudioWindow, selectObsAudioWindow } from './obs-audio-window';
import { ObsSourceManager } from './obs-source-manager';
import { ObsMediaScenes } from './obs-media-scenes';
import type { ObsEditorPreview } from './obs-editor-preview';
import { mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { LinkAction } from '@tb/schema';
import {
  MANAGED_OBS_SCENE_NAME,
  type LinkActionExecutor,
  type LinkObsSceneItemTransform,
  type ManagedMediaEvent
} from '@tb/core/link';
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js';

export type ObsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type ObsConnectionSnapshot = {
  status: ObsConnectionStatus;
  obsVersion: string | null;
  webSocketVersion: string | null;
  error: string | null;
};

export type ObsInventory = {
  scenes: string[];
  inputs: string[];
  inputKinds: Record<string, string>;
  inputAudioStates: Record<string, { supported: boolean; muted: boolean | null; error: string | null }>;
  sceneItems: Record<string, string[]>;
  filters: Record<string, string[]>;
  transitions: string[];
  videoSettings: { baseWidth: number; baseHeight: number; outputWidth?: number; outputHeight?: number };
  sourceSizes: Record<string, { width: number; height: number }>;
  sourceSizeErrors?: Record<string, string>;
  sceneItemTransforms: Record<string, Record<string, LinkObsSceneItemTransform>>;
};

export type ObsOutputStatus = {
  streaming: boolean;
  recording: boolean;
};

type StatusListener = (snapshot: ObsConnectionSnapshot) => void;

const MEDIA_ACTIONS: Record<Extract<LinkAction, { kind: 'obs.mediaAction' }>['action'], string> = {
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  start: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  next: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
  previous: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS'
};
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export class ObsWebSocketAdapter implements LinkActionExecutor {
  readonly id = 'obs-websocket-5';
  readonly liveEditor: ObsLiveEditor;
  readonly beauty: ObsBeauty;
  readonly sources: ObsSourceManager;
  readonly mediaScenes: ObsMediaScenes;
  private readonly client: OBSWebSocket;
  private readonly requests: ObsRequestScheduler;
  private readonly listeners = new Set<StatusListener>();
  private readonly inventoryListeners = new Set<() => void>();
  private readonly programListeners = new Set<() => void>();
  /** Where each program-scene source was shown, so hiding it later acts on that scene. */
  private readonly shownInProgram = new Map<string, { sceneName: string; sceneItemId: number }>();
  private snapshot: ObsConnectionSnapshot = {
    status: 'disconnected',
    obsVersion: null,
    webSocketVersion: null,
    error: null
  };

  constructor(
    private readonly screenshotsDirectory: string,
    client: OBSWebSocket = new OBSWebSocket(),
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    readonly editorPreview?: ObsEditorPreview
  ) {
    this.client = client;
    this.requests = new ObsRequestScheduler(requestTimeoutMs, error => {
      this.mediaScenes.clear(); this.editorPreview?.clear();
      this.updateSnapshot({ status: 'error', error: error.message });
    });
    this.liveEditor = new ObsLiveEditor(client, (operation, label) => this.request(operation, label), operation => this.requests.run('control', operation));
    this.beauty = new ObsBeauty(client, (operation, label) => this.request(operation, label), operation => this.requests.run('control', operation));
    this.sources = new ObsSourceManager(client, (operation, label) => this.request(operation, label), operation => this.requests.run('control', operation));
    this.mediaScenes = new ObsMediaScenes(client, (operation, label) => this.request(operation, label), operation => this.requests.run('control', operation));
    this.client.on('CurrentProgramSceneChanged', () => {
      for (const listener of this.programListeners) listener();
    });
    const inventoryChanged = (): void => { for (const listener of this.inventoryListeners) listener(); };
    for (const event of ['SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'SceneListChanged', 'CurrentSceneCollectionChanged', 'InputCreated', 'InputRemoved', 'InputNameChanged', 'SceneItemCreated', 'SceneItemRemoved'] as const) {
      this.client.on(event, inventoryChanged);
    }
    this.client.on('ConnectionClosed', (error) => {
      this.requests.invalidate(new Error(`OBS 连接已关闭：${error.message}`));
      this.mediaScenes.clear();
      this.editorPreview?.clear();
      this.updateSnapshot({ status: 'disconnected', error: error.message });
    });
    this.client.on('ConnectionError', (error) => {
      this.requests.invalidate(new Error(`OBS 连接出错：${error.message}`));
      this.editorPreview?.clear();
      this.updateSnapshot({ status: 'error', error: error.message });
    });
  }

  supports(action: LinkAction): boolean {
    return action.kind.startsWith('obs.');
  }

  getSnapshot(): ObsConnectionSnapshot {
    return { ...this.snapshot };
  }

  /** Read-only audit: monitor audio must never be captured by desktop or process inputs. */
  async assertMusicMonitorIsolation(deviceId: string, isDefault: boolean, identity: { executable: string; title: string; windowClass: string; ownerExecutable: string }): Promise<void> {
    if (this.snapshot.status !== 'connected') throw new Error('请先连接 OBS，确认监听声音不会进入直播，再开启试听');
    const response = await this.request(() => this.client.call('GetInputList'), 'GetInputList');
    const special = await this.request(() => this.client.call('GetSpecialInputs'), 'GetSpecialInputs');
    const inputs = new Set([...collectNames(response.inputs.filter(input => typeof input.inputKind === 'string' && ['wasapi_output_capture', 'wasapi_process_output_capture'].includes(input.inputKind)), 'inputName'), ...Object.values(special).filter((name): name is string => typeof name === 'string' && name.length > 0)]);
    for (const inputName of inputs) {
      const input = await this.request(() => this.client.call('GetInputSettings', { inputName }), 'GetInputSettings');
      if (!['wasapi_output_capture', 'wasapi_process_output_capture'].includes(input.inputKind)) continue;
      const muted = await this.request(() => this.client.call('GetInputMute', { inputName }), 'GetInputMute');
      if (muted.inputMuted) continue;
      const settings = input.inputSettings;
      if (input.inputKind === 'wasapi_output_capture' && (settings.device_id === deviceId || (settings.device_id === 'default' || settings.device_id === undefined) && isDefault)) throw new Error(`监听设备正被 OBS 的“${inputName}”采集，请选择不会进入直播混音的设备`);
      if (input.inputKind === 'wasapi_process_output_capture' && typeof settings.window === 'string' && settings.window.toLowerCase().endsWith(`:${identity.ownerExecutable.toLowerCase()}`)) throw new Error(`OBS 的“${inputName}”会采集联动台的所有声音，请把它改成只采集联动台的音频窗口，再开启监听`);
      if (input.inputKind === 'wasapi_process_output_capture' && typeof settings.window === 'string' && (settings.window === encodeObsAudioWindow(identity.executable, identity.title, identity.windowClass) || settings.priority !== 0 && settings.window.includes(identity.executable))) throw new Error(`OBS 的“${inputName}”可能会采集到监听声音，请改成只采集联动台的音频窗口`);
    }
  }

  subscribeMusicMonitorRouteChange(listener: () => void): () => void {
    const events = ['InputSettingsChanged', 'InputMuteStateChanged', 'InputCreated', 'CurrentSceneCollectionChanging', 'ConnectionClosed'] as const;
    for (const event of events) this.client.on(event, listener);
    return () => { for (const event of events) this.client.off(event, listener); };
  }

  getRequestDiagnostics(): { stats: ReturnType<ObsRequestScheduler['getStats']>; timings: ReturnType<ObsRequestScheduler['getTimings']> } {
    return { stats: this.requests.getStats(), timings: this.requests.getTimings() };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  subscribeInventoryChanges(listener: () => void): () => void {
    this.inventoryListeners.add(listener);
    return () => this.inventoryListeners.delete(listener);
  }

  subscribeProgramScene(listener: () => void): () => void {
    this.programListeners.add(listener);
    return () => this.programListeners.delete(listener);
  }

  async connect(url: string, password: string, timeoutMs = 10_000): Promise<ObsConnectionSnapshot> {
    this.requests.invalidate(new Error('OBS 正在更换连接，旧请求已取消'));
    this.shownInProgram.clear();
    this.updateSnapshot({
      status: this.snapshot.status === 'disconnected' ? 'connecting' : 'reconnecting',
      error: null
    });
    try {
      await withTimeout(this.client.connect(url, password, { rpcVersion: 1, eventSubscriptions: EventSubscription.All | EventSubscription.SceneItemTransformChanged }), timeoutMs, 'OBS WebSocket 连接');
      const version = await withTimeout(this.client.call('GetVersion'), this.requestTimeoutMs, 'OBS GetVersion 请求');
      this.editorPreview?.configure(url);
      this.requests.connect();
      this.updateSnapshot({
        status: 'connected',
        obsVersion: version.obsVersion,
        webSocketVersion: version.obsWebSocketVersion,
        error: null
      });
      return this.getSnapshot();
    } catch (error) {
      const message = toErrorMessage(error);
      this.updateSnapshot({ status: 'error', error: message });
      throw new Error(`OBS WebSocket 连接失败：${message}`, { cause: error });
    }
  }

  async disconnect(): Promise<void> {
    this.requests.invalidate(new Error('OBS 已断开，旧请求已取消'));
    this.editorPreview?.clear();
    await this.client.disconnect();
    this.updateSnapshot({
      status: 'disconnected',
      obsVersion: null,
      webSocketVersion: null,
      error: null
    });
  }

  execute(action: LinkAction): Promise<void> {
    const urgent = action.kind === 'obs.mediaAction' && (action.action === 'stop' || action.action === 'pause');
    return this.requests.run(urgent ? 'urgent' : 'control', () => this.executeAction(action));
  }

  guardPlaybackOperation<T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void): Promise<T> {
    return this.requests.guarded(canSend, operation, dispatched);
  }
  preparePlaybackMedia<T>(operation: () => Promise<T>): Promise<T> {
    return this.requests.run('background', operation);
  }

  private async executeAction(action: LinkAction): Promise<void> {
    if (!this.supports(action)) throw new Error(`OBS 适配器不支持 ${action.kind}`);
    if (this.snapshot.status !== 'connected') throw new Error('OBS WebSocket 还没连接');

    switch (action.kind) {
      case 'obs.setProgramScene':
        if (action.sceneLayers) { await this.mediaScenes.compose(action.sceneName, action.sceneLayers); return; }
        if (action.transition) {
          const desiredTransition = action.transition;
          await this.request(() => this.client.call('SetCurrentSceneTransition', { transitionName: desiredTransition.name }), 'SetCurrentSceneTransition');
          const transition = await this.request(() => this.client.call('GetCurrentSceneTransition'), 'GetCurrentSceneTransition');
          if (!transition.transitionFixed) await this.request(() => this.client.call('SetCurrentSceneTransitionDuration', { transitionDuration: desiredTransition.durationMs }), 'SetCurrentSceneTransitionDuration');
          const override = await this.request(() => this.client.call('GetSceneSceneTransitionOverride', { sceneName: action.sceneName }), 'GetSceneSceneTransitionOverride');
          if (override.transitionName) {
            await this.request(() => this.client.call('SetSceneSceneTransitionOverride', { sceneName: action.sceneName, transitionName: '', transitionDuration: 0 }), 'SetSceneSceneTransitionOverride');
            try { await this.mediaScenes.switchScene(action.sceneName); }
            finally { await this.request(() => this.client.call('SetSceneSceneTransitionOverride', { sceneName: action.sceneName, transitionName: override.transitionName, transitionDuration: override.transitionDuration }), '恢复场景转场覆盖'); }
            return;
          }
        }
        await this.mediaScenes.switchScene(action.sceneName);
        return;
      case 'obs.setSceneItemEnabled': {
        const sceneItemId = action.sceneName === MANAGED_OBS_SCENE_NAME
          ? await this.ensureManagedSceneItem(action.sourceName)
          : await this.getSceneItemId(action.sceneName, action.sourceName);
        await this.request(() => this.client.call('SetSceneItemEnabled', {
          sceneName: action.sceneName,
          sceneItemId,
          sceneItemEnabled: action.enabled
        }), 'SetSceneItemEnabled');
        return;
      }
      case 'obs.setSceneItemTransform': {
        const sceneItemId = action.sceneName === MANAGED_OBS_SCENE_NAME
          ? await this.ensureManagedSceneItem(action.sourceName)
          : await this.getSceneItemId(action.sceneName, action.sourceName);
        await this.request(() => this.client.call('SetSceneItemTransform', {
          sceneName: action.sceneName,
          sceneItemId,
          sceneItemTransform: {
            positionX: action.transform.positionX,
            positionY: action.transform.positionY,
            scaleX: action.transform.scaleX,
            scaleY: action.transform.scaleY,
            rotation: action.transform.rotation,
            cropTop: action.transform.cropTop,
            cropRight: action.transform.cropRight,
            cropBottom: action.transform.cropBottom,
            cropLeft: action.transform.cropLeft,
            ...(action.transform.alignment !== undefined ? { alignment: action.transform.alignment } : {})
          }
        }), 'SetSceneItemTransform');
        return;
      }
      case 'obs.setSceneItemIndex': {
        const sceneItemId = action.sceneName === MANAGED_OBS_SCENE_NAME
          ? await this.ensureManagedSceneItem(action.sourceName)
          : await this.getSceneItemId(action.sceneName, action.sourceName);
        await this.request(() => this.client.call('SetSceneItemIndex', {
          sceneName: action.sceneName,
          sceneItemId,
          sceneItemIndex: action.sceneItemIndex
        }), 'SetSceneItemIndex');
        return;
      }
      case 'obs.setSourceFilterEnabled':
        await this.request(() => this.client.call('SetSourceFilterEnabled', {
          sourceName: action.sourceName,
          filterName: action.filterName,
          filterEnabled: action.enabled
        }), 'SetSourceFilterEnabled');
        return;
      case 'obs.setInputMute':
        await this.request(() => this.client.call('SetInputMute', { inputName: action.inputName, inputMuted: action.muted }), 'SetInputMute');
        return;
      case 'obs.setInputVolume':
        await this.request(() => this.client.call('SetInputVolume', { inputName: action.inputName, inputVolumeDb: action.volumeDb }), 'SetInputVolume');
        return;
      case 'obs.mediaAction':
        await this.request(() => this.client.call('TriggerMediaInputAction', {
          inputName: action.inputName,
          mediaAction: MEDIA_ACTIONS[action.action]
        }), 'TriggerMediaInputAction');
        return;
      case 'obs.setTransition':
        await this.request(() => this.client.call('SetCurrentSceneTransition', { transitionName: action.transitionName }), 'SetCurrentSceneTransition');
        if (action.durationMs > 0) {
          await this.request(() => this.client.call('SetCurrentSceneTransitionDuration', { transitionDuration: action.durationMs }), 'SetCurrentSceneTransitionDuration');
        }
        return;
      case 'obs.saveSourceScreenshot':
        await this.saveScreenshot(action.sourceName, action.fileName);
        return;
      case 'midi.noteOn':
      case 'midi.noteOff':
      case 'midi.controlChange':
      case 'midi.programChange':
      case 'midi.showControl':
        throw new Error(`OBS 适配器不支持 ${action.kind}`);
    }
  }

  executeManagedMediaEvent(event: ManagedMediaEvent, absolutePath: string): Promise<void> {
    return this.requests.run(event.phase === 'stop' ? 'urgent' : 'control', () => this.executeMedia(event, absolutePath));
  }

  private async executeMedia(event: ManagedMediaEvent, absolutePath: string): Promise<void> {
    this.assertConnected();
    if (event.sceneName) return this.mediaScenes.execute(event, absolutePath);
    if (event.phase === 'stop') {
      const errors: unknown[] = [];
      if (event.assetKind === 'video') {
        try {
          await this.request(() => this.client.call('TriggerMediaInputAction', {
            inputName: event.sourceName,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
          }), 'TriggerMediaInputAction');
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        const sceneItemId = await this.getSceneItemId(MANAGED_OBS_SCENE_NAME, event.sourceName);
        await this.request(() => this.client.call('SetSceneItemEnabled', {
          sceneName: MANAGED_OBS_SCENE_NAME,
          sceneItemId,
          sceneItemEnabled: false
        }), 'SetSceneItemEnabled');
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new Error(`联动台在 OBS 里创建的素材没有全部停止：${errors.map(toErrorMessage).join('；')}`, {
          cause: new AggregateError(errors)
        });
      }
      return;
    }

    await this.ensureManagedScene();
    const sceneItemId = await this.ensureManagedInput(event, absolutePath);
    try {
      const video = await this.request(() => this.client.call('GetVideoSettings'), 'GetVideoSettings');
      await this.request(() => this.client.call('SetSceneItemTransform', {
        sceneName: MANAGED_OBS_SCENE_NAME,
        sceneItemId,
        sceneItemTransform: {
          positionX: event.transform.x * video.baseWidth,
          positionY: event.transform.y * video.baseHeight,
          scaleX: event.transform.scale * event.transform.scaleX,
          scaleY: event.transform.scale * event.transform.scaleY,
          rotation: event.transform.rotation,
          alignment: 0
        }
      }), 'SetSceneItemTransform');
      await this.request(() => this.client.call('SetSceneItemIndex', {
        sceneName: MANAGED_OBS_SCENE_NAME,
        sceneItemId,
        sceneItemIndex: Math.max(0, event.layerCount - event.layerIndex - 1)
      }), 'SetSceneItemIndex');
      if (event.assetKind === 'video') {
        await this.request(() => this.client.call('SetInputMute', {
          inputName: event.sourceName,
          inputMuted: !event.embeddedAudioEnabled
        }), 'SetInputMute');
      }
      if (event.assetKind === 'video') {
        await this.request(() => this.client.call('SetSceneItemEnabled', {
          sceneName: MANAGED_OBS_SCENE_NAME, sceneItemId, sceneItemEnabled: true
        }), 'SetSceneItemEnabled');
        await this.request(() => this.client.call('TriggerMediaInputAction', {
          inputName: event.sourceName,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
        }), 'TriggerMediaInputAction');
        if (event.sourceOffsetMs > 0) {
          await this.waitForMediaPlayback(event.sourceName);
          await this.request(() => this.client.call('SetMediaInputCursor', {
            inputName: event.sourceName,
            mediaCursor: event.sourceOffsetMs
          }), 'SetMediaInputCursor');
        }
      }
      await this.request(() => this.client.call('SetSceneItemEnabled', {
        sceneName: MANAGED_OBS_SCENE_NAME,
        sceneItemId,
        sceneItemEnabled: true
      }), 'SetSceneItemEnabled');
    } catch (error) {
      const cleanupErrors = await this.rollbackManagedMediaStart(event, sceneItemId);
      if (cleanupErrors.length > 0) {
        throw new Error(`联动台在 OBS 里创建的素材启动失败，也没能完全撤回：${toErrorMessage(error)}；撤回失败：${cleanupErrors.map(toErrorMessage).join('；')}`, {
          cause: new AggregateError([error, ...cleanupErrors])
        });
      }
      throw error;
    }
  }

  activateManagedOutput(): Promise<void> {
    return this.requests.run('control', () => this.activateOutput());
  }

  private async activateOutput(): Promise<void> {
    this.assertConnected();
    await this.ensureManagedScene();
    await this.request(() => this.client.call('SetCurrentProgramScene', { sceneName: MANAGED_OBS_SCENE_NAME }), 'SetCurrentProgramScene');
    const current = await this.request(() => this.client.call('GetCurrentProgramScene'), 'GetCurrentProgramScene');
    if (current.currentProgramSceneName !== MANAGED_OBS_SCENE_NAME) {
      throw new Error(`OBS 没有切换到联动台的场景，当前是 ${current.currentProgramSceneName ?? '未知场景'}`);
    }
  }

  setInternalAudioCapture(enabled: boolean, executable: string, title: string, audioDeviceId = 'default', sceneNames?: string[], windowClass?: string): Promise<void> {
    return this.requests.run(enabled ? 'control' : 'urgent', () => this.configureAudioCapture(enabled, executable, title, audioDeviceId, sceneNames, windowClass));
  }

  private async configureAudioCapture(enabled: boolean, executable: string, title: string, audioDeviceId: string, sceneNames?: string[], windowClass?: string): Promise<void> {
    this.assertConnected();
    if (enabled && await this.hasDefaultDesktopAudio(audioDeviceId)) {
      await this.setInternalAudioCapture(false, executable, title, audioDeviceId);
      return;
    }
    const name = '团播联动台·内部正式音频';
    const inputs = await this.request(() => this.client.call('GetInputList'), 'GetInputList');
    const kind = collectNameValueMap(inputs.inputs, 'inputName', 'inputKind')[name];
    if (!enabled && kind === undefined) return;
    if (kind !== undefined && kind !== 'wasapi_process_output_capture') throw new Error('联动台的音频来源名称被其他类型的来源占用了，请在 OBS 里改名');
    await this.ensureManagedScene();
    const initialWindow = windowClass ? encodeObsAudioWindow(executable, title, windowClass) : null;
    if (kind === undefined) {
      const kinds = await this.request(() => this.client.call('GetInputKindList'), 'GetInputKindList');
      if (!kinds.inputKinds.includes('wasapi_process_output_capture')) throw new Error('当前的 OBS 或 Windows 版本不支持应用音频采集，联动台的音乐暂时送不进 OBS');
      await this.request(() => this.client.call('CreateInput', { sceneName: MANAGED_OBS_SCENE_NAME, inputName: name,
        inputKind: 'wasapi_process_output_capture', inputSettings: initialWindow ? { window: initialWindow, priority: 0 } : {}, sceneItemEnabled: false }), 'CreateInput');
    }
    const sceneItemId = await this.ensureManagedSceneItem(name);
    if (enabled) {
      const properties = await this.request(() => this.client.call('GetInputPropertiesListPropertyItems', {
        inputName: name, propertyName: 'window'
      }), 'GetInputPropertiesListPropertyItems');
      const windowValue = selectObsAudioWindow(properties.propertyItems, executable, title);
      if (initialWindow && windowValue !== initialWindow) throw new Error('OBS 采集的窗口和联动台的音频对不上');
      const settings = kind === undefined ? { window: initialWindow, priority: 0 }
        : (await this.request(() => this.client.call('GetInputSettings', { inputName: name }), 'GetInputSettings')).inputSettings;
      if (settings.window !== windowValue || settings.priority !== 0) {
        await this.request(() => this.client.call('SetInputSettings', { inputName: name,
          inputSettings: { window: windowValue, priority: 0 }, overlay: false }), 'SetInputSettings');
      }
      await this.request(() => this.client.call('SetInputAudioMonitorType', {
        inputName: name, monitorType: 'OBS_MONITORING_TYPE_NONE'
      }), 'SetInputAudioMonitorType');
      await this.request(() => this.client.call('SetInputVolume', { inputName: name, inputVolumeMul: 1 }), 'SetInputVolume');
    }
    await this.request(() => this.client.call('SetInputMute', { inputName: name, inputMuted: !enabled }), 'SetInputMute');
    await this.request(() => this.client.call('SetSceneItemEnabled', { sceneName: MANAGED_OBS_SCENE_NAME,
      sceneItemId, sceneItemEnabled: enabled }), 'SetSceneItemEnabled');
    // Scene playback adds only our dedicated audio input; existing visual items and filters are untouched.
    if (enabled && sceneNames) {
      const current = await this.request(() => this.client.call('GetCurrentProgramScene'), 'GetCurrentProgramScene');
      const targets = new Set([...sceneNames, current.currentProgramSceneName]);
      targets.delete(MANAGED_OBS_SCENE_NAME);
      for (const sceneName of targets) {
        const items = await this.request(() => this.client.call('GetSceneItemList', { sceneName }), 'GetSceneItemList');
        if (!collectNames(items.sceneItems, 'sourceName').includes(name)) {
          await this.request(() => this.client.call('CreateSceneItem', { sceneName, sourceName: name, sceneItemEnabled: true }), 'CreateSceneItem');
        } else {
          const id = await this.getSceneItemId(sceneName, name);
          await this.request(() => this.client.call('SetSceneItemEnabled', { sceneName, sceneItemId: id, sceneItemEnabled: true }), 'SetSceneItemEnabled');
        }
      }
    }
  }

  private async hasDefaultDesktopAudio(audioDeviceId: string): Promise<boolean> {
    const special = await this.request(() => this.client.call('GetSpecialInputs'), 'GetSpecialInputs');
    const names = [special.desktop1, special.desktop2].filter((name): name is string => typeof name === 'string' && name.length > 0);
    let matched = 0;
    for (const inputName of names) {
      const muted = await this.request(() => this.client.call('GetInputMute', { inputName }), 'GetInputMute');
      const volume = await this.request(() => this.client.call('GetInputVolume', { inputName }), 'GetInputVolume');
      if (muted.inputMuted || volume.inputVolumeMul === 0) continue;
      const settings = await this.request(() => this.client.call('GetInputSettings', { inputName }), 'GetInputSettings');
      if (audioDeviceId !== 'default' || settings.inputSettings.device_id !== 'default') {
        throw new Error('OBS 开着桌面音频，但无法确认它和音乐用的是同一个设备。请先在 OBS 里关掉桌面音频，或把两边的播放设备都设成默认，避免声音被收两次');
      }
      const tracks = await this.request(() => this.client.call('GetInputAudioTracks', { inputName }), 'GetInputAudioTracks');
      if (tracks.inputAudioTracks['1'] !== true) throw new Error('OBS 的桌面音频没有送到音轨 1，无法保证音乐能进直播');
      matched += 1;
    }
    if (matched > 1) throw new Error('OBS 有两路桌面音频在同时采集默认设备，请只保留一路，避免声音被收两次');
    return matched === 1;
  }

  private async waitForMediaPlayback(inputName: string): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    do {
      const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName }), 'GetMediaInputStatus');
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' || status.mediaState === 'OBS_MEDIA_STATE_PAUSED') return;
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error(`OBS 无法解码媒体：${inputName}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`OBS 媒体在 ${this.requestTimeoutMs} ms 内没有准备好：${inputName}`);
  }

  readInventory(details?: { scenes: ReadonlySet<string> | null; inputs: ReadonlySet<string> }): Promise<ObsInventory> {
    return this.requests.run('background', () => this.readInventoryInSession(details));
  }

  private async readInventoryInSession(details?: { scenes: ReadonlySet<string> | null; inputs: ReadonlySet<string> }): Promise<ObsInventory> {
    this.assertConnected();
    const [sceneResponse, inputResponse, transitionResponse, videoResponse] = await Promise.all([
      this.request(() => this.client.call('GetSceneList'), 'GetSceneList'),
      this.request(() => this.client.call('GetInputList'), 'GetInputList'),
      this.request(() => this.client.call('GetSceneTransitionList'), 'GetSceneTransitionList'),
      this.request(() => this.client.call('GetVideoSettings'), 'GetVideoSettings')
    ]);
    const scenes = collectNames(sceneResponse.scenes, 'sceneName');
    const inputs = collectNames(inputResponse.inputs, 'inputName');
    const inputKinds = collectNameValueMap(inputResponse.inputs, 'inputName', 'inputKind');
    const inputAudioStates: ObsInventory['inputAudioStates'] = {};
    const sourceSizes: ObsInventory['sourceSizes'] = {};
    const sourceSizeErrors: Record<string, string> = {};
    const transitions = collectNames(transitionResponse.transitions, 'transitionName');
    const sceneItems: Record<string, string[]> = {};
    const sceneItemTransforms: Record<string, Record<string, LinkObsSceneItemTransform>> = {};
    const filters: Record<string, string[]> = {};

    const pendingGroups = new Set<string>();
    await forEachBounded(details?.scenes ? scenes.filter(name => details.scenes!.has(name)) : scenes, async (sceneName) => {
      const response = await this.request(() => this.client.call('GetSceneItemList', { sceneName }), 'GetSceneItemList');
      sceneItems[sceneName] = collectNames(response.sceneItems, 'sourceName');
      sceneItemTransforms[sceneName] = collectSceneItemTransforms(response.sceneItems);
      for (const groupName of collectNamesWhere(response.sceneItems, 'sourceName', 'isGroup')) pendingGroups.add(groupName);
    });
    const visitedGroups = new Set<string>();
    while (pendingGroups.size > 0) {
      const groupNames = [...pendingGroups].filter((groupName) => !visitedGroups.has(groupName));
      pendingGroups.clear();
      if (groupNames.length === 0) break;
      await forEachBounded(groupNames, async (groupName) => {
        visitedGroups.add(groupName);
        const response = await this.request(() => this.client.call('GetGroupSceneItemList', { sceneName: groupName }), 'GetGroupSceneItemList');
        sceneItems[groupName] = collectNames(response.sceneItems, 'sourceName');
        sceneItemTransforms[groupName] = collectSceneItemTransforms(response.sceneItems);
        for (const nestedGroupName of collectNamesWhere(response.sceneItems, 'sourceName', 'isGroup')) {
          if (!visitedGroups.has(nestedGroupName)) pendingGroups.add(nestedGroupName);
        }
      });
    }
    const detailInputs = details ? inputs.filter(name => details.inputs.has(name)) : inputs;
    const monitorInputs = detailInputs.filter((inputName) => inputKinds[inputName] === 'monitor_capture');
    const monitorResponse = monitorInputs.length > 0
      ? await this.request(() => this.client.call('GetMonitorList'), 'GetMonitorList')
      : null;
    await forEachBounded(detailInputs, async (inputName) => {
      const response = await this.request(() => this.client.call('GetSourceFilterList', { sourceName: inputName }), 'GetSourceFilterList');
      filters[inputName] = collectNames(response.filters, 'filterName');
      if (inputKinds[inputName] === 'monitor_capture' && monitorResponse) {
        const [settings, properties] = await Promise.all([
          this.request(() => this.client.call('GetInputSettings', { inputName }), 'GetInputSettings'),
          this.request(() => this.client.call('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'monitor_id' }), 'GetInputPropertiesListPropertyItems')
        ]);
        // A disconnected monitor must not erase unrelated scenes or prevent playback.
        // Only local geometry resolution is recoverable here; request failures still propagate.
        try {
          sourceSizes[inputName] = resolveMonitorCaptureSize(inputName, settings.inputSettings, properties.propertyItems, monitorResponse.monitors);
        } catch (error) {
          sourceSizeErrors[inputName] = toErrorMessage(error);
        }
      }
      try {
        const audio = await this.request(() => this.client.call('GetInputMute', { inputName }), 'GetInputMute');
        inputAudioStates[inputName] = { supported: true, muted: audio.inputMuted, error: null };
      } catch (error) {
        inputAudioStates[inputName] = { supported: false, muted: null, error: toErrorMessage(error) };
      }
    });

    return {
      scenes,
      inputs,
      inputKinds,
      inputAudioStates,
      sceneItems,
      filters,
      transitions,
      videoSettings: { baseWidth: videoResponse.baseWidth, baseHeight: videoResponse.baseHeight,
        outputWidth: videoResponse.outputWidth, outputHeight: videoResponse.outputHeight },
      sourceSizes,
      sourceSizeErrors,
      sceneItemTransforms
    };
  }

  getSourceScreenshot(sourceName: string, width?: number, height?: number): Promise<string> {
    return this.requests.run('preview', () => this.readSourceScreenshot(sourceName, width, height));
  }

  private async readSourceScreenshot(sourceName: string, width?: number, height?: number): Promise<string> {
    this.assertConnected();
    if (this.editorPreview) {
      const scenes = await this.request(() => this.client.call('GetSceneList'), '读取预览场景');
      if (scenes.scenes.some((scene) => scene.sceneName === sourceName)) {
        await this.touchScenePreview(sourceName, false, new Set());
      } else await this.editorPreview.touch(sourceName);
    }
    this.assertConnected();
    const response = await this.request(() => this.client.call('GetSourceScreenshot', {
      sourceName,
      imageFormat: 'png',
      ...(width === undefined || height === undefined ? {} : { imageWidth: width, imageHeight: height })
    }), 'GetSourceScreenshot');
    if (!response.imageData.startsWith('data:image/')) throw new Error('OBS 来源预览返回了无效图像');
    return response.imageData;
  }

  private async touchScenePreview(sceneName: string, group: boolean, visited: Set<string>): Promise<void> {
    if (visited.has(sceneName)) return;
    visited.add(sceneName);
    const result = await this.request(() => group
      ? this.client.call('GetGroupSceneItemList', { sceneName })
      : this.client.call('GetSceneItemList', { sceneName }), '读取场景预览来源');
    for (const item of result.sceneItems) {
      if (item.sceneItemEnabled !== true || typeof item.sourceName !== 'string') continue;
      if (item.isGroup === true || item.sourceType === 'OBS_SOURCE_TYPE_SCENE') {
        await this.touchScenePreview(item.sourceName, item.isGroup === true, visited);
      } else await this.editorPreview?.touch(item.sourceName);
    }
  }

  readOutputStatus(): Promise<ObsOutputStatus> {
    return this.requests.run('background', () => this.readOutputStatusInSession());
  }

  private async readOutputStatusInSession(): Promise<ObsOutputStatus> {
    this.assertConnected();
    const [stream, record] = await Promise.all([
      this.request(() => this.client.call('GetStreamStatus'), 'GetStreamStatus'),
      this.request(() => this.client.call('GetRecordStatus'), 'GetRecordStatus')
    ]);
    return { streaming: stream.outputActive, recording: record.outputActive };
  }

  /** Full-scene mode: a show/hide-source cue acts on the scene now on program,
   * whatever scene it was authored against (operator decision 2026-10-19). */
  async setSourceEnabledInProgramScene(sourceName: string, enabled: boolean): Promise<void> {
    this.assertConnected();
    const shown = enabled ? undefined : this.shownInProgram.get(sourceName);
    if (shown) {
      // The program may have changed since; hide the item where it was shown.
      this.shownInProgram.delete(sourceName);
      await this.request(() => this.client.call('SetSceneItemEnabled', { sceneName: shown.sceneName, sceneItemId: shown.sceneItemId, sceneItemEnabled: false }), 'SetSceneItemEnabled');
      return;
    }
    const current = await this.request(() => this.client.call('GetCurrentProgramScene'), 'GetCurrentProgramScene');
    const sceneName = current.currentProgramSceneName;
    if (!sceneName) throw new Error('读不到 OBS 当前的直播场景');
    const items = await this.request(() => this.client.call('GetSceneItemList', { sceneName }), 'GetSceneItemList');
    const matches = items.sceneItems.filter(item => item.sourceName === sourceName);
    const sceneItemId = matches[0]?.sceneItemId;
    if (matches.length !== 1 || typeof sceneItemId !== 'number') {
      throw new Error(matches.length ? `当前直播场景“${sceneName}”里有多个“${sourceName}”来源，无法确定用哪一个` : `当前直播场景“${sceneName}”里没有“${sourceName}”来源`);
    }
    await this.request(() => this.client.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: enabled }), 'SetSceneItemEnabled');
    if (enabled) this.shownInProgram.set(sourceName, { sceneName, sceneItemId });
  }

  private async getSceneItemId(sceneName: string, sourceName: string): Promise<number> {
    const response = await this.request(() => this.client.call('GetSceneItemId', { sceneName, sourceName }), 'GetSceneItemId');
    return response.sceneItemId;
  }

  private async ensureManagedScene(): Promise<void> {
    const response = await this.request(() => this.client.call('GetSceneList'), 'GetSceneList');
    const names = collectNames(response.scenes, 'sceneName');
    if (names.includes(MANAGED_OBS_SCENE_NAME)) return;
    await this.request(() => this.client.call('CreateScene', { sceneName: MANAGED_OBS_SCENE_NAME }), 'CreateScene');
  }

  private async ensureManagedInput(event: ManagedMediaEvent, absolutePath: string): Promise<number> {
    const expectedKind = event.assetKind === 'video' ? 'ffmpeg_source' : 'image_source';
    const settings = event.assetKind === 'video'
      ? {
          is_local_file: true,
          local_file: absolutePath,
          looping: false,
          restart_on_activate: false,
          close_when_inactive: true,
          clear_on_media_end: true
        }
      : { file: absolutePath, unload: false };
    const response = await this.request(() => this.client.call('GetInputList'), 'GetInputList');
    const kinds = collectNameValueMap(response.inputs, 'inputName', 'inputKind');
    const existingKind = kinds[event.sourceName];
    if (existingKind !== undefined && existingKind !== expectedKind) {
      throw new Error(`OBS 来源名称冲突：${event.sourceName} 已经是 ${existingKind}，联动台需要的是 ${expectedKind}`);
    }
    if (existingKind === undefined) {
      const created = await this.request(() => this.client.call('CreateInput', {
        sceneName: MANAGED_OBS_SCENE_NAME,
        inputName: event.sourceName,
        inputKind: expectedKind,
        inputSettings: settings,
        sceneItemEnabled: false
      }), 'CreateInput');
      return created.sceneItemId;
    }
    await this.request(() => this.client.call('SetInputSettings', {
      inputName: event.sourceName,
      inputSettings: settings,
      overlay: false
    }), 'SetInputSettings');
    try {
      return await this.getSceneItemId(MANAGED_OBS_SCENE_NAME, event.sourceName);
    } catch (error) {
      const created = await this.request(() => this.client.call('CreateSceneItem', {
        sceneName: MANAGED_OBS_SCENE_NAME,
        sourceName: event.sourceName,
        sceneItemEnabled: false
      }), 'CreateSceneItem');
      if (!(error instanceof Error)) throw error;
      return created.sceneItemId;
    }
  }

  private async ensureManagedSceneItem(sourceName: string): Promise<number> {
    await this.ensureManagedScene();
    const response = await this.request(() => this.client.call('GetSceneItemList', { sceneName: MANAGED_OBS_SCENE_NAME }), 'GetSceneItemList');
    if (collectNames(response.sceneItems, 'sourceName').includes(sourceName)) {
      return this.getSceneItemId(MANAGED_OBS_SCENE_NAME, sourceName);
    }
    const created = await this.request(() => this.client.call('CreateSceneItem', {
      sceneName: MANAGED_OBS_SCENE_NAME,
      sourceName,
      sceneItemEnabled: false
    }), 'CreateSceneItem');
    return created.sceneItemId;
  }

  private async rollbackManagedMediaStart(event: ManagedMediaEvent, sceneItemId: number): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (event.assetKind === 'video') {
      try {
        await this.request(() => this.client.call('TriggerMediaInputAction', {
          inputName: event.sourceName,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
        }), 'TriggerMediaInputAction');
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.request(() => this.client.call('SetSceneItemEnabled', {
        sceneName: MANAGED_OBS_SCENE_NAME,
        sceneItemId,
        sceneItemEnabled: false
      }), 'SetSceneItemEnabled');
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async saveScreenshot(sourceName: string, fileName: string): Promise<void> {
    if (basename(fileName) !== fileName) throw new Error('截图文件名不能包含路径');
    const extension = extname(fileName).toLowerCase();
    const imageFormat = extension === '.jpg' || extension === '.jpeg'
      ? 'jpg'
      : extension === '.bmp' ? 'bmp' : extension === '.png' ? 'png' : null;
    if (imageFormat === null) throw new Error('截图只支持 .png、.jpg、.jpeg 或 .bmp');
    await mkdir(this.screenshotsDirectory, { recursive: true });
    await this.request(() => this.client.call('SaveSourceScreenshot', {
      sourceName,
      imageFormat,
      imageFilePath: join(this.screenshotsDirectory, fileName)
    }), 'SaveSourceScreenshot');
  }

  private request<T>(operation: () => Promise<T>, requestName: string): Promise<T> {
    return this.requests.request(operation, requestName);
  }

  private assertConnected(): void {
    if (this.snapshot.status !== 'connected') throw new Error('OBS WebSocket 还没连接');
  }

  private updateSnapshot(update: Partial<ObsConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function collectNames(values: readonly Readonly<Record<string, unknown>>[], property: string): string[] {
  const names = values.flatMap((value) => {
    const candidate = value[property];
    return typeof candidate === 'string' ? [candidate] : [];
  });
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function collectNamesWhere(
  values: readonly Readonly<Record<string, unknown>>[],
  nameProperty: string,
  booleanProperty: string
): string[] {
  return collectNames(values.filter((value) => value[booleanProperty] === true), nameProperty);
}

function collectNameValueMap(
  values: readonly Readonly<Record<string, unknown>>[],
  nameProperty: string,
  valueProperty: string
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const name = value[nameProperty];
    const candidate = value[valueProperty];
    if (typeof name === 'string' && typeof candidate === 'string') result[name] = candidate;
  }
  return result;
}

function collectSceneItemTransforms(values: readonly Readonly<Record<string, unknown>>[]): Record<string, LinkObsSceneItemTransform> {
  const result: Record<string, LinkObsSceneItemTransform> = {};
  for (const value of values) {
    const sourceName = value.sourceName;
    const transform = value.sceneItemTransform;
    if (typeof sourceName !== 'string' || !isRecord(transform)) continue;
    const parsed = parseSceneItemTransform(transform);
    if (parsed) result[sourceName] = parsed;
  }
  return result;
}

function parseSceneItemTransform(value: Readonly<Record<string, unknown>>): LinkObsSceneItemTransform | null {
  const numbers = ['positionX', 'positionY', 'scaleX', 'scaleY', 'rotation', 'cropTop', 'cropRight', 'cropBottom', 'cropLeft', 'sourceWidth', 'sourceHeight', 'width', 'height', 'alignment'] as const;
  if (numbers.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null;
  return {
    positionX: value.positionX as number,
    positionY: value.positionY as number,
    scaleX: value.scaleX as number,
    scaleY: value.scaleY as number,
    rotation: value.rotation as number,
    cropTop: Math.max(0, Math.round(value.cropTop as number)),
    cropRight: Math.max(0, Math.round(value.cropRight as number)),
    cropBottom: Math.max(0, Math.round(value.cropBottom as number)),
    cropLeft: Math.max(0, Math.round(value.cropLeft as number)),
    sourceWidth: value.sourceWidth as number,
    sourceHeight: value.sourceHeight as number,
    outputWidth: value.width as number,
    outputHeight: value.height as number,
    alignment: Math.round(value.alignment as number)
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveMonitorCaptureSize(
  inputName: string,
  inputSettings: Record<string, unknown>,
  propertyItems: readonly Record<string, unknown>[],
  monitors: readonly Record<string, unknown>[]
): { width: number; height: number } {
  const monitorId = inputSettings.monitor_id;
  const selected = propertyItems.find((item) => item.itemValue === monitorId);
  const label = selected?.itemName;
  if (typeof monitorId !== 'string' || typeof label !== 'string') {
    throw new Error(`OBS 的显示器采集“${inputName}”没有返回能识别的显示器`);
  }
  const monitor = monitors.find((candidate) => {
    const width = candidate.monitorWidth;
    const height = candidate.monitorHeight;
    const x = candidate.monitorPositionX;
    const y = candidate.monitorPositionY;
    if (typeof width !== 'number' || typeof height !== 'number' || typeof x !== 'number' || typeof y !== 'number') return false;
    return Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(x) && Number.isFinite(y)
      && label.replace(/\s/g, '').includes(`${width}x${height}@${x},${y}`);
  });
  if (!monitor || typeof monitor.monitorWidth !== 'number' || typeof monitor.monitorHeight !== 'number'
    || monitor.monitorWidth <= 0 || monitor.monitorHeight <= 0) {
    throw new Error(`OBS 显示器采集“${inputName}”无法对应到有效显示器尺寸`);
  }
  return { width: monitor.monitorWidth, height: monitor.monitorHeight };
}

async function forEachBounded<T>(values: T[], action: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (cursor < values.length && !failed) {
      const value = values[cursor++]!;
      try { await action(value); } catch (error) { failed = true; throw error; }
    }
  }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${operation}超时（${timeoutMs} ms）`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
