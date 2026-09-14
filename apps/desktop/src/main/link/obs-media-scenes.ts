import type { OBSWebSocket } from 'obs-websocket-js';
import type { LinkMediaAsset } from '@tb/schema';
import { materialSceneNames, type ManagedMediaEvent } from '@tb/core/link';

type Request = <T>(promise: Promise<T>, label: string) => Promise<T>;

/** Only the dedicated input in an application-owned material scene is controlled. */
export class ObsMediaScenes {
  private readonly prepared = new Map<string, { path: string; sceneName: string; sceneItemId: number; kind: LinkMediaAsset['kind'] }>();
  private readonly active = new Set<string>();
  constructor(private readonly client: OBSWebSocket, private readonly request: Request) {}
  clear(): void { this.prepared.clear(); this.active.clear(); }

  async prepare(projectId: string, asset: LinkMediaAsset, path: string, playbackPath = path, cachePath?: string): Promise<void> {
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
      if (settings.inputKind !== kind || (existingPath !== path && (cachePath === undefined || existingPath !== cachePath))) throw new Error(`素材来源与工程文件不一致，拒绝覆盖：${sourceName}`);
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
          ...this.muteOtherSources(target.sceneName),
          { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } },
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
          { requestType: 'SetCurrentProgramScene', requestData: { sceneName: target.sceneName } },
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
      requests.push(...this.muteOtherSources(target.sceneName));
      if (event.assetKind !== 'image') {
        await this.positionMedia(event.sourceName, event.sourceOffsetMs);
        requests.push(
        { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } }
        );
      }
      requests.push(
        { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
        { requestType: 'SetCurrentProgramScene', requestData: { sceneName: target.sceneName } }
      );
      if (event.assetKind !== 'image') requests.push({ requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' } });
    } else {
      if (event.assetKind !== 'image') requests.push(
        { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' } },
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

  async seek(event: ManagedMediaEvent, path: string, native: (name: string, position: number) => Promise<void>): Promise<void> {
    const target = this.prepared.get(event.sourceName);
    if (event.phase !== 'start' || !target || target.path !== path || target.sceneName !== event.sceneName) throw new Error('定位素材未准备或与工程不符');
    await this.batch([
      ...this.muteOtherSources(target.sceneName),
      { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
      ...(event.assetKind !== 'image' ? [{ requestType: 'SetInputMute' as const, requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } }] : []),
      { requestType: 'SetCurrentProgramScene', requestData: { sceneName: target.sceneName } }
    ]);
    if (event.assetKind !== 'image') await native(event.sourceName, Math.round(event.sourceOffsetMs));
    this.active.add(event.sourceName);
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
