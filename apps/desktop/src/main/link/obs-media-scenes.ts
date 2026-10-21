import type { ObsOperationRunner } from './obs-request-scheduler';
import type { OBSWebSocket } from 'obs-websocket-js';
import type { LinkMediaAsset } from '@tb/schema';
import { materialSceneNames, type ManagedMediaEvent } from '@tb/core/link';
import { z } from 'zod';
import { includesObsMediaPath, sameObsMediaPath, verifyRelocatedObsMediaPath } from './obs-media-paths';

type Request = <T>(operation: () => Promise<T>, label: string) => Promise<T>;
type MediaState = { mediaState: string; mediaDuration: number; mediaCursor: number };
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]));
const filtersSchema = z.array(z.object({ filterName: z.string().min(1), filterKind: z.string().min(1),
  filterIndex: z.number().int().nonnegative(), filterEnabled: z.boolean(), filterSettings: z.record(z.string(), jsonValue) }));
const compositionItemsSchema = z.array(z.object({ sourceName: z.string().min(1), sceneItemId: z.number().int(),
  sceneItemIndex: z.number().int().nonnegative(), sceneItemEnabled: z.boolean() }));
type CompositionItem = { id: number; enabled: boolean; index: number };

/** Invisible items have no compositing order requirement. Keep them in place
 * when the visible subset already has the requested relative order. */
function compositionOrderRequests(sceneName: string, layers: string[], items: Map<string, CompositionItem>): Parameters<OBSWebSocket['callBatch']>[0] {
  const order = [...items].sort((a, b) => a[1].index - b[1].index).map(([name]) => name);
  const bottomFirst = [...layers].reverse();
  const visible = new Set(layers);
  if (order.filter(name => visible.has(name)).every((name, index) => name === bottomFirst[index])) return [];
  const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
  for (const [index, name] of bottomFirst.entries()) {
    const previous = order.indexOf(name);
    if (previous === index) continue;
    order.splice(previous, 1); order.splice(index, 0, name);
    requests.push({ requestType: 'SetSceneItemIndex', requestData: { sceneName, sceneItemId: items.get(name)!.id, sceneItemIndex: index } });
  }
  order.forEach((name, index) => { items.get(name)!.index = index; });
  return requests;
}

/** Only the dedicated input in an application-owned material scene is controlled. */
/** A paused seek lands this far ahead of the music, covering seek and decode time. */
const MEDIA_START_LEAD_MS = 200;

export class ObsMediaScenes {
  private readonly prepared = new Map<string, { path: string; sha256: string; playbackPaths: readonly string[]; sceneName: string; sceneItemId: number; kind: LinkMediaAsset['kind'] }>();
  private readonly active = new Set<string>();
  private readonly compositions = new Map<string, string>();
  private readonly compositionItems = new Map<string, Map<string, CompositionItem>>();
  private readonly primed = new Map<string, 'preparing' | 'ready'>();
  constructor(private readonly client: OBSWebSocket, private readonly request: Request, private readonly run: ObsOperationRunner) {}
  clear(): void { this.prepared.clear(); this.active.clear(); this.compositions.clear(); this.compositionItems.clear(); this.primed.clear(); }

