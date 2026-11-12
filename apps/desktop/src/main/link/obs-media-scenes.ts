import type { ObsOperationRunner } from './obs-request-scheduler';
import type { OBSWebSocket } from 'obs-websocket-js';
import type { LinkMediaAsset } from '@tb/schema';
import { materialSceneNames, OBS_PICTURE_FILTER_KIND, obsMaterialPresentation, PICTURE_DRIFT_TOLERANCE_MS, type ManagedMediaEvent } from '@tb/core/link';
import { z } from 'zod';
import { includesObsMediaPath, sameObsMediaPath, verifyRelocatedObsMediaPath } from './obs-media-paths';
import { MemoryMaterialOwnLooks, ownLookOf, type MaterialOwnLooks } from './obs-material-own-looks';

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

type Requests = Parameters<OBSWebSocket['callBatch']>[0];
/** The session book's word for a decoder holding the material's own look (as kept on this machine). */
const OWN_LOOK = 'own';
const STANDBY_SUFFIX = '·预备';
const MATERIAL_SCENE_PREFIX = '团播联动台·素材·';
/** The material decoder a standby copy belongs to: both show the same material, with the same own look in OBS. */
const primaryDecoder = (name: string): string => name.endsWith(STANDBY_SUFFIX) ? name.slice(0, -STANDBY_SUFFIX.length) : name;
/** What a clip asks of its decoder's look: the requests (none when it already has it), the look afterwards (OWN_LOOK
 * or the project's look as JSON), the decoder's live-edit count it was worked out at, and why it could not be worked
 * out (the clip is then shown as OBS has it, and told). */
type Look = { requests: Requests; after: string | null; edits: number; problem?: string } & FilterLook;
/** The opacity part of a look (0.5.9 E17): the requests for the decoder's picture filter, sent on their own ahead of the
 * scene item's look; what the filter is afterwards (FILTER_OFF or the opacity); whether they create it. */
type FilterLook = { filter: Requests; filterAfter: string | null; filterCreates: boolean };
const NO_FILTER: FilterLook = { filter: [], filterAfter: null, filterCreates: false };
const KEEP_LOOK: Look = { requests: [], after: null, edits: 0, ...NO_FILTER };
/** The console's one filter on a material decoder's own input, carrying the clip's opacity (0.5.9 E17). Never on a
 * material scene, never on a source of the user's; the operator's filters on the decoder are copied to its standby
 * without it. */
export const PICTURE_FILTER_NAME = '联动台·画面调节';
/** The session book's word for a decoder whose picture filter is off, or not there. */
const FILTER_OFF = 'off';
/** The crop a material's scene item has in OBS, from its kept own look: a clip with no crop of its own keeps it. */
const CROP_FIELDS = ['cropTop', 'cropRight', 'cropBottom', 'cropLeft'] as const;

/** Only the dedicated input in an application-owned material scene is controlled. */
/** A paused seek lands this far ahead of the music, covering seek and decode time. */
const MEDIA_START_LEAD_MS = 200;
/** Above the measured 66–100 ms steady cursor offset, so a clip in step is never repositioned. The read-back
 * (`picture-follow.ts`) finds a clip out of step by the same number. */
const MEDIA_DRIFT_TOLERANCE_MS = PICTURE_DRIFT_TOLERANCE_MS;

/** A batch OBS stopped part way (or never ran): `executed` requests before the
 * failure took effect, in order. */
class MediaBatchError extends Error {
  constructor(message: string, readonly executed: number) { super(message); }
}

/** A start OBS carried out whole whose check afterwards failed: the clip is on air
 * (shown, its sound, its scene) and counts as started. Thrown as before; the type only
 * tells the output layer that the clip is on the picture. */
export class MediaOnAirError extends Error {
  readonly onAir = true;
}
/** Found out of step with the music after the start: the drift check puts it back in
 * step once it is off by more than its tolerance. */
export class MediaOutOfStepError extends MediaOnAirError {}

/** Why a picture step failed, to follow "原因：" in a red text and to end before
 * the next sentence there. */
export function failureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[。.；;\s]+$/u, '');
}

/** The red text of a clip shown without the look the project gives it, because the look could not be worked out. */
export function lookFailure(event: Pick<ManagedMediaEvent, 'assetName'>, reason: string): string {
  return `素材“${event.assetName}”照常在播，但没有按工程里的位置和大小摆，用的是 OBS 里现在的样子。原因：${reason.replace(/[。.；;\s]+$/u, '')}。下一段用到这个素材时会再按工程摆；一直这样，请重新连接 OBS，或把运行日志发给我们`;
}

/** The red text of a clip shown without the opacity the project gives it, because OBS did not take it (0.5.9 E17). */
export function opacityFailure(event: Pick<ManagedMediaEvent, 'assetName'>, reason: string): string {
  return `素材“${event.assetName}”照常在播，但不透明度没有按工程设好。原因：${reason.replace(/[。.；;\s]+$/u, '')}。下一段用到这个素材时会再按工程设；一直这样，请重新连接 OBS，或把运行日志发给我们`;
}

