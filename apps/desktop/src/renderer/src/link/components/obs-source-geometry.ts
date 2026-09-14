import type { LinkObsInventory, LinkObsSceneItemTransform } from '@tb/core/link';

export type ObsSourceSize = {
  width: number;
  height: number;
};

export function hasVisibleObsPreviewPixels(pixels: Uint8ClampedArray): boolean {
  if (pixels.length % 4 !== 0) throw new Error('OBS 预览像素数据不是合法的 RGBA 序列');
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 0) return true;
  }
  return false;
}

const OBS_PREVIEW_MAX_DIMENSION = 960;

export function obsPreviewRequestSize(source: ObsSourceSize): ObsSourceSize {
  if (!Number.isFinite(source.width) || source.width <= 0 || !Number.isFinite(source.height) || source.height <= 0) {
    throw new Error('OBS 来源预览尺寸必须是正有限数值');
  }
  const scale = Math.min(1, OBS_PREVIEW_MAX_DIMENSION / Math.max(source.width, source.height));
  return {
    width: Math.max(8, Math.round(source.width * scale)),
    height: Math.max(8, Math.round(source.height * scale))
  };
}

export function obsSourceSizeOnCanvas(source: ObsSourceSize, canvas: ObsSourceSize): ObsSourceSize {
  return {
    width: source.width / canvas.width * 100,
    height: source.height / canvas.height * 100
  };
}

export function resolveObsSceneItemGeometry(
  inventory: LinkObsInventory | null,
  sceneName: string,
  sourceName: string
): LinkObsSceneItemTransform | null {
  return inventory?.sceneItemTransforms?.[sceneName]?.[sourceName] ?? null;
}

export function resolveObsSourceSize(
  inventory: LinkObsInventory | null,
  sceneName: string,
  sourceName: string
): ObsSourceSize | null {
  const exact = resolveObsSceneItemGeometry(inventory, sceneName, sourceName);
  const exactSize = exact ? sizeFromGeometry(exact) : null;
  if (exactSize) return exactSize;

  const inventorySize = inventory?.sourceSizes[sourceName];
  if (inventorySize && isValidSourceSize(inventorySize)) return inventorySize;

  const matches = Object.values(inventory?.sceneItemTransforms ?? {})
    .map((scene) => scene[sourceName])
    .filter((geometry): geometry is LinkObsSceneItemTransform => geometry !== undefined)
    .map(sizeFromGeometry)
    .filter((size): size is ObsSourceSize => size !== null);
  const firstMatch = matches[0];
  if (!firstMatch) return null;

  return matches.every((size) => size.width === firstMatch.width && size.height === firstMatch.height)
    ? firstMatch
    : null;
}

function sizeFromGeometry(geometry: LinkObsSceneItemTransform): ObsSourceSize | null {
  const size = { width: geometry.sourceWidth, height: geometry.sourceHeight };
  return isValidSourceSize(size) ? size : null;
}

function isValidSourceSize(size: ObsSourceSize): boolean {
  return Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0;
}
