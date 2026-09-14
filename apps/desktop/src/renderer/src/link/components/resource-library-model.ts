import type { LinkObsInventory, LinkObsSceneItemTransform } from '@tb/core/link';

export const MEDIA_DRAG_TYPE = 'application/x-tblink-media-asset';
export const OBS_DRAG_TYPE = 'application/x-tblink-obs-resource';

export type ObsResource = {
  id: string;
  kind: 'scene' | 'sceneItem' | 'input' | 'filter' | 'transition';
  name: string;
  group: '场景' | '摄像头' | 'OBS 采集' | 'OBS 媒体' | 'OBS 输入' | '滤镜' | '转场';
  sceneName?: string;
  sourceName?: string;
  inputKind?: string;
  transform?: LinkObsSceneItemTransform;
  canvasWidth?: number;
  canvasHeight?: number;
};

export function parseObsResource(value: string): ObsResource {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('OBS 拖放资源格式无效');
  const kind = parsed.kind;
  const name = parsed.name;
  const group = parsed.group;
  if (!['scene', 'sceneItem', 'input', 'filter', 'transition'].includes(String(kind))) throw new Error('OBS 拖放资源类型无效');
  if (typeof name !== 'string' || typeof group !== 'string') throw new Error('OBS 拖放资源字段无效');
  return {
    id: typeof parsed.id === 'string' ? parsed.id : `${String(kind)}:${name}`,
    kind: kind as ObsResource['kind'],
    name,
    group: group as ObsResource['group'],
    ...(typeof parsed.sceneName === 'string' ? { sceneName: parsed.sceneName } : {}),
    ...(typeof parsed.sourceName === 'string' ? { sourceName: parsed.sourceName } : {}),
    ...(typeof parsed.inputKind === 'string' ? { inputKind: parsed.inputKind } : {}),
    ...(isRecord(parsed.transform) ? { transform: parseObsTransform(parsed.transform) } : {}),
    ...(typeof parsed.canvasWidth === 'number' ? { canvasWidth: parsed.canvasWidth } : {}),
    ...(typeof parsed.canvasHeight === 'number' ? { canvasHeight: parsed.canvasHeight } : {})
  };
}

export function obsPreviewSourceName(resource: ObsResource): string | null {
  if (resource.kind === 'transition') return null;
  if (resource.kind === 'filter') return resource.sourceName ?? null;
  if (resource.kind === 'sceneItem') return resource.sourceName ?? resource.name;
  return resource.name;
}

export function buildObsVisualResources(inventory: LinkObsInventory | null, sceneMode = false): ObsResource[] {
  if (!inventory) return [];
  if (sceneMode) return inventory.scenes.map((name) => ({ id: `scene:${name}`, kind: 'scene' as const, name, group: '场景' as const, sceneName: name }));
  const resources: ObsResource[] = [];
  for (const sourceName of inventory.inputs) {
    if (sourceName.startsWith('团播联动台·')) continue;
    const inputKind = inventory.inputKinds[sourceName];
    const group = inputKind ? visualGroupForInput(inputKind) : null;
    if (!inputKind || !group) continue;
    const sceneName = Object.entries(inventory.sceneItems).find(([, sourceNames]) => sourceNames.includes(sourceName))?.[0];
    if (inputKind.includes('wasapi') && !sceneName) continue;
    const transform = sceneName ? inventory.sceneItemTransforms?.[sceneName]?.[sourceName] : undefined;
    resources.push(sceneName
      ? { id: `sceneItem:${sceneName}:${sourceName}`, kind: 'sceneItem', name: sourceName, group, sceneName, sourceName, inputKind, ...(transform ? { transform } : {}), canvasWidth: 1080, canvasHeight: 1920 }
      : { id: `input:${sourceName}`, kind: 'input', name: sourceName, group, sourceName, inputKind });
  }
  return resources.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function parseObsTransform(value: Readonly<Record<string, unknown>>): LinkObsSceneItemTransform {
  const number = (key: keyof LinkObsSceneItemTransform): number => {
    const candidate = value[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new Error(`OBS 变换字段无效：${key}`);
    return candidate;
  };
  return {
    positionX: number('positionX'), positionY: number('positionY'), scaleX: number('scaleX'), scaleY: number('scaleY'), rotation: number('rotation'),
    cropTop: Math.max(0, Math.round(number('cropTop'))), cropRight: Math.max(0, Math.round(number('cropRight'))), cropBottom: Math.max(0, Math.round(number('cropBottom'))), cropLeft: Math.max(0, Math.round(number('cropLeft'))),
    sourceWidth: number('sourceWidth'), sourceHeight: number('sourceHeight'),
    outputWidth: number('outputWidth'), outputHeight: number('outputHeight'), alignment: Math.round(number('alignment'))
  };
}

function visualGroupForInput(inputKind: string): ObsResource['group'] | null {
  const normalized = inputKind.toLowerCase();
  if (normalized.includes('ffmpeg') || normalized.includes('vlc')) return 'OBS 媒体';
  if (normalized.includes('browser') || normalized.includes('text_') || normalized.includes('wasapi')) return 'OBS 输入';
  if (normalized.includes('dshow')
    || normalized.includes('decklink')
    || normalized.includes('video_capture')
    || normalized.includes('aja_input')
    || normalized.includes('ndi_source')
    || normalized.includes('spout2_capture')) return '摄像头';
  if (normalized.includes('monitor_capture')
    || normalized.includes('window_capture')
    || normalized.includes('game_capture')) return 'OBS 采集';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