  /** A second decoder inside the same owned scene. The logical scene remains
   * stable for composition, while only the visible input changes at a boundary. */
  async prepareStandby(primaryName: string): Promise<string> {
    return this.run(async () => {
      const primary = this.prepared.get(primaryName);
      if (!primary || primary.kind === 'image') throw new Error('预备解码目标不是已准备的音视频');
      const sourceName = `${primaryName}·预备`;
      if (this.active.has(sourceName)) throw new Error('正在播放的解码器不能重新预备');
      const settings = await this.request(() => this.client.call('GetInputSettings', { inputName: primaryName }), '读取预备素材配置');
      if (settings.inputKind !== 'ffmpeg_source' || typeof settings.inputSettings.local_file !== 'string'
        || !includesObsMediaPath(primary.playbackPaths, settings.inputSettings.local_file)) throw new Error('预备素材配置与原来源不符');
      const playbackPath = settings.inputSettings.local_file, hardwareDecode = settings.inputSettings.hw_decode;
      if (typeof hardwareDecode !== 'boolean') throw new Error('预备素材解码配置无效');
      const items = await this.request(() => this.client.call('GetSceneItemList', { sceneName: primary.sceneName }), '读取预备素材场景');
      const found = items.sceneItems.find(item => item.sourceName === sourceName);
      let sceneItemId: number;
      if (found) {
        if (typeof found.sceneItemId !== 'number') throw new Error('预备素材场景项身份无效');
        const existing = await this.request(() => this.client.call('GetInputSettings', { inputName: sourceName }), '核对预备素材配置');
        const existingPath = existing.inputSettings.local_file;
        if (existing.inputKind !== settings.inputKind || typeof existingPath !== 'string'
          || !includesObsMediaPath(primary.playbackPaths, existingPath) && !await verifyRelocatedObsMediaPath(existingPath, primary.path, primary.sha256, primary.playbackPaths)) throw new Error('预备素材名称已被其他来源占用');
        if (!sameObsMediaPath(existingPath, playbackPath) || existing.inputSettings.hw_decode !== hardwareDecode) {
          await this.request(() => this.client.call('SetInputSettings', { inputName: sourceName,
            inputSettings: { local_file: playbackPath, hw_decode: hardwareDecode,
              restart_on_activate: false, close_when_inactive: false, looping: false }, overlay: true }), '更新自有预备素材缓存');
        }
        sceneItemId = found.sceneItemId;
      } else {
        const created = await this.request(() => this.client.call('CreateInput', {
          sceneName: primary.sceneName, inputName: sourceName, inputKind: 'ffmpeg_source', sceneItemEnabled: false,
          inputSettings: { ...settings.inputSettings, restart_on_activate: false, close_when_inactive: false, looping: false }
        }), '创建隐藏预备解码器');
        sceneItemId = created.sceneItemId;
      }
      this.prepared.set(sourceName, { ...primary, sceneItemId });
      await this.batch([
        { requestType: 'SetInputMute', requestData: { inputName: sourceName, inputMuted: true } },
        { requestType: 'SetSceneItemEnabled', requestData: { sceneName: primary.sceneName, sceneItemId, sceneItemEnabled: false } }
      ]);
      await this.copyPresentation(primaryName, sourceName);
      return sourceName;
    });
  }

  async copyPresentation(from: string, to: string): Promise<void> {
    return this.run(async () => {
      const source = this.prepared.get(from), target = this.prepared.get(to);
      if (!source || !target || source.path !== target.path || this.active.has(to)) throw new Error('预备画面必须来自同一素材的非活动解码器');
      const transform = await this.request(() => this.client.call('GetSceneItemTransform', { sceneName: source.sceneName, sceneItemId: source.sceneItemId }), '读取预备画面变换');
      await this.request(() => this.client.call('SetSceneItemTransform', { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemTransform: transform.sceneItemTransform }), '复制预备画面变换');
      const filters = filtersSchema.parse((await this.request(() => this.client.call('GetSourceFilterList', { sourceName: from }), '读取预备画面滤镜')).filters);
      const previous = filtersSchema.parse((await this.request(() => this.client.call('GetSourceFilterList', { sourceName: to }), '核对预备画面滤镜')).filters);
      for (const filter of previous) if (!filters.some(item => item.filterName === filter.filterName && item.filterKind === filter.filterKind)) {
        await this.request(() => this.client.call('RemoveSourceFilter', { sourceName: to, filterName: filter.filterName }), '移除过期预备滤镜');
      }
      for (const filter of filters) {
        const filterName = filter.filterName;
        const existing = previous.some(item => item.filterName === filter.filterName && item.filterKind === filter.filterKind);
        if (!existing) await this.request(() => this.client.call('CreateSourceFilter', { sourceName: to, filterName,
          filterKind: String(filter.filterKind), filterSettings: filter.filterSettings }), '创建预备滤镜');
        else await this.request(() => this.client.call('SetSourceFilterSettings', { sourceName: to, filterName,
          filterSettings: filter.filterSettings, overlay: false }), '更新预备滤镜');
        await this.request(() => this.client.call('SetSourceFilterEnabled', { sourceName: to, filterName, filterEnabled: filter.filterEnabled === true }), '准备滤镜状态');
        await this.request(() => this.client.call('SetSourceFilterIndex', { sourceName: to, filterName, filterIndex: Number(filter.filterIndex) }), '准备滤镜顺序');
      }
    });
  }