export class ObsMediaScenes {
  private readonly prepared = new Map<string, { path: string; sha256: string; playbackPaths: readonly string[]; sceneName: string; sceneItemId: number; kind: LinkMediaAsset['kind'] }>();
  private readonly active = new Set<string>();
  /** Clip each running decoder was last started for, and whether that clip's own
   * sound plays. A start of the same clip continues it; a scene switch back to the
   * decoder's scene gives it that sound again. */
  private readonly startedClips = new Map<string, { clipId: string; audible: boolean }>();
  private readonly compositions = new Map<string, string>();
  private readonly compositionItems = new Map<string, Map<string, CompositionItem>>();
  private readonly primed = new Map<string, 'preparing' | 'ready'>();
  /** What this session knows a decoder's scene item shows (0.5.9 E16): OWN_LOOK (the material's own look, as kept on
   * this machine) or a project look as JSON. No entry: not known (never written this session, a write of ours out or
   * not confirmed, or moved on the live canvas). The material's own look itself is kept on the machine (`ownLooks`),
   * so what a clip shows never depends on what this session did before. */
  private readonly looks = new Map<string, string>();
  /** Live-canvas transform writes per decoder this session: a look worked out before one is not booked after it. */
  private readonly liveEdits = new Map<string, number>();
  /** Material scene items the live canvas wrote to: `scene\nitem id` → source name. */
  private readonly liveItems = new Map<string, string>();
  /** Materials whose kept own look this run cannot trust, with the store's reason: a record could not be dropped when
   * the scene was created anew, or could not be read for a copy. No look of ours goes to their decoders this run; each
   * start says why. Forgotten on `clear()`: the store then answers again (and fails again, the same way). */
  private readonly untrusted = new Map<string, string>();
  /** What this session knows a decoder's picture filter is (0.5.9 E17): FILTER_OFF or the opacity. No entry: not known. */
  private readonly filterStates = new Map<string, string>();
  /** Why the picture filter could not be set while the decoder was prepared off air: told by the clip's start or seek,
   * which then does not send it again. */
  private readonly filterProblems = new Map<string, string>();
  private canvas: { width: number; height: number } | null = null;
  constructor(private readonly client: OBSWebSocket, private readonly request: Request, private readonly run: ObsOperationRunner,
    private readonly ownLooks: MaterialOwnLooks = new MemoryMaterialOwnLooks()) {}
  /** OBS disconnected or reconnected: this session's book goes; the material's own looks kept on the machine stay. */
  clear(): void { this.prepared.clear(); this.active.clear(); this.startedClips.clear(); this.compositions.clear(); this.compositionItems.clear(); this.primed.clear(); this.looks.clear(); this.liveItems.clear(); this.untrusted.clear(); this.filterStates.clear(); this.filterProblems.clear(); this.canvas = null; }

  /** Before the live canvas writes a transform to a scene item (0.5.9 E16): when it is one of our material decoders, its
   * own look is kept on this machine first (if none is kept yet), and this session no longer knows what it shows. Found
   * by our material scene and source names, so a material this session never prepared counts too. Runs inside the live
   * canvas's own request turn; a failure refuses the write. */
  async beforeLiveTransform(sceneName: string, sceneItemId: number): Promise<void> {
    if (!sceneName.startsWith(MATERIAL_SCENE_PREFIX)) return;
    const key = `${sceneName}\n${sceneItemId}`;
    let sourceName = this.liveItems.get(key);
    if (sourceName === undefined) {
      const items = await this.request(() => this.client.call('GetSceneItemList', { sceneName }), '读取素材场景');
      const found = items.sceneItems.find(entry => entry.sceneItemId === sceneItemId);
      sourceName = typeof found?.sourceName === 'string' ? found.sourceName : '';
    }
    if (sourceName !== `${sceneName}·来源` && sourceName !== `${sceneName}·来源${STANDBY_SUFFIX}`) return;
    this.liveEdits.set(sourceName, (this.liveEdits.get(sourceName) ?? 0) + 1);
    this.looks.delete(sourceName);
    if (!this.liveItems.has(key) && !await this.ownLooks.read(primaryDecoder(sourceName))) {
      const own = await this.request(() => this.client.call('GetSceneItemTransform', { sceneName, sceneItemId }), '读取素材在 OBS 里原来的样子');
      await this.ownLooks.keep(primaryDecoder(sourceName), ownLookOf(own.sceneItemTransform));
    }
    this.liveItems.set(key, sourceName);
  }

