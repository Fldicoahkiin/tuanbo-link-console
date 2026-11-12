import { canvasTransformHasLookParts, DEFAULT_REFERENCE_CANVAS_TRANSFORM, type ReferenceCanvasCrop, type ReferenceCanvasTransform, type ReferenceMediaClip } from '@tb/schema';

/*
 * How a clip looks in OBS, and the only place that works it out (0.5.9 E16). The material's own scene item gets it
 * when the material is prepared (main process obs-media-scenes.ts), and the editor's stage draws its preview from the
 * same numbers (ReferenceStage.tsx), so what the editor shows is what goes on air.
 *
 * - `canvasTransform`: the centre of the picture as a share of the canvas (x, y), its size against the source's own
 *   pixels (scale times scaleX or scaleY: 1 is the source's size) and its rotation in degrees.
 * - OBS: the scene item's centre (alignment 0) at x times the canvas width, y times its height, scaled by
 *   scale times scaleX and scaleY, rotated, with no bounding box (a box would rescale it to the box). The same mapping
 *   the old managed output sent before 8c409fe1, plus the bounding box set off: material scene items are created
 *   fitted to the canvas with one.
 * - A clip leaves OBS's look alone until it is edited in the editor (`obsTransform`, problem 1 decided A on
 *   2026-11-11): older projects never sent their transform, so sending it now would change the picture on air.
 * - Mirror, crop and opacity (0.5.9 E17): a mirror is the sign of the scene item's scale (OBS flips about the centre,
 *   alignment 0); a crop is the scene item's crop in the source's own pixels, worked out from the source's size, and the
 *   centre stays the centre of what is left (as OBS places a cropped item); opacity is the setting of one filter of
 *   ours on the decoder's own input (main process obs-media-scenes.ts), absent when the picture is fully opaque. OBS
 *   scales and mirrors first, then rotates, so the stage does the same.
 */

export type ObsCanvasSize = { width: number; height: number };

/** The scene item transform OBS gets for a clip whose look the project decides. The crop only when the clip has one:
 * otherwise the scene item keeps the crop the material has in OBS. */
export type ObsMaterialSceneItemTransform = {
  positionX: number; positionY: number; scaleX: number; scaleY: number; rotation: number;
  alignment: 0; boundsType: 'OBS_BOUNDS_NONE';
  cropTop?: number; cropRight?: number; cropBottom?: number; cropLeft?: number;
};

/** OBS's kind of the filter that carries a clip's opacity, and the one setting of it the console writes. */
export const OBS_PICTURE_FILTER_KIND = 'color_filter_v2';
export type ObsMaterialFilterSettings = { opacity: number };

export function obsMaterialPresentation(transform: ReferenceCanvasTransform, canvas: ObsCanvasSize, sourceSize?: ObsCanvasSize): {
  sceneItemTransform: ObsMaterialSceneItemTransform; filterSettings?: ObsMaterialFilterSettings;
} {
  if (!(canvas.width > 0) || !(canvas.height > 0)) throw new Error('OBS 画布尺寸无效，没法摆放素材');
  const crop = transform.crop;
  if (crop && !(sourceSize && sourceSize.width > 0 && sourceSize.height > 0)) throw new Error('不知道素材原来有多大，没法裁剪');
  const sceneItemTransform: ObsMaterialSceneItemTransform = {
    positionX: transform.x * canvas.width,
    positionY: transform.y * canvas.height,
    scaleX: transform.scale * transform.scaleX * (transform.flipX === true ? -1 : 1),
    scaleY: transform.scale * transform.scaleY * (transform.flipY === true ? -1 : 1),
    rotation: transform.rotation,
    alignment: 0,
    boundsType: 'OBS_BOUNDS_NONE'
  };
  if (crop && sourceSize) Object.assign(sceneItemTransform, {
    cropTop: Math.round(crop.top * sourceSize.height), cropRight: Math.round(crop.right * sourceSize.width),
    cropBottom: Math.round(crop.bottom * sourceSize.height), cropLeft: Math.round(crop.left * sourceSize.width)
  });
  const opacity = transform.opacity;
  return opacity !== undefined && opacity < 1 ? { sceneItemTransform, filterSettings: { opacity } } : { sceneItemTransform };
}

/** Rotation turned a quarter to the right (1, clockwise as on screen) or to the left (-1), kept within -180 to 180. */
export function quarterTurn(transform: ReferenceCanvasTransform, direction: 1 | -1): ReferenceCanvasTransform {
  return { ...transform, rotation: wrapRotation(transform.rotation + 90 * direction) };
}

/** The look with mirror, crop and opacity changed; a part set back to its plain value is left out, as a clip that never
 * had it. Position, size and rotation stay. */
export function withLookParts(transform: ReferenceCanvasTransform, parts: { flipX?: boolean; flipY?: boolean; crop?: ReferenceCanvasCrop | null; opacity?: number }): ReferenceCanvasTransform {
  const next: ReferenceCanvasTransform = { ...transform };
  if (parts.flipX !== undefined) { if (parts.flipX) next.flipX = true; else delete next.flipX; }
  if (parts.flipY !== undefined) { if (parts.flipY) next.flipY = true; else delete next.flipY; }
  if (parts.crop !== undefined) {
    const crop = parts.crop;
    if (crop && (crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0)) next.crop = { ...crop }; else delete next.crop;
  }
  if (parts.opacity !== undefined) { if (parts.opacity < 1) next.opacity = Math.max(0, parts.opacity); else delete next.opacity; }
  return next;
}