  async prepare(projectId: string, asset: LinkMediaAsset, path: string, playbackPath = path, cachePaths: readonly string[] = [], names = materialSceneNames(projectId, asset), hardwareDecode = asset.kind === 'video'): Promise<void> {
    const baseNames = materialSceneNames(projectId, asset);
    if (names.sourceName !== baseNames.sourceName && !this.prepared.has(baseNames.sourceName)) await this.prepare(projectId, asset, path, playbackPath, cachePaths, baseNames, hardwareDecode);
    return this.run(async () => {
      const { sceneName, sourceName } = names;
      const playbackPaths = [path, playbackPath, ...cachePaths];
      const base = materialSceneNames(projectId, asset);
      if (sceneName !== base.sceneName && !sceneName.startsWith(`${base.sceneName}·轨道·`) || sourceName !== `${sceneName}·来源`) throw new Error('素材场景身份无效');
      const kind = asset.kind === 'image' ? 'image_source' : 'ffmpeg_source';
      const scenes = await this.request(() => this.client.call('GetSceneList'), 'GetSceneList');
      const exists = scenes.scenes.some((scene) => scene.sceneName === sceneName);
      let sceneItemId: number;
      if (exists) {
        const items = await this.request(() => this.client.call('GetSceneItemList', { sceneName }), 'GetSceneItemList');
        const item = items.sceneItems.find((entry) => entry.sourceName === sourceName);
        if (!item || typeof item.sceneItemId !== 'number') throw new Error(`素材场景名称被占用或来源已移除：${sceneName}`);
        const settings = await this.request(() => this.client.call('GetInputSettings', { inputName: sourceName }), 'GetInputSettings');
        const existingPath = settings.inputSettings[asset.kind === 'image' ? 'file' : 'local_file'];
        if (settings.inputKind !== kind || typeof existingPath !== 'string'
          || !includesObsMediaPath(playbackPaths, existingPath) && !await verifyRelocatedObsMediaPath(existingPath, path, asset.sha256, cachePaths)) {
          throw new Error(`素材来源与工程文件不一致，拒绝覆盖：${sourceName}。OBS 文件：${typeof existingPath === 'string' ? existingPath : '未配置有效文件'}；工程文件：${path}`);
        }
        this.prepared.set(sourceName, { path, sha256: asset.sha256, playbackPaths, sceneName, sceneItemId: item.sceneItemId, kind: asset.kind });
        if (!sameObsMediaPath(existingPath, playbackPath)) await this.request(() => this.client.call('SetInputSettings', {
          inputName: sourceName, inputSettings: { [asset.kind === 'image' ? 'file' : 'local_file']: playbackPath }, overlay: true
        }), '切换素材定位文件');
        if (asset.kind === 'image' && settings.inputSettings.unload !== false) await this.request(() => this.client.call('SetInputSettings', {
          inputName: sourceName, inputSettings: { unload: false }, overlay: true
        }), '准备图片解码');
        if (asset.kind !== 'image' && (settings.inputSettings.restart_on_activate !== false || settings.inputSettings.close_when_inactive !== false
          || settings.inputSettings.looping !== false || settings.inputSettings.hw_decode !== hardwareDecode)) {
          await this.request(() => this.client.call('SetInputSettings', {
            inputName: sourceName,
            inputSettings: { restart_on_activate: false, close_when_inactive: false, looping: false, hw_decode: hardwareDecode },
            overlay: true
          }), '关闭受管素材切场景时重播');
        }
        sceneItemId = item.sceneItemId;
      } else {
        await this.request(() => this.client.call('CreateScene', { sceneName }), 'CreateScene');
        const created = await this.request(() => this.client.call('CreateInput', {
          sceneName, inputName: sourceName, inputKind: kind, sceneItemEnabled: true,
          inputSettings: asset.kind === 'image' ? { file: playbackPath, unload: false }
            : { is_local_file: true, local_file: playbackPath, looping: false, restart_on_activate: false, close_when_inactive: false, hw_decode: hardwareDecode }
        }), 'CreateInput');
        sceneItemId = created.sceneItemId;
        this.prepared.set(sourceName, { path, sha256: asset.sha256, playbackPaths, sceneName, sceneItemId, kind: asset.kind });
        if (asset.kind !== 'audio') {
          const canvas = await this.request(() => this.client.call('GetVideoSettings'), 'GetVideoSettings');
          await this.request(() => this.client.call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: {
            positionX: canvas.baseWidth / 2, positionY: canvas.baseHeight / 2, alignment: 0,
            boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: canvas.baseWidth, boundsHeight: canvas.baseHeight
          } }), 'SetSceneItemTransform');
        }
      }
      if (asset.kind !== 'image') {
        await this.request(() => this.client.call('SetInputMute', { inputName: sourceName, inputMuted: true }), '准备素材静音');
        const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: sourceName }), '准备素材状态');
        if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
          await this.request(() => this.client.call('TriggerMediaInputAction', { inputName: sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }), '准备素材暂停');
          await this.waitForState(sourceName, 'OBS_MEDIA_STATE_PAUSED');
        }
      }
      this.prepared.set(sourceName, { path, sha256: asset.sha256, playbackPaths, sceneName, sceneItemId, kind: asset.kind });
      this.active.delete(sourceName);
      this.primed.delete(sourceName);
      if (!exists && sourceName !== baseNames.sourceName && asset.kind !== 'audio') await this.copyPresentation(baseNames.sourceName, sourceName);
    });
  }

  /** Decode the opening frame while muted and off-air. A primed input is still
   * checked on entry; neither a sent restart nor an old texture means ready. */
  async prime(event: ManagedMediaEvent, path: string, restart: () => Promise<void>): Promise<void> {
    return this.run(async () => {
      const target = this.prepared.get(event.sourceName);
      if (!target || target.path !== path || target.sceneName !== event.sceneName || event.phase !== 'start'
        || event.assetKind === 'image') throw new Error('仅可预热已准备的音视频素材');
      this.primed.set(event.sourceName, 'preparing');
      await this.request(() => this.client.call('SetInputMute', { inputName: event.sourceName, inputMuted: true }), '预热素材静音');
      await restart();
      await this.confirmSeek(event, target.sceneItemId);
      // A decoded CPU frame is not a prepared GPU texture. Render the paused
      // owned source once off-air so first activation does not upload four
      // full-size video textures on the playback boundary. This does not select
      // a program scene or remove the normal preview.
      if (event.assetKind === 'video') {
        const frame = await this.request(() => this.client.call('GetSourceScreenshot', {
          sourceName: event.sourceName, imageFormat: 'png', imageWidth: 32, imageHeight: 32
        }), '预备素材画面纹理');
        if (typeof frame.imageData !== 'string' || !frame.imageData.startsWith('data:image/png;base64,')) throw new Error('预备素材没有返回可用画面');
      }
      this.primed.set(event.sourceName, 'ready');
    });
  }

  async releasePrimed(inputNames: readonly string[]): Promise<void> {
    return this.run(async () => {
      for (const inputName of new Set(inputNames)) {
        if (!this.primed.has(inputName)) continue;
        await this.batch([
          { requestType: 'TriggerMediaInputAction', requestData: { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } },
          { requestType: 'SetInputMute', requestData: { inputName, inputMuted: true } }
        ]);
        this.primed.delete(inputName);
      }
    });
  }

  async releaseImages(inputNames: readonly string[]): Promise<void> {
    return this.run(async () => {
      const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
      for (const inputName of inputNames) {
        const target = this.prepared.get(inputName);
        if (!target) continue;
        if (target.kind !== 'image') throw new Error(`释放目标不是已准备的自有图片：${inputName}`);
        requests.push(
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: false } },
          { requestType: 'SetInputSettings', requestData: { inputName, inputSettings: { unload: true }, overlay: true } }
        );
      }
      if (requests.length) await this.batch(requests);
      for (const inputName of inputNames) this.active.delete(inputName);
    });
  }

  async execute(event: ManagedMediaEvent, path: string, previousSource?: string, retirement: 'stop' | 'pause' = 'stop'): Promise<void> {
    return this.run(async () => {
      const startedAt = performance.now();
      const target = this.prepared.get(event.sourceName);
      if (!target || target.path !== path || target.sceneName !== event.sceneName) throw new Error(`素材场景尚未准备，请重新预检：${event.assetName}`);
      const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
      if (previousSource && previousSource !== event.sourceName) {
        const previous = this.prepared.get(previousSource);
        if (event.phase !== 'start' || !previous || previous.sceneName !== target.sceneName || previous.path !== path) throw new Error('接续只能替换同一素材的受管解码器');
        requests.push(
          { requestType: 'SetInputMute', requestData: { inputName: previousSource, inputMuted: true } },
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName: previous.sceneName, sceneItemId: previous.sceneItemId, sceneItemEnabled: false } },
          { requestType: 'TriggerMediaInputAction', requestData: { inputName: previousSource, mediaAction: retirement === 'pause' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } }
        );
      }
      if (event.phase === 'start') {
        const wasActive = this.active.has(event.sourceName);
        this.active.add(event.sourceName);
        const primed = this.primed.get(event.sourceName) === 'ready';
        if (this.primed.has(event.sourceName) && !primed) throw new Error(`素材预热尚未完成：${event.assetName}`);
        this.primed.delete(event.sourceName);
        if (primed) {
          const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '检查预热素材');
          if (status.mediaState !== 'OBS_MEDIA_STATE_PAUSED' || Math.abs(status.mediaCursor - event.sourceOffsetMs) > 100) throw new Error(`预热素材状态已变化：${event.assetName}`);
        }
        if (event.assetKind !== 'image' && !primed && !wasActive) {
          await this.batch([
            ...(event.deferSceneSwitch ? [] : this.muteOtherSources(target.sceneName)),
            { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } },
            { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
            ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }]),
            { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' } }
          ]);
          await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
        }
        if (event.assetKind !== 'image' && !primed) {
          let state = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), 'GetMediaInputStatus');
          if (wasActive && this.isEndTransition(state)) {
            // At EOF ffmpeg resets its cursor before publishing ENDED. A Seek
            // sent in this interval is accepted by OBS but ignored by the
            // inactive decoder. Wait for this transition; do not resend Seek.
            state = await this.settleEndTransition(event.sourceName, state);
          }
          if (state.mediaState !== 'OBS_MEDIA_STATE_PAUSED' && state.mediaState !== 'OBS_MEDIA_STATE_PLAYING') {
            await this.request(() => this.client.call('TriggerMediaInputAction', { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }), '重启已结束素材');
            await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
          }
        }
        if (!event.deferSceneSwitch) requests.push(...this.muteOtherSources(target.sceneName));
        if (event.assetKind !== 'image') {
          if (!primed) await this.positionMedia(event.sourceName, () => event.sourceOffsetMs + performance.now() - startedAt);
          requests.push(
          { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } }
          );
        }
        requests.push(
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
          ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }])
        );
        if (event.assetKind !== 'image' && primed) requests.push({ requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' } });
      } else {
        this.primed.delete(event.sourceName);
        if (event.assetKind !== 'image') requests.push(
          { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: retirement === 'pause' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } },
          { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } }
        );
        requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: false } });
      }
      await this.batch(requests);
      if (previousSource) this.active.delete(previousSource);
      if (event.phase === 'start' && event.assetKind !== 'image') {
        // The state acknowledgement already contains the actual decoded cursor.
        // Validate that same observation instead of adding a second RPC after
        // every layer start, which needlessly spends the output deadline.
        const status = await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
        const expected = Math.round(event.sourceOffsetMs + performance.now() - startedAt);
        if (typeof status.mediaCursor !== 'number' || Math.abs(status.mediaCursor - expected) > 100) {
          throw new Error(`切场景后素材位置不一致：${event.assetName}，按音乐应在 ${expected} ms，OBS 实际 ${status.mediaCursor ?? '未知'} ms`);
        }
      }
      if (event.phase === 'start') this.active.add(event.sourceName); else this.active.delete(event.sourceName);
    });
  }

  async switchScene(sceneName: string): Promise<void> {
    return this.run(async () => {
      const requests = this.muteOtherSources(sceneName);
      if (!requests.length) {
        await this.request(() => this.client.call('SetCurrentProgramScene', { sceneName }), 'SetCurrentProgramScene');
        return;
      }
      requests.unshift({ requestType: 'SetCurrentProgramScene', requestData: { sceneName } });
      if (requests.length) await this.batch(requests);
    });
  }

  /** Nest existing scenes; never insert overlays into or alter a user's camera scene. */
  async prepareComposition(sceneName: string, layers: string[], upcoming: readonly string[] = []): Promise<void> {
    return this.run(async () => {
      this.compositions.delete(sceneName); this.compositionItems.delete(sceneName);
      await this.updateComposition(sceneName, layers, upcoming);
    });
  }

  private async updateComposition(sceneName: string, layers: string[], upcoming: readonly string[] = [], output: Parameters<OBSWebSocket['callBatch']>[0] = []): Promise<void> {
      if (!sceneName.startsWith('团播联动台·叠加·') || layers.includes(sceneName)) throw new Error('叠加输出必须使用独立的联动台场景');
      if (new Set(layers).size !== layers.length) throw new Error('同一素材或场景不能在同一时刻重复叠加，请使用独立素材');
      const signature = JSON.stringify(layers);
      if (this.compositions.get(sceneName) !== signature) {
        let items = this.compositionItems.get(sceneName);
        const needed = [...new Set([...layers, ...upcoming])];
        if (!items || needed.some(name => !items!.has(name))) {
          const inventory = await this.request(() => this.client.call('GetSceneList'), '读取叠加场景');
          if (needed.some(name => name === sceneName || !inventory.scenes.some(scene => scene.sceneName === name))) throw new Error('叠加的机位或素材场景不存在，请重新同步素材');
          if (!inventory.scenes.some(scene => scene.sceneName === sceneName)) await this.request(() => this.client.call('CreateScene', { sceneName }), '创建叠加输出');
          const actual = await this.request(() => this.client.call('GetSceneItemList', { sceneName }), '读取叠加图层');
          const parsed = compositionItemsSchema.parse(actual.sceneItems);
          if (new Set(parsed.map(item => item.sourceName)).size !== parsed.length) throw new Error('叠加场景包含重复来源，请重新同步素材');
          items = new Map(parsed.map(item => [item.sourceName, { id: item.sceneItemId, enabled: item.sceneItemEnabled, index: item.sceneItemIndex }]));
          for (const sourceName of needed) if (!items.has(sourceName)) {
            const created = await this.request(() => this.client.call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: false }), '添加叠加图层');
            items.set(sourceName, { id: created.sceneItemId, enabled: false, index: items.size });
          }
        }
        const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
        for (const [sourceName, item] of items) {
          if (item.enabled && !layers.includes(sourceName)) requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName, sceneItemId: item.id, sceneItemEnabled: false } });
        }
        for (const sourceName of layers) {
          const existing = items.get(sourceName)!;
          const sceneItemId = existing.id;
          if (!existing.enabled) requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName, sceneItemId, sceneItemEnabled: true } });
        }
        requests.push(...compositionOrderRequests(sceneName, layers, items));
        // Invalidate before writes: a partial response must force a fresh read.
        this.compositionItems.delete(sceneName); this.compositions.delete(sceneName);
        // Order layers, mute covered media and switch the output in one batch.
        // A separate switch round trip spends another render boundary.
        await this.batch([...requests, ...output]);
        for (const [sourceName, item] of items) item.enabled = layers.includes(sourceName);
        this.compositionItems.set(sceneName, items);
        this.compositions.set(sceneName, signature);
      } else if (output.length) await this.batch(output);
  }

  async compose(sceneName: string, layers: string[]): Promise<void> {
    return this.run(async () => {
      const visible = new Set(layers);
      const output: Parameters<OBSWebSocket['callBatch']>[0] = [...this.active].flatMap(inputName => {
        const source = this.prepared.get(inputName);
        return source && source.kind !== 'image' && !visible.has(source.sceneName)
          ? [{ requestType: 'SetInputMute' as const, requestData: { inputName, inputMuted: true } }] : [];
      });
      // Events can arrive after a later external scene change. An old observed
      // scene cannot suppress this explicit timeline action (including t=0).
      output.push({ requestType: 'SetCurrentProgramScene', requestData: { sceneName } });
      await this.updateComposition(sceneName, layers, [], output);
    });
  }

  async seek(event: ManagedMediaEvent, path: string, native: (name: string, position: number) => Promise<void>): Promise<void> {
    return this.run(async () => {
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
    });
  }

  private async prepareSeekDecoder(event: ManagedMediaEvent, sceneItemId: number): Promise<void> {
    const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '读取定位前素材状态');
    const hasFrame = async (): Promise<boolean> => {
      if (event.assetKind === 'audio') return true;
      const frame = await this.request(() => this.client.call('GetSceneItemTransform', { sceneName: event.sceneName!, sceneItemId }), '检查素材解码画面');
      return Number(frame.sceneItemTransform.sourceWidth) > 0 && Number(frame.sceneItemTransform.sourceHeight) > 0;
    };
    const ended = status.mediaDuration > 0 && status.mediaCursor >= status.mediaDuration - 1;
    if (!ended && ['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_PAUSED'].includes(status.mediaState) && await hasFrame()) return;
    // An ended or frameless decoder must produce its first frame before pausing to seek.
    // Two render ticks alone do not prove that the asynchronous media decoder is ready.
    await this.request(() => this.client.call('TriggerMediaInputAction', {
      inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
    }), '启动素材定位解码');
    const restartedAt = performance.now(), deadline = restartedAt + 2000;
    do {
      const current = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '确认定位解码状态');
      if (current.mediaState === 'OBS_MEDIA_STATE_PLAYING' && typeof current.mediaCursor === 'number'
        && current.mediaCursor >= 0 && current.mediaCursor <= performance.now() - restartedAt + 100 && await hasFrame()) return;
      if (current.mediaState === 'OBS_MEDIA_STATE_ERROR') break;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`素材“${event.assetName}”未能输出画面，播放已停止`);
  }

  private async confirmSeek(event: ManagedMediaEvent, sceneItemId: number): Promise<void> {
    const deadline = performance.now() + 2000;
    let observed = '尚无回读';
    do {
      const [status, frame] = await Promise.all([
        this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '确认素材定位位置'),
        this.request(() => this.client.call('GetSceneItemTransform', { sceneName: event.sceneName!, sceneItemId }), '确认素材定位画面')
      ]);
      const width = frame.sceneItemTransform.sourceWidth, height = frame.sceneItemTransform.sourceHeight;
      observed = `${status.mediaState}，位置 ${status.mediaCursor}ms / ${status.mediaDuration}ms，画面 ${typeof width === 'number' ? width : '未知'}×${typeof height === 'number' ? height : '未知'}`;
      if (status.mediaState === 'OBS_MEDIA_STATE_PAUSED' && typeof status.mediaCursor === 'number'
        && Math.abs(status.mediaCursor - event.sourceOffsetMs) <= 100
        && (event.assetKind === 'audio' || typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0)) return;
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') break;
      // The native response acknowledges a command, not the decoded frame. Only poll; never resend.
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`素材“${event.assetName}”未完成画面定位，目标 ${event.sourceOffsetMs}ms，最后回读：${observed}；播放已停止`);
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
    const results = await this.request(() => this.client.callBatch(requests, { executionType: 0, haltOnFailure: true }), '素材场景批量控制');
    const failure = results.find((result) => !result.requestStatus.result);
    if (failure && !failure.requestStatus.result) throw new Error(`${failure.requestType}：${failure.requestStatus.comment}`);
    if (results.length !== requests.length) throw new Error('OBS 素材控制响应不完整');
  }

  private async waitForState(inputName: string, expected: string): Promise<MediaState> {
    const deadline = performance.now() + 2000;
    do {
      const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName }), '确认素材实际状态');
      if (status.mediaState === expected) return status;
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR' || performance.now() >= deadline) throw new Error(`素材“${inputName}”未进入 ${expected}：OBS 状态 ${status.mediaState}，位置 ${status.mediaCursor} ms`);
      // Poll acknowledgement only: never resend a failed playback action.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`等待素材状态超时：${inputName}`);
  }

  private isEndTransition(state: MediaState): boolean {
    return state.mediaState === 'OBS_MEDIA_STATE_PLAYING' && (state.mediaCursor === 0
      || state.mediaDuration > 0 && state.mediaCursor >= state.mediaDuration - 1);
  }

  private async settleEndTransition(inputName: string, initial: MediaState): Promise<MediaState> {
    let state = initial;
    const deadline = performance.now() + 2000;
    while (this.isEndTransition(state)) {
      await new Promise<void>(resolve => setTimeout(resolve, 4));
      state = await this.request(() => this.client.call('GetMediaInputStatus', { inputName }), '等待素材片尾解码状态确认');
      if (performance.now() >= deadline) throw new Error(`素材解码状态未确认：${inputName}`);
    }
    return state;
  }

  /** Starts the decoder in step with the music. `aligned` is the source position
   * the music is at now. The decoder is held paused on a frame slightly ahead
   * and started when the music reaches it, so seek and decode time do not leave
   * the picture behind. A seek that settles too late is reported by the caller. */
  private async positionMedia(inputName: string, aligned: () => number): Promise<void> {
    const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName }), '读取素材实际位置');
    // The output error budget is not a seek tolerance: a new clip at 100ms
    // must not reuse a stale zero cursor. A continuing clip is handled by the
    // session's active-clip check before reaching this method.
    // A decoder already running in step (a fresh restart from zero, a clip
    // returning from under a camera) is left alone; pausing it would stutter.
    if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' && typeof status.mediaCursor === 'number' && Math.abs(status.mediaCursor - aligned()) < 30) return;
    let cursor = status.mediaState === 'OBS_MEDIA_STATE_PAUSED' && typeof status.mediaCursor === 'number'
      && status.mediaCursor >= aligned() - 1 && status.mediaCursor <= aligned() + MEDIA_START_LEAD_MS ? status.mediaCursor : null;
    if (cursor === null) {
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
        await this.request(() => this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }), '暂停解码后精确定位');
        // OBS dispatches media controls on its task queue. The RPC reply does
        // not acknowledge the decoder pause, which must precede a paused seek.
        await this.waitForState(inputName, 'OBS_MEDIA_STATE_PAUSED');
      }
      const target = Math.round(aligned() + MEDIA_START_LEAD_MS);
      await this.request(() => this.client.call('SetMediaInputCursor', { inputName, mediaCursor: target }), '定位素材');
      // OBS seeks to a preceding keyframe even while paused. Precise playback
      // must prepare an intra-frame cache; pausing alone cannot make a GOP source
      // frame accurate. Require the decoded cursor before resuming, never resend.
      const deadline = performance.now() + 2000;
      let actual: number | null = null;
      do {
        const result = await this.request(() => this.client.call('GetMediaInputStatus', { inputName }), '确认素材定位');
        actual = result.mediaCursor;
        if (result.mediaState === 'OBS_MEDIA_STATE_PAUSED' && typeof actual === 'number' && actual >= target && actual <= target + 100) { cursor = actual; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      } while (performance.now() < deadline);
      if (cursor === null) throw new Error(`素材定位未完成：${inputName}，目标 ${target} ms，OBS 实际 ${actual ?? '未知'} ms`);
    }
    const hold = cursor - aligned();
    if (hold > 0) await new Promise<void>((resolve) => setTimeout(resolve, hold));
    await this.request(() => this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }), '定位确认后继续素材');
  }
}