  /** A second decoder inside the same owned scene. The logical scene remains
   * stable for composition, while only the visible input changes at a boundary. */
  async prepareStandby(primaryName: string): Promise<string> {
    return this.run(async () => {
      const primary = this.prepared.get(primaryName);
      if (!primary || primary.kind === 'image') throw new Error('预备解码目标不是已准备的音视频');
      const sourceName = `${primaryName}·预备`;
      if (this.active.has(sourceName)) throw new Error('正在播放的素材不能重新准备');
      const settings = await this.request(() => this.client.call('GetInputSettings', { inputName: primaryName }), '读取预备素材配置');
      if (settings.inputKind !== 'ffmpeg_source' || typeof settings.inputSettings.local_file !== 'string'
        || !includesObsMediaPath(primary.playbackPaths, settings.inputSettings.local_file)) throw new Error('准备的素材设置和原来源对不上');
      const playbackPath = settings.inputSettings.local_file, hardwareDecode = settings.inputSettings.hw_decode;
      if (typeof hardwareDecode !== 'boolean') throw new Error('预备素材解码配置无效');
      const items = await this.request(() => this.client.call('GetSceneItemList', { sceneName: primary.sceneName }), '读取预备素材场景');
      const found = items.sceneItems.find(item => item.sourceName === sourceName);
      let sceneItemId: number;
      if (found) {
        if (typeof found.sceneItemId !== 'number') throw new Error('预备素材场景项身份无效');
        const existing = await this.request(() => this.client.call('GetInputSettings', { inputName: sourceName }), '检查预备素材设置');
        const existingPath = existing.inputSettings.local_file;
        if (existing.inputKind !== settings.inputKind || typeof existingPath !== 'string'
          || !includesObsMediaPath(primary.playbackPaths, existingPath) && !await verifyRelocatedObsMediaPath(existingPath, primary.path, primary.sha256, primary.playbackPaths)) throw new Error('准备用的素材名称已被其他来源占用');
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
        // A new input has no filter of ours (E17).
        this.filterStates.delete(sourceName); this.filterProblems.delete(sourceName);
        try { await this.ownLooks.forgetFilterMade(sourceName); } catch (error) { this.distrust(primaryName, error); }
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
      // The copy gets the material's own look (E16): the one kept on this machine, or else the source decoder's
      // transform, which the console then never changed. The clip the copy is prepared for then sets its own look, if
      // it has one (`prime`).
      // A kept look that cannot be read leaves the copy as the source has it, and the material is not trusted this run.
      let own: Awaited<ReturnType<MaterialOwnLooks['read']>> = null;
      try { own = await this.ownLooks.read(primaryDecoder(from)); }
      catch (error) { this.distrust(primaryDecoder(from), error); this.distrust(primaryDecoder(to), error); }
      const transform = own ?? (await this.request(() => this.client.call('GetSceneItemTransform', { sceneName: source.sceneName, sceneItemId: source.sceneItemId }), '读取预备画面变换')).sceneItemTransform;
      this.looks.delete(to);
      await this.request(() => this.client.call('SetSceneItemTransform', { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemTransform: transform }), '复制预备画面变换');
      this.looks.set(to, OWN_LOOK);
      // The operator's filters only: the console's picture filter on either decoder is its clip's (E17), set by `prime`.
      const filters = filtersSchema.parse((await this.request(() => this.client.call('GetSourceFilterList', { sourceName: from }), '读取预备画面滤镜')).filters)
        .filter(filter => filter.filterName !== PICTURE_FILTER_NAME);
      const previous = filtersSchema.parse((await this.request(() => this.client.call('GetSourceFilterList', { sourceName: to }), '检查预备画面滤镜')).filters)
        .filter(filter => filter.filterName !== PICTURE_FILTER_NAME);
      for (const filter of previous) if (!filters.some(item => item.filterName === filter.filterName && item.filterKind === filter.filterKind)) {
        await this.request(() => this.client.call('RemoveSourceFilter', { sourceName: to, filterName: filter.filterName }), '移除过期预备滤镜');
      }
      for (const [position, filter] of filters.entries()) {
        const filterName = filter.filterName;
        const existing = previous.some(item => item.filterName === filter.filterName && item.filterKind === filter.filterKind);
        if (!existing) await this.request(() => this.client.call('CreateSourceFilter', { sourceName: to, filterName,
          filterKind: String(filter.filterKind), filterSettings: filter.filterSettings }), '创建预备滤镜');
        else await this.request(() => this.client.call('SetSourceFilterSettings', { sourceName: to, filterName,
          filterSettings: filter.filterSettings, overlay: false }), '更新预备滤镜');
        await this.request(() => this.client.call('SetSourceFilterEnabled', { sourceName: to, filterName, filterEnabled: filter.filterEnabled === true }), '准备滤镜状态');
        // Its place among the operator's filters, as on the source decoder (the same index when ours is not there).
        await this.request(() => this.client.call('SetSourceFilterIndex', { sourceName: to, filterName, filterIndex: position }), '准备滤镜顺序');
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
        if (!item || typeof item.sceneItemId !== 'number') throw new Error(`素材场景的名称被占用，或来源已被删除：${sceneName}`);
        const settings = await this.request(() => this.client.call('GetInputSettings', { inputName: sourceName }), 'GetInputSettings');
        const existingPath = settings.inputSettings[asset.kind === 'image' ? 'file' : 'local_file'];
        if (settings.inputKind !== kind || typeof existingPath !== 'string'
          || !includesObsMediaPath(playbackPaths, existingPath) && !await verifyRelocatedObsMediaPath(existingPath, path, asset.sha256, cachePaths)) {
          throw new Error(`OBS 里的素材来源和工程文件对不上，没有覆盖：${sourceName}。OBS 里的文件：${typeof existingPath === 'string' ? existingPath : '没有设置有效文件'}；工程里的文件：${path}`);
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
          }), '关闭素材切场景时重播');
        }
        sceneItemId = item.sceneItemId;
      } else {
        // Created anew: the creation look is the material's own look now, whatever was kept for it before (E16).
        // A record that cannot be dropped does not stop the creation: the material is not trusted this run instead.
        try {
          await this.ownLooks.drop(sourceName);
          // Its inputs are new too: no filter of ours on them (E17).
          await this.ownLooks.forgetFilterMade(sourceName); await this.ownLooks.forgetFilterMade(`${sourceName}${STANDBY_SUFFIX}`);
        } catch (error) { this.distrust(sourceName, error); }
        this.looks.delete(sourceName); this.looks.delete(`${sourceName}${STANDBY_SUFFIX}`);
        for (const name of [sourceName, `${sourceName}${STANDBY_SUFFIX}`]) { this.filterStates.delete(name); this.filterProblems.delete(name); }
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
      // The clip's look goes on while the decoder is off air, so its start shows it as it should be at once.
      if (!this.active.has(event.sourceName)) {
        const look = await this.lookFor(event.sourceName, event.transform, event.sourceSize);
        await this.sendLook(event.sourceName, look);
        // A filter OBS did not take leaves the decoder prepared; the clip's start tells it (E17).
        const failed = await this.sendFilter(event.sourceName, look);
        if (failed !== null) this.filterProblems.set(event.sourceName, failed);
      }
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
        if (typeof frame.imageData !== 'string' || !frame.imageData.startsWith('data:image/png;base64,')) throw new Error('准备的素材没有返回可用画面');
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
      if (!target || target.path !== path || target.sceneName !== event.sceneName) throw new Error(`素材场景还没准备好，请重新做开播前检查：${event.assetName}`);
      const requests: Parameters<OBSWebSocket['callBatch']>[0] = [];
      // Retiring the previous decoder goes out in the first write of a handover,
      // ahead of the new decoder, so the material never has two decoders on air,
      // nor the old one running past its clip, while the new one is still being located.
      let retiring: Parameters<OBSWebSocket['callBatch']>[0] = [];
      if (previousSource && previousSource !== event.sourceName) {
        const previous = this.prepared.get(previousSource);
        if (event.phase !== 'start' || !previous || previous.sceneName !== target.sceneName || previous.path !== path) throw new Error('接续只能替换同一素材的解码器');
        retiring = [
          { requestType: 'SetInputMute', requestData: { inputName: previousSource, inputMuted: true } },
          { requestType: 'SetSceneItemEnabled', requestData: { sceneName: previous.sceneName, sceneItemId: previous.sceneItemId, sceneItemEnabled: false } },
          { requestType: 'TriggerMediaInputAction', requestData: { inputName: previousSource, mediaAction: retirement === 'pause' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } }
        ];
      }
      // `start`: the batch position of the first retirement request. The old
      // decoder is off air once its mute and hide ran, whatever its pause or
      // stop then does.
      const retire = (start: number): { sourceName: string; through: number } | undefined => previousSource && retiring.length ? { sourceName: previousSource, through: start + 2 } : undefined;
      // Set when this start seeked and released the decoder in step with the music.
      let seekedStart: { lateMs: number } | null = null, primedStart = false;
      // How far from the music a decoder this start leaves running may be
      // afterwards: the drift check's tolerance for one on air for this clip already.
      let inStepMs = 100;
      // Why the clip's look could not be worked out: it is shown as OBS has it all the same, and told after (E16).
      let lookProblem: string | null = null;
      // Why the clip's opacity could not be set (E17): shown all the same, and told after.
      let filterProblem: string | null = null;
      if (event.phase === 'start') {
        // A primed decoder has the clip's look already. An image, a decoder started unprimed and one on air for the
        // clip this one continues get it in the batch that shows them, ahead of the show (E16); its opacity goes just
        // ahead of that batch, on its own (E17).
        const look = await this.lookFor(event.sourceName, event.transform, event.sourceSize);
        let lookSent = false;
        lookProblem = look.problem ?? null;
        filterProblem = await this.filterOf(event.sourceName, look);
        if (look.requests.length) this.looks.delete(event.sourceName);
        const wasActive = this.active.has(event.sourceName);
        // On air for this clip already (it plays on from the clip this one continues
        // in the file, or the clip comes back from under a camera): in step within
        // the drift check's tolerance, like any clip playing on. Its media clock is
        // not moved at the cut (a pause and seek would freeze the picture, and its
        // sound); the drift check puts it back in step beyond that.
        const continuing = wasActive && this.startedClips.get(event.sourceName)?.clipId === event.clipId;
        if (continuing) inStepMs = MEDIA_DRIFT_TOLERANCE_MS;
        const ready = this.primed.get(event.sourceName) === 'ready';
        if (this.primed.has(event.sourceName) && !ready) throw new Error(`素材还没准备好：${event.assetName}`);
        let primed = false, held = false;
        if (ready) {
          const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '检查预热素材');
          // Sent late, or moved in OBS since: it then starts like an unprepared
          // clip, on air first and located in step with the music. The scene
          // switch is never skipped (2026-11-09).
          held = status.mediaState === 'OBS_MEDIA_STATE_PAUSED';
          primed = held && Math.abs(status.mediaCursor - event.sourceOffsetMs) <= 100;
        }
        this.primed.delete(event.sourceName);
        primedStart = primed;
        if (event.assetKind !== 'image' && !primed && !wasActive) {
          const others = event.deferSceneSwitch ? [] : this.muteOtherSources(target.sceneName);
          // Restart only a decoder with no frame to show, or one starting from the
          // file's beginning (从零启动先激活自有场景，再执行重播). A prepared
          // decoder paused elsewhere goes on air as it is and is located from
          // there: a restart would show the file's opening frames first
          // (docs/OBS_SCENE_WORKFLOW.md: 不静默回到开头).
          const restart = !held || event.sourceOffsetMs === 0;
          // Other materials are muted before the old decoder retires, and the
          // new decoder's own requests follow the retirement directly: only a
          // failure on those leaves this material with no picture.
          await this.startBatch([
            ...others, ...retiring, ...look.requests,
            { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } },
            { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
            ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }]),
            ...(restart ? [{ requestType: 'TriggerMediaInputAction' as const, requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' } }] : [])
          ], event, others.length + retiring.length + look.requests.length + 1, retire(others.length));
          retiring = []; lookSent = true;
          if (restart) await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
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
        const others = event.deferSceneSwitch ? [] : this.muteOtherSources(target.sceneName);
        requests.push(...others, ...retiring, ...(lookSent ? [] : look.requests));
        // The new decoder counts as on air once its show ran. It is shown before
        // its sound is set, so a failure in between never leaves it audible while
        // hidden; a primed decoder stays paused until the last request anyway.
        const reach = requests.length;
        if (event.assetKind !== 'image' && !primed) seekedStart = await this.positionMedia(event.sourceName, () => event.sourceOffsetMs + performance.now() - startedAt, continuing ? MEDIA_DRIFT_TOLERANCE_MS : 30);
        requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } });
        if (event.assetKind !== 'image') requests.push({ requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } });
        requests.push(...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }]));
        // A primed decoder is shown paused on its first frame and played last.
        const play = event.assetKind !== 'image' && primed ? requests.length : undefined;
        if (play !== undefined) requests.push({ requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' } });
        await this.startBatch(requests, event, reach, retire(others.length), play);
        if (look.requests.length) this.settleLook(event.sourceName, look);
      } else {
        this.primed.delete(event.sourceName);
        if (event.assetKind !== 'image') requests.push(
          { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: retirement === 'pause' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } },
          { requestType: 'SetInputMute', requestData: { inputName: event.sourceName, inputMuted: true } }
        );
        requests.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: false } });
        await this.batch(requests);
        this.active.delete(event.sourceName); this.startedClips.delete(event.sourceName);
      }
      if (event.phase === 'start' && event.assetKind !== 'image') {
        // The clip is on air and already counts as started: a start found late or
        // out of step here is reported, and the drift check still puts it back in
        // step with the music (recovery rule B) instead of leaving it off.
        // The state acknowledgement already contains the actual decoded cursor.
        // Validate that same observation instead of adding a second RPC after
        // every layer start, which needlessly spends the output deadline.
        const status = await this.waitForState(event.sourceName, 'OBS_MEDIA_STATE_PLAYING');
        const expected = Math.round(event.sourceOffsetMs + performance.now() - startedAt);
        // Right after PLAY on a paused decoder, OBS reports a cursor about 500 ms
        // ahead that stays frozen for a few hundred ms (measured on the field
        // machine, 2026-10-22). Seeked and primed starts were verified before
        // PLAY: the paused frame, and for a seek the moment the music reached it.
        // A decoder that OBS reset behind the music is still caught. A decoder left
        // running on air for this clip is judged by the tolerance it was left by.
        if (seekedStart && seekedStart.lateMs > 100) throw new MediaOutOfStepError(`素材开始播放时比音乐晚了 ${Math.round(seekedStart.lateMs)} ms：${event.assetName} 定位解码太慢`);
        const tolerance = seekedStart ? 100 : inStepMs;
        if (typeof status.mediaCursor !== 'number' || status.mediaCursor < expected - tolerance || !seekedStart && !primedStart && status.mediaCursor > expected + tolerance) {
          const message = `切场景后素材位置对不上：${event.assetName}，按音乐应该在 ${expected} ms，OBS 实际在 ${status.mediaCursor ?? '未知'} ms`;
          // A position OBS did not report is not known to be out of step, and the
          // drift check cannot correct it either.
          throw typeof status.mediaCursor === 'number' ? new MediaOutOfStepError(message) : new MediaOnAirError(message);
        }
      }
      // On air all the same, with the look OBS has (E16).
      if (lookProblem !== null) throw new MediaOnAirError(lookFailure(event, lookProblem));
      if (filterProblem !== null) throw new MediaOnAirError(opacityFailure(event, filterProblem));
    });
  }

  /** Whether this decoder may still be on air, as far as OBS executed our requests. */
  isActive(inputName: string): boolean { return this.active.has(inputName); }

  /** The material's next clip goes on in the file where the clip on this decoder
   * ends, and its own decoder is not ready: this decoder plays on for it. From
   * here on it counts as started for `to` (its clip and its own sound), so the
   * drift check and a scene switch back follow the new clip, and the clip's start
   * continues it without moving its media clock. Sends nothing to OBS. False,
   * changing nothing, when the decoder is not on air for `fromClipId`. */
  continueClip(inputName: string, fromClipId: string, to: Pick<ManagedMediaEvent, 'clipId' | 'embeddedAudioEnabled'>): boolean {
    if (!this.active.has(inputName) || this.startedClips.get(inputName)?.clipId !== fromClipId) return false;
    this.startedClips.set(inputName, { clipId: to.clipId, audible: to.embeddedAudioEnabled });
    return true;
  }

  /** A switch to a camera mutes the media of other scenes. A switch back to a
   * material's scene (a camera ended over a clip still playing) gives its decoder
   * the sound of its clip again, after the switch, as the clip's start did. */
  async switchScene(sceneName: string): Promise<void> {
    return this.run(async () => {
      const requests = [...this.muteOtherSources(sceneName), ...this.ownSound(new Set([sceneName]))];
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
      if (new Set(layers).size !== layers.length) throw new Error('同一个素材或场景不能同时叠加两次，请用不同的素材');
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
      output.push({ requestType: 'SetCurrentProgramScene', requestData: { sceneName } }, ...this.ownSound(visible));
      await this.updateComposition(sceneName, layers, [], output);
    });
  }

  /** Shows the clip from the middle and locates it. Resolves with the red text of a look that could not be worked out
   * (the clip is shown and located as OBS has it), or null: the caller logs it, since a located clip's failure would
   * read as not located (E16). */
  async seek(event: ManagedMediaEvent, path: string, native: (name: string, position: number) => Promise<void>): Promise<string | null> {
    return this.run(async () => {
      const target = this.prepared.get(event.sourceName);
      if (event.phase !== 'start' || !target || target.path !== path || target.sceneName !== event.sceneName) throw new Error('要定位的素材还没准备好，或和工程对不上');
      const others = event.deferSceneSwitch ? [] : this.muteOtherSources(target.sceneName);
      // A look that could not be worked out is left out here and the clip shown as OBS has it; the session book stays
      // unknown, so the decoder's next start tries again.
      const look = await this.lookFor(event.sourceName, event.transform, event.sourceSize);
      if (look.requests.length) this.looks.delete(event.sourceName);
      const filterProblem = await this.filterOf(event.sourceName, look);
      // A clip started from the middle (or rebuilt after a reconnect) is this
      // decoder's clip once it is shown, also when locating it fails below: the
      // drift check reaches it once it plays, and a later switch mutes it.
      await this.startBatch([
        ...others, ...look.requests,
        { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: target.sceneItemId, sceneItemEnabled: true } },
        ...(event.assetKind !== 'image' ? [{ requestType: 'SetInputMute' as const, requestData: { inputName: event.sourceName, inputMuted: !event.embeddedAudioEnabled } }] : []),
        ...(event.deferSceneSwitch ? [] : [{ requestType: 'SetCurrentProgramScene' as const, requestData: { sceneName: target.sceneName } }])
      ], event, others.length + look.requests.length);
      if (look.requests.length) this.settleLook(event.sourceName, look);
      if (event.assetKind !== 'image') {
        await this.prepareSeekDecoder(event, target.sceneItemId);
        await native(event.sourceName, Math.round(event.sourceOffsetMs));
        await this.confirmSeek(event, target.sceneItemId);
      }
      return look.problem !== undefined ? lookFailure(event, look.problem) : filterProblem !== null ? opacityFailure(event, filterProblem) : null;
    });
  }

  private async prepareSeekDecoder(event: ManagedMediaEvent, sceneItemId: number): Promise<void> {
    const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '读取定位前素材状态');
    const hasFrame = async (): Promise<boolean> => {
      if (event.assetKind === 'audio') return true;
      const frame = await this.request(() => this.client.call('GetSceneItemTransform', { sceneName: event.sceneName, sceneItemId }), '检查素材解码画面');
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
    throw new Error(`素材“${event.assetName}”没有画面输出，已停止播放`);
  }

  private async confirmSeek(event: ManagedMediaEvent, sceneItemId: number): Promise<void> {
    const deadline = performance.now() + 2000;
    let observed = '还没有状态';
    do {
      const [status, frame] = await Promise.all([
        this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '确认素材定位位置'),
        this.request(() => this.client.call('GetSceneItemTransform', { sceneName: event.sceneName, sceneItemId }), '确认素材定位画面')
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
    throw new Error(`素材“${event.assetName}”没能定位到 ${event.sourceOffsetMs} ms，最后的状态：${observed}；已停止播放`);
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

  /** The sound of the clip each playing decoder in these scenes was started for. */
  private ownSound(scenes: ReadonlySet<string>): Parameters<OBSWebSocket['callBatch']>[0] {
    return [...this.active].flatMap(inputName => {
      const source = this.prepared.get(inputName), started = this.startedClips.get(inputName);
      return source && started && source.kind !== 'image' && scenes.has(source.sceneName)
        ? [{ requestType: 'SetInputMute' as const, requestData: { inputName, inputMuted: !started.audible } }] : [];
    });
  }

  /** What `decoder` needs for a clip's look (E16, the mapping in core `media-obs-transform.ts`), from the project and
   * what is kept on this machine only, never from what this session did before:
   * - a clip with a look: the project's look, unless the session knows the decoder has it. Before the console's first
   *   ever write to the material, its own look is read and kept on this machine (on disk before the write goes out). A
   *   clip with no crop of its own keeps the crop of the material's own look (E17);
   * - a clip without one: nothing when nothing is kept for the material (OBS's look as it is, as in 0.5.8); otherwise
   *   the kept own look, unless the session knows the decoder has it.
   * The opacity goes with it as the decoder's picture filter (`filterFor`). Only material decoders of ours are written;
   * audio has no picture. A look that cannot be worked out (reading the own look, keeping it, reading the canvas size, a
   * crop of a source whose size is not known) sends nothing and says why: the clip is still shown. */
  private async lookFor(decoder: string, transform: ManagedMediaEvent['transform'], sourceSize?: ManagedMediaEvent['sourceSize']): Promise<Look> {
    const target = this.prepared.get(decoder);
    if (!target || target.kind === 'audio') return KEEP_LOOK;
    const current = this.looks.get(decoder), item = { sceneName: target.sceneName, sceneItemId: target.sceneItemId };
    const edits = this.liveEdits.get(decoder) ?? 0, key = primaryDecoder(decoder);
    const set = (sceneItemTransform: Record<string, JsonValue>): Requests => [{ requestType: 'SetSceneItemTransform', requestData: { ...item, sceneItemTransform } }];
    const untrusted = this.untrusted.get(key);
    if (untrusted !== undefined) return { ...KEEP_LOOK, edits, problem: untrusted };
    try {
      let own = await this.ownLooks.read(key);
      if (!transform) {
        const filter = await this.filterFor(decoder);
        return !own || current === OWN_LOOK ? { ...KEEP_LOOK, edits, ...filter } : { requests: set(own), after: OWN_LOOK, edits, ...filter };
      }
      const presentation = obsMaterialPresentation(transform, await this.canvasSize(), sourceSize);
      if (!own) {
        const read = await this.request(() => this.client.call('GetSceneItemTransform', item), '读取素材在 OBS 里原来的样子');
        own = ownLookOf(read.sceneItemTransform);
        await this.ownLooks.keep(key, own);
      }
      const kept = own;
      const keptCrop = Object.fromEntries(CROP_FIELDS.flatMap(field => typeof kept[field] === 'number' ? [[field, kept[field]]] : []));
      const look: Record<string, JsonValue> = { ...presentation.sceneItemTransform, ...(transform.crop ? {} : keptCrop) }, after = JSON.stringify(look);
      const filter = await this.filterFor(decoder, presentation.filterSettings?.opacity);
      return current === after ? { ...KEEP_LOOK, edits, ...filter } : { requests: set(look), after, edits, ...filter };
    } catch (error) {
      return { ...KEEP_LOOK, edits, problem: failureReason(error) };
    }
  }

  /** The decoder's picture filter for an opacity (0.5.9 E17; undefined: fully opaque, the filter off), unless the session
   * knows it is so. Made the first time a clip needs it, kept on this machine before it is created; never removed, only
   * switched off. A decoder the console never made it on gets nothing for a clip that is fully opaque. */
  private async filterFor(decoder: string, opacity?: number): Promise<FilterLook> {
    const wanted = opacity === undefined ? FILTER_OFF : String(opacity);
    if (this.filterStates.get(decoder) === wanted) return NO_FILTER;
    const made = await this.ownLooks.filterMade(decoder), sourceName = decoder, filterName = PICTURE_FILTER_NAME;
    if (opacity === undefined) return made
      ? { filter: [{ requestType: 'SetSourceFilterEnabled', requestData: { sourceName, filterName, filterEnabled: false } }], filterAfter: wanted, filterCreates: false }
      : NO_FILTER;
    if (!made) {
      return { filter: [{ requestType: 'CreateSourceFilter', requestData: { sourceName, filterName, filterKind: OBS_PICTURE_FILTER_KIND, filterSettings: { opacity } } }],
        filterAfter: wanted, filterCreates: true };
    }
    return { filter: [
      { requestType: 'SetSourceFilterSettings', requestData: { sourceName, filterName, filterSettings: { opacity }, overlay: true } },
      { requestType: 'SetSourceFilterEnabled', requestData: { sourceName, filterName, filterEnabled: true } }
    ], filterAfter: wanted, filterCreates: false };
  }

  /** Sends the picture filter part of a look in a batch of its own, ahead of the batch that shows the clip, so OBS
   * refusing it (a filter kind it does not know, a filter of ours removed by hand) never keeps the clip off the picture.
   * Resolves with why it failed, or null. Not sent again: the next clip on this decoder works it out anew. */
  private async sendFilter(decoder: string, look: Look): Promise<string | null> {
    if (!look.filter.length) return null;
    this.filterStates.delete(decoder);
    try {
      // On disk before the filter is created, so a filter of ours is never left on a decoder this machine does not know.
      if (look.filterCreates) await this.ownLooks.keepFilterMade(decoder);
      await this.batch(look.filter);
    }
    catch (error) {
      // OBS refused to create it, so it is not there: no filter of ours is to be switched off later.
      if (look.filterCreates && error instanceof MediaBatchError) {
        try { await this.ownLooks.forgetFilterMade(decoder); } catch (forgotten) { this.distrust(primaryDecoder(decoder), forgotten); }
      }
      return failureReason(error);
    }
    if (look.filterAfter !== null) this.filterStates.set(decoder, look.filterAfter);
    return null;
  }

  /** The opacity of a clip that starts (or is located) on `decoder`: why it is not set, or null. One the decoder's
   * preparation could not set is told and not sent again; a look that could not be worked out carries no filter. */
  private async filterOf(decoder: string, look: Look): Promise<string | null> {
    const failed = this.filterProblems.get(decoder);
    this.filterProblems.delete(decoder);
    if (failed !== undefined) return failed;
    return this.sendFilter(decoder, look);
  }

  /** Sends a look on its own, for a decoder off air. */
  private async sendLook(decoder: string, look: Look): Promise<void> {
    if (!look.requests.length) return;
    this.looks.delete(decoder);
    await this.batch(look.requests);
    this.settleLook(decoder, look);
  }

  /** OBS carried the look out: the book says which one the decoder has, unless the live canvas moved it since. */
  private settleLook(decoder: string, look: Look): void {
    if (look.after === null || (this.liveEdits.get(decoder) ?? 0) !== look.edits) this.looks.delete(decoder);
    else this.looks.set(decoder, look.after);
  }

  /** The kept own look of this material decoder cannot be trusted this run (the store failed): `lookFor` says why. */
  private distrust(decoder: string, error: unknown): void {
    if (!this.untrusted.has(decoder)) this.untrusted.set(decoder, failureReason(error));
    this.looks.delete(decoder); this.looks.delete(`${decoder}${STANDBY_SUFFIX}`);
  }

  private async canvasSize(): Promise<{ width: number; height: number }> {
    if (!this.canvas) {
      const video = await this.request(() => this.client.call('GetVideoSettings'), '读取 OBS 画布尺寸');
      this.canvas = { width: video.baseWidth, height: video.baseHeight };
    }
    return this.canvas;
  }

  private async batch(requests: Parameters<OBSWebSocket['callBatch']>[0]): Promise<void> {
    const results = await this.request(() => this.client.callBatch(requests, { executionType: 0, haltOnFailure: true }), '素材场景批量控制');
    const failed = results.findIndex((result) => !result.requestStatus.result);
    const failure = results[failed];
    if (failure && !failure.requestStatus.result) throw new MediaBatchError(`${failure.requestType}：${failure.requestStatus.comment}`, failed);
    if (results.length !== requests.length) throw new MediaBatchError('OBS 素材控制响应不完整', results.length);
  }

  /** Sends one batch of a start or seek. The books follow what OBS executed: the previous
   * decoder retires once OBS ran the batch up to `retire.through` (its mute and
   * hide), and the starting decoder is on air (active, started for this clip, so
   * the drift check reaches it) once the request at index `reach` (its show) ran.
   * A request that was never sent changes nothing, so a failure never leaves two
   * decoders of one material on air in the books, nor one that OBS never showed.
   * A failure between the two leaves the material with no picture, and the error
   * says so. A primed decoder is played by the request at `play`: a failure after
   * its show and up to that leaves it on air paused on its first frame, and the
   * error says so. Nothing is sent again. */
  private async startBatch(requests: Parameters<OBSWebSocket['callBatch']>[0], event: ManagedMediaEvent, reach: number,
    retire?: { sourceName: string; through: number }, play?: number): Promise<void> {
    let executed = 0;
    try {
      await this.batch(requests);
      executed = requests.length;
    } catch (error) {
      if (error instanceof MediaBatchError) executed = error.executed;
      if (retire && executed >= retire.through && executed <= reach) {
        throw new Error(`上一段的画面已经退下，这一段的画面没能显示出来。原因：${failureReason(error)}。后面的素材照常播`);
      }
      if (play !== undefined && executed > reach && executed <= play) {
        throw new Error(event.assetKind === 'audio' ? `这一段的声音没有播起来。原因：${failureReason(error)}。后面的素材照常播`
          : `这一段的画面停在第一帧，没有播起来。原因：${failureReason(error)}。后面的素材照常播`);
      }
      throw error;
    } finally {
      if (retire && executed >= retire.through) { this.active.delete(retire.sourceName); this.startedClips.delete(retire.sourceName); }
      if (executed > reach) { this.active.add(event.sourceName); this.startedClips.set(event.sourceName, { clipId: event.clipId, audible: event.embeddedAudioEnabled }); }
    }
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
      if (performance.now() >= deadline) throw new Error(`没能确认素材的解码状态：${inputName}`);
    }
    return state;
  }

  /** Recovery rule B for a long-running clip: when OBS's cursor has drifted
   * from the music by more than the tolerance, reposition it in step. Returns
   * the drift that was corrected, or null when the clip was in step or is not
   * this decoder's playing clip. */
  /** `mayCorrect` is asked with a drift beyond the tolerance before anything is corrected: false
   * (the clip was corrected within the last minute, 0.5.9 R5) leaves the clip as it is. */
  async correctDrift(event: ManagedMediaEvent, aligned: () => number, mayCorrect: (driftMs: number) => boolean = () => true): Promise<number | null> {
    return this.run(async () => {
      if (!this.active.has(event.sourceName) || this.startedClips.get(event.sourceName)?.clipId !== event.clipId) return null;
      const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName: event.sourceName }), '读取素材播放位置');
      if (status.mediaState !== 'OBS_MEDIA_STATE_PLAYING' || typeof status.mediaCursor !== 'number') return null;
      const drift = Math.round(status.mediaCursor - aligned());
      if (Math.abs(drift) <= MEDIA_DRIFT_TOLERANCE_MS || !mayCorrect(drift)) return null;
      await this.positionMedia(event.sourceName, aligned, MEDIA_DRIFT_TOLERANCE_MS);
      return drift;
    });
  }

  /** Starts the decoder in step with the music. `aligned` is the source position
   * the music is at now. The decoder is held paused on a frame slightly ahead
   * and started when the music reaches it, so seek and decode time do not leave
   * the picture behind. Returns null when the decoder was already in step, or
   * how late it was released when the seek settled after the music passed it. */
  private async positionMedia(inputName: string, aligned: () => number, inStepMs: number): Promise<{ lateMs: number } | null> {
    const status = await this.request(() => this.client.call('GetMediaInputStatus', { inputName }), '读取素材实际位置');
    // The output error budget is not a seek tolerance: a new clip at 100ms
    // must not reuse a stale zero cursor. A continuing clip is handled by the
    // session's active-clip check before reaching this method.
    // A decoder already running in step (a fresh restart from zero, the same
    // clip returning from under a camera) is left alone; pausing it would stutter.
    if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' && typeof status.mediaCursor === 'number' && Math.abs(status.mediaCursor - aligned()) <= inStepMs) return null;
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
      if (cursor === null) throw new Error(`素材没有定位到位：${inputName}，目标 ${target} ms，OBS 实际在 ${actual ?? '未知'} ms`);
    }
    const hold = cursor - aligned();
    if (hold > 0) await new Promise<void>((resolve) => setTimeout(resolve, hold));
    await this.request(() => this.client.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }), '定位确认后继续素材');
    return { lateMs: Math.max(0, -hold) };
  }
}
