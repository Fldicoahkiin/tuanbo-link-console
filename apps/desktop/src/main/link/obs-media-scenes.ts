import type { OBSWebSocket } from 'obs-websocket-js';
import type { LinkMediaAsset } from '@tb/schema';
import { materialSceneNames, type ManagedMediaEvent } from '@tb/core/link';

type Request = <T>(promise: Promise<T>, label: string) => Promise<T>;

/** Only the dedicated input in an application-owned material scene is controlled. */
export class ObsMediaScenes {
  private readonly prepared = new Map<string, { path: string; sceneName: string; sceneItemId: number; kind: LinkMediaAsset['kind'] }>();
  private readonly active = new Set<string>();
  private readonly compositions = new Map<string, string>();
  constructor(private readonly client: OBSWebSocket, private readonly request: Request) {}
  clear(): void { this.prepared.clear(); this.active.clear(); this.compositions.clear(); }

  async prepare(projectId: string, asset: LinkMediaAsset, path: string, playbackPath = path, cachePath?: string, alphaCachePath?: string): Promise<void> {
    const { sceneName, sourceName } = materialSceneNames(projectId, asset);
    const kind = asset.kind === 'image' ? 'image_source' : 'ffmpeg_source';
    const scenes = await this.request(this.client.call('GetSceneList'), 'GetSceneList');
    const exists = scenes.scenes.some((scene) => scene.sceneName === sceneName);
    let sceneItemId: number;
    if (exists) {
      const items = await this.request(this.client.call('GetSceneItemList', { sceneName }), 'GetSceneItemList');
      const item = items.sceneItems.find((entry) => entry.sourceName === sourceName);
      if (!item || typeof item.sceneItemId !== 'number') throw new Error(`素材场景名称被占用或来源已移除：${sceneName}`);
      const settings = await this.request(this.client.call('GetInputSettings', { inputName: sourceName }), 'GetInputSettings');
      const existingPath = settings.inputSettings[asset.kind === 'image' ? 'file' : 'local_file'];
      if (settings.inputKind !== kind || typeof existingPath !== 'string' || ![path, playbackPath, cachePath, alphaCachePath].includes(existingPath)) throw new Error(`素材来源与工程文件不一致，拒绝覆盖：${sourceName}`);
      if (existingPath !== playbackPath) await this.request(this.client.call('SetInputSettings', {
        inputName: sourceName, inputSettings: { local_file: playbackPath }, overlay: true
      }), '切换素材定位文件');
      if (asset.kind !== 'image' && (settings.inputSettings.restart_on_activate !== false || settings.inputSettings.close_when_inactive !== false || settings.inputSettings.looping !== false)) {
        await this.request(this.client.call('SetInputSettings', {
          inputName: sourceName,
          inputSettings: { restart_on_activate: false, close_when_inactive: false, looping: false },
          overlay: true
        }), '关闭受管素材切场景时重播');
      }
      sceneItemId = item.sceneItemId;
    } else {
      await this.request(this.client.call('CreateScene', { sceneName }), 'CreateScene');
      const created = await this.request(this.client.call('CreateInput', {
        sceneName, inputName: sourceName, inputKind: kind, sceneItemEnabled: true,
        inputSettings: asset.kind === 'image' ? { file: playbackPath, unload: true }
          : { is_local_file: true, local_file: playbackPath, looping: false, restart_on_activate: false, close_when_inactive: false }
      }), 'CreateInput');
      sceneItemId = created.sceneItemId;
      if (asset.kind !== 'audio') {
        const canvas = await this.request(this.client.call('GetVideoSettings'), 'GetVideoSettings');
        await this.request(this.client.call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: {
          positionX: canvas.baseWidth / 2, positionY: canvas.baseHeight / 2, alignment: 0,
          boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: canvas.baseWidth, boundsHeight: canvas.baseHeight
        } }), 'SetSceneItemTransform');
      }
    }
    if (asset.kind !== 'image') {
      await this.request(this.client.call('SetInputMute', { inputName: sourceName, inputMuted: true }), '准备素材静音');
      const status = await this.request(this.client.call('GetMediaInputStatus', { inputName: sourceName }), '准备素材状态');
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
        await this.request(this.client.call('TriggerMediaInputAction', { inputName: sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }), '准备素材暂停');
        await this.waitForState(sourceName, 'OBS_MEDIA_STATE_PAUSED');
      }
    }
    this.prepared.set(sourceName, { path, sceneName, sceneItemId, kind: asset.kind });
    this.active.delete(sourceName);
  }

  async execute(event: ManagedMediaEvent, path: string): Promise<void> {
    const startedAt = performance.now();
    const target = this.prepared.get(event.sourceName);
    if (!target || target.path !== path || target.sceneName !== event.sceneName) throw new Error(`素材场景尚未准备，请重新预检：${event.assetName}`);
    const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
    if (event.phase === 'start') {
      const wasActive = this.active.has(event.sourceName);
      this.active.add(event.sourceName);
      if (event.assetKind !== 'image' && (!wasActive || event.sourceOffsetMs === 0)) {
        await this.batch([
          ...(event.deferSceneSwitch ? [] : this.muteOtherSources(target.sceneName)),
          { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } },
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
          ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }]),
          { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' } }
        ]);
        await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
      }
      if (event.assetKind !== 'image') {
        const state = await this.request(this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), 'GetMediaInputStatus');
        if (state.mediaState !== 'OBS_MEDIA_STATE_PAUSED' && state.mediaState !== 'OBS_MEDIA_STATE_PLAYING') {
          await this.request(this.client.call('TriggerMediaInputAction', { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }), '重启已结束素材');
          await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
        }
      }
      if (!event.deferSceneSwitch) requests.push(...this.muteOtherSources(target.sceneName));
      if (event.assetKind !== 'image') {
        await this.positionMedia(event.sourceName, event.sourceOffsetMs);
        requests.push(
        { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } }
        );
      }
      requests.push(
        { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
        ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }])
      );
      if (event.assetKind !== 'image') requests.push({ requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' } });
    } else {
      if (event.assetKind !== 'image') requests.push(
        { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } },
        { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } }
      );
      requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: false } });
    }
    await this.batch(requests);
    if (event.phase === 'start' && event.assetKind !== 'image') {
      await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
      const status = await this.request(this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '确认切场景后的素材位置');
      const elapsed = performance.now() - startedAt;
      if (typeof status.mediaCursor !== 'number' || status.mediaCursor < event.sourceOffsetMs - 100 || status.mediaCursor > event.sourceOffsetMs + elapsed + 100) {
        throw new Error(`切场景后素材位置不一致：${event.assetName}，目标 ${event.sourceOffsetMs} ms，OBS 实际 ${status.mediaCursor ?? '未知'} ms`);
      }
    }
    if (event.phase === 'start') this.active.add(event.sourceName); else this.active.delete(event.sourceName);
  }

  async switchScene(sceneName: string): Promise<void> {
    const requests = this.muteOtherSources(sceneName);
    if (!requests.length) { await this.request(this.client.call('SetCurrentProgramScene', { sceneName }), 'SetCurrentProgramScene'); return; }
    requests.unshift({ requestType: 'SetCurrentProgramScene', requestData: { sceneName } });
    await this.batch(requests);
  }

  /** Nest existing scenes; never insert overlays into or alter a user's camera scene. */
  async compose(sceneName: string, layers: string[]): Promise<void> {
    if (!sceneName.startsWith('团播联动台·叠加·') || layers.includes(sceneName)) throw new Error('叠加输出必须使用独立的联动台场景');
    if (new Set(layers).size !== layers.length) throw new Error('同一素材或场景不能在同一时刻重复叠加，请使用独立素材');
    const signature = JSON.stringify(layers);
    if (this.compositions.get(sceneName) !== signature) {
      const inventory = await this.request(this.client.call('GetSceneList'), '读取叠加场景');
      if (layers.some(name => !inventory.scenes.some(scene => scene.sceneName === name))) throw new Error('叠加的机位或素材场景不存在，请重新同步素材');
      if (!inventory.scenes.some(scene => scene.sceneName === sceneName)) await this.request(this.client.call('CreateScene', { sceneName }), '创建叠加输出');
      const items = await this.request(this.client.call('GetSceneItemList', { sceneName }), '读取叠加图层');
      const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
      for (const item of items.sceneItems) {
        if (typeof item.sceneItemId === 'number' && typeof item.sourceName === 'string' && !layers.includes(item.sourceName)) requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: false } });
      }
      // OBS index zero is the bottom; timeline index zero is the top.
      for (const [index, sourceName] of layers.entries()) {
        const existing = items.sceneItems.find(item => item.sourceName === sourceName);
        const sceneItemId = typeof existing?.sceneItemId === 'number' ? existing.sceneItemId
          : (await this.request(this.client.call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: false }), '添加叠加图层')).sceneItemId;
        requests.push(
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName, sceneItemId, sceneItemEnabled: true } },
          { requestType: 'SetSceneItemIndex', requestData: { sceneName, sceneItemId, sceneItemIndex: layers.length - index - 1 } }
        );
      }
      await this.batch(requests);
      this.compositions.set(sceneName, signature);
    }
    const visible = new Set(layers);
    const output: Parameters<OBSWebSocket['callBatch']>[0] = [...this.active].flatMap(inputName => {
      const source = this.prepared.get(inputName);
      return source && source.kind !== 'image' && !visible.has(source.sceneName)
        ? [{ requestType: 'SetInputMute' as const, requestData: { inputName, inputMuted: true } }] : [];
    });
    output.push({ requestType: 'SetCurrentProgramScene', requestData: { sceneName } });
    await this.batch(output);
  }

  async seek(event: ManagedMediaEvent, path: string, native: (name: string, position: number) => Promise<void>): Promise<void> {
    const target = this.prepared.get(event.sourceName);
    if (event.phase !== 'start' || !target || target.path !== path || target.sceneName !== event.sceneName) throw new Error('定位素材未准备或与工程不符');
    await this.batch([
      ...(event.deferSceneSwitch ? [] : this.muteOtherSources(target.sceneName)),
      { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
      ...(event.assetKind !== 'image' ? [{ requestType: 'SetInputMute' as const, requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } }] : []),
      ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }])
    ]);
    if (event.assetKind !== 'image') {
      await this.prepareSeekDecoder(event, target.sceneItemId);
      await native(event.sourceName, Math.round(event.sourceOffsetMs));
      await this.confirmSeek(event, target.sceneItemId);
    }
    this.active.add(event.sourceName);
  }

  private async prepareSeekDecoder(event: ManagedMediaEvent, sceneItemId: number): Promise<void> {
    const status = await this.request(this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '读取定位前素材状态');
    const hasFrame = async (): Promise<boolean> => {
      if (event.assetKind === 'audio') return true;
      const frame = await this.request(this.client.call('GetSceneItemTransform', { sceneName: event.sceneName!, sceneItemId }), '检查素材解码画面');
      return Number(frame.sceneItemTransform.sourceWidth) > 0 && Number(frame.sceneItemTransform.sourceHeight) > 0;
    };
    const ended = status.mediaDuration > 0 && status.mediaCursor >= status.mediaDuration - 1;
    if (!ended && ['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_PAUSED'].includes(status.mediaState) && await hasFrame()) return;
    // An ended or frameless decoder must produce its first frame before pausing to seek.
    // Two render ticks alone do not prove that the asynchronous media decoder is ready.
    await this.request(this.client.call('TriggerMediaInputAction', {
      inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
    }), '启动素材定位解码');
    const restartedAt = performance.now(), deadline = restartedAt + 2000;
    do {
      const current = await this.request(this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '确认定位解码状态');
      if (current.mediaState === 'OBS_MEDIA_STATE_PLAYING' && typeof current.mediaCursor === 'number'
        && current.mediaCursor >= 0 && current.mediaCursor <= performance.now() - restartedAt + 100 && await hasFrame()) return;
      if (current.mediaState === 'OBS_MEDIA_STATE_ERROR') break;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`素材“${event.assetName}”未能输出画面，播放已停止`);
  }

  private async confirmSeek(event: ManagedMediaEvent, sceneItemId: number): Promise<void> {
    const deadline = performance.now() + 2000;
    do {
      const [status, frame] = await Promise.all([
        this.request(this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '确认素材定位位置'),
        this.request(this.client.call('GetSceneItemTransform', { sceneName: event.sceneName!, sceneItemId }), '确认素材定位画面')
      ]);
      if (status.mediaState === 'OBS_MEDIA_STATE_PAUSED' && typeof status.mediaCursor === 'number'
        && Math.abs(status.mediaCursor - event.sourceOffsetMs) <= 100
        && (event.assetKind === 'audio' || Number(frame.sceneItemTransform.sourceWidth) > 0 && Number(frame.sceneItemTransform.sourceHeight) > 0)) return;
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') break;
      // The native response acknowledges a command, not the decoded frame. Only poll; never resend.
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`素材“${event.assetName}”未完成画面定位，播放已停止，请重新定位后播放`);
  }

  private muteOtherSources(sceneName: string): Parameters<OBSWebSocket['callBatch']>[0] {
    const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
    for (const inputName of this.active) {
      const source = this.prepared.get(inputName);
      if (!source || source.sceneName === sceneName || source.kind === 'image') continue;
      requests.push(
        { requestType: 'SetInputMute', requestData: { inputName, inputMuted: true } }
      );
    }
    return requests;
  }

  private async batch(requests: Parameters<OBSWebSocket['callBatch']>[0]): Promise<void> {
    const results = await this.request(this.client.callBatch(requests, { executionType: 0, haltOnFailure: true }), '素材场景批量控制');
    const failure = results.find((result) => !result.requestStatus.result);
    if (failure && !failure.requestStatus.result) throw new Error(`${failure.requestType}：${failure.requestStatus.comment}`);
    if (results.length !== requests.length) throw new Error('OBS 素材控制响应不完整');
  }

  private async waitForState(inputName: string, expected: string): Promise<void> {
    const deadline = performance.now() + 2000;
    do {
      const status = await this.request(this.client.call('GetMediaInputStatus', { inputName }), '确认素材实际状态');
      if (status.mediaState === expected) return;
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR' || performance.now() >= deadline) throw new Error(`素材“${inputName}”未进入 ${expected}：OBS 状态 ${status.mediaState}，位置 ${status.mediaCursor} ms`);
      // Poll acknowledgement only: never resend a failed playback action.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`等待素材状态超时：${inputName}`);
  }

  private async positionMedia(inputName: string, positionMs: number): Promise<void> {
    const status = await this.request(this.client.call('GetMediaInputStatus', { inputName }), '读取素材实际位置');
    // A camera cut only masks this source. Keep its decoder clock running so returning never restarts it.
    if (typeof status.mediaCursor === 'number' && Math.abs(status.mediaCursor - positionMs) <= 100) return;
    await this.request(this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }), '定位前暂停素材');
    await this.waitForState(inputName, 'OBS_MEDIA_STATE_PAUSED');
    await this.request(this.client.call('SetMediaInputCursor', { inputName, mediaCursor: positionMs }), '定位素材');
    // OBS advances its reported media clock only after playback resumes.
    // Waiting for the paused clock to acknowledge a seek can deadlock playback.
    await this.request(this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }), '定位后继续素材');
    const resumedAt = performance.now();
    const deadline = performance.now() + 2000;
    let actual: number | null = null;
    do {
      const result = await this.request(this.client.call('GetMediaInputStatus', { inputName }), '确认素材定位');
      actual = result.mediaCursor;
      if (result.mediaState === 'OBS_MEDIA_STATE_PLAYING' && typeof actual === 'number'
        && actual >= positionMs - 100 && actual <= positionMs + (performance.now() - resumedAt) + 100) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`素材定位未完成：${inputName}，目标 ${positionMs} ms，OBS 实际 ${actual ?? '未知'} ms`);
  }
}