/** The mirror, crop and opacity of a look, to carry over a preset that only places the picture. */
export function lookPartsOf(transform: ReferenceCanvasTransform): Pick<ReferenceCanvasTransform, 'flipX' | 'flipY' | 'crop' | 'opacity'> {
  const { flipX, flipY, crop, opacity } = transform;
  return { ...(flipX !== undefined ? { flipX } : {}), ...(flipY !== undefined ? { flipY } : {}), ...(crop !== undefined ? { crop } : {}), ...(opacity !== undefined ? { opacity } : {}) };
}

function wrapRotation(degrees: number): number {
  const wrapped = ((degrees % 360) + 540) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** The look the project sends to OBS for this clip; undefined when OBS keeps its own. */
export function clipObsTransform(clip: Pick<ReferenceMediaClip, 'canvasTransform' | 'obsTransform'>): ReferenceCanvasTransform | undefined {
  return clip.obsTransform === 'project' ? clip.canvasTransform : undefined;
}

/** A clip adjusted in the editor before 0.5.9, whose adjustment never reached OBS: it is only the editor's preview.
 * Told by the transform differing from the one every new clip gets while the clip leaves OBS's look alone. The editor
 * says so on the clip and lets the operator pick: send it to OBS, or keep OBS's look. */
export function clipLookOnlyInPreview(clip: Pick<ReferenceMediaClip, 'canvasTransform' | 'obsTransform'>): boolean {
  if (clip.obsTransform !== undefined) return false;
  const value = clip.canvasTransform, plain = DEFAULT_REFERENCE_CANVAS_TRANSFORM;
  return value.x !== plain.x || value.y !== plain.y || value.scale !== plain.scale || value.scaleX !== plain.scaleX
    || value.scaleY !== plain.scaleY || value.rotation !== plain.rotation || canvasTransformHasLookParts(value);
}

/** Where the stage draws a clip, from what OBS gets: the centre and size of the picture left after the crop, as shares
 * of the canvas, its rotation, its mirror, the crop as shares of the source (to place the source inside the picture) and
 * its opacity. `sourceSize` is the material's own pixels. */
export type StagePlacement = {
  left: number; top: number; width: number; height: number; rotation: number;
  flipX: boolean; flipY: boolean; crop: ReferenceCanvasCrop; opacity: number;
};
export function stagePlacement(transform: ReferenceCanvasTransform, sourceSize: ObsCanvasSize, canvas: ObsCanvasSize): StagePlacement {
  const { sceneItemTransform: obs, filterSettings } = obsMaterialPresentation(transform, canvas, sourceSize);
  const crop = { top: (obs.cropTop ?? 0) / sourceSize.height, right: (obs.cropRight ?? 0) / sourceSize.width,
    bottom: (obs.cropBottom ?? 0) / sourceSize.height, left: (obs.cropLeft ?? 0) / sourceSize.width };
  return { left: obs.positionX / canvas.width, top: obs.positionY / canvas.height,
    width: sourceSize.width * (1 - crop.left - crop.right) * Math.abs(obs.scaleX) / canvas.width,
    height: sourceSize.height * (1 - crop.top - crop.bottom) * Math.abs(obs.scaleY) / canvas.height,
    rotation: obs.rotation, flipX: obs.scaleX < 0, flipY: obs.scaleY < 0, crop, opacity: filterSettings?.opacity ?? 1 };
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

/** The clip transform that puts the picture where it is in OBS now: its centre and its size on the canvas in pixels
 * (of the picture left after the crop), its rotation, whether OBS mirrors it (a negative scale) and its crop in source
 * pixels. For an edit of the material's own scene item on the live canvas, which then goes into the project as any
 * other edit; the clip's opacity is not in a scene item and is carried over by the caller. Kept inside what the project
 * can hold. */
export function canvasTransformFromObs(placed: { centerX: number; centerY: number; width: number; height: number; rotation: number;
  flipX?: boolean; flipY?: boolean; cropPixels?: { top: number; right: number; bottom: number; left: number } },
  sourceSize: ObsCanvasSize, canvas: ObsCanvasSize): ReferenceCanvasTransform {
  if (!(sourceSize.width > 0) || !(sourceSize.height > 0) || !(canvas.width > 0) || !(canvas.height > 0)) throw new Error('素材或 OBS 画布尺寸无效，没法记下这个位置');
  const pixels = placed.cropPixels;
  const share = (value: number, size: number): number => clamp(value / size, 0, 0.95);
  let crop: ReferenceCanvasCrop | null = null;
  if (pixels && (pixels.top > 0 || pixels.right > 0 || pixels.bottom > 0 || pixels.left > 0)) {
    const left = share(pixels.left, sourceSize.width), top = share(pixels.top, sourceSize.height);
    crop = { top, left, right: Math.min(share(pixels.right, sourceSize.width), 0.95 - left), bottom: Math.min(share(pixels.bottom, sourceSize.height), 0.95 - top) };
  }
  const shownWidth = sourceSize.width * (1 - (crop?.left ?? 0) - (crop?.right ?? 0)), shownHeight = sourceSize.height * (1 - (crop?.top ?? 0) - (crop?.bottom ?? 0));
  const placedLook: ReferenceCanvasTransform = { x: clamp(placed.centerX / canvas.width, -1, 2), y: clamp(placed.centerY / canvas.height, -1, 2), scale: 1,
    scaleX: clamp(Math.abs(placed.width) / shownWidth, 0.05, 8), scaleY: clamp(Math.abs(placed.height) / shownHeight, 0.05, 8),
    rotation: wrapRotation(placed.rotation) };
  return withLookParts(placedLook, { flipX: placed.flipX === true, flipY: placed.flipY === true, crop });
}
