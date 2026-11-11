import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, type ReferenceCanvasTransform, type ReferenceMediaClip } from '@tb/schema';

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
 */

export type ObsCanvasSize = { width: number; height: number };

/** The scene item transform OBS gets for a clip whose look the project decides. */
export type ObsMaterialSceneItemTransform = {
  positionX: number; positionY: number; scaleX: number; scaleY: number; rotation: number;
  alignment: 0; boundsType: 'OBS_BOUNDS_NONE';
};

export function obsMaterialPresentation(transform: ReferenceCanvasTransform, canvas: ObsCanvasSize): { sceneItemTransform: ObsMaterialSceneItemTransform } {
  if (!(canvas.width > 0) || !(canvas.height > 0)) throw new Error('OBS 画布尺寸无效，没法摆放素材');
  return { sceneItemTransform: {
    positionX: transform.x * canvas.width,
    positionY: transform.y * canvas.height,
    scaleX: transform.scale * transform.scaleX,
    scaleY: transform.scale * transform.scaleY,
    rotation: transform.rotation,
    alignment: 0,
    boundsType: 'OBS_BOUNDS_NONE'
  } };
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
    || value.scaleY !== plain.scaleY || value.rotation !== plain.rotation;
}

/** Where the stage draws a clip, from the transform OBS gets: the centre and size as shares of the canvas, and the
 * rotation. `sourceSize` is the material's own pixels. */
export function stagePlacement(transform: ReferenceCanvasTransform, sourceSize: ObsCanvasSize, canvas: ObsCanvasSize): { left: number; top: number; width: number; height: number; rotation: number } {
  const { sceneItemTransform: obs } = obsMaterialPresentation(transform, canvas);
  return { left: obs.positionX / canvas.width, top: obs.positionY / canvas.height,
    width: sourceSize.width * obs.scaleX / canvas.width, height: sourceSize.height * obs.scaleY / canvas.height, rotation: obs.rotation };
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

/** The clip transform that puts the picture where it is in OBS now: its centre and its size on the canvas in pixels,
 * and its rotation. For an edit of the material's own scene item on the live canvas, which then goes into the project
 * as any other edit. Kept inside what the project can hold. */
export function canvasTransformFromObs(placed: { centerX: number; centerY: number; width: number; height: number; rotation: number },
  sourceSize: ObsCanvasSize, canvas: ObsCanvasSize): ReferenceCanvasTransform {
  if (!(sourceSize.width > 0) || !(sourceSize.height > 0) || !(canvas.width > 0) || !(canvas.height > 0)) throw new Error('素材或 OBS 画布尺寸无效，没法记下这个位置');
  const rotation = ((placed.rotation % 360) + 540) % 360 - 180;
  return { x: clamp(placed.centerX / canvas.width, -1, 2), y: clamp(placed.centerY / canvas.height, -1, 2), scale: 1,
    scaleX: clamp(Math.abs(placed.width) / sourceSize.width, 0.05, 8), scaleY: clamp(Math.abs(placed.height) / sourceSize.height, 0.05, 8),
    rotation: rotation === -180 ? 180 : rotation };
}
