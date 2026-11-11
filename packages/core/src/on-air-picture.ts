/**
 * What OBS should show at one frame: the contract between the one picture
 * function (`SceneOutputTimeline.pictureAt`, 0.5.9 design 01 §4.1) and the
 * reconcile planner. Types only; the timeline computes the values.
 */

/** One scene of a composition, top first, as `obs.setProgramScene.sceneLayers` lists them. */
export type CompositionLayer = { sceneName: string };

/**
 * The scene on program:
 * - `scene`: a camera is the whole frame;
 * - `clip`: one clip on top, shown through its own owned scene;
 * - `composition`: several layers stacked in the application-owned composition scene;
 * - `hold`: nothing has a picture, the last camera that ended stays (null: none yet, program left alone).
 */
export type PictureTarget =
  | { kind: 'scene'; sceneName: string; cueId: string }
  | { kind: 'clip'; sceneName: string; clipId: string }
  | { kind: 'composition'; sceneName: string; layers: CompositionLayer[] }
  | { kind: 'hold'; cueId: string | null; sceneName: string | null };

/** A clip on its decoder at this frame. `offsetMs`: the clip's position at the frame.
 * `continuesFrom`: the clip before a cut of the same material on the same decoder,
 * which keeps playing instead of restarting. */
export type PictureClip = { clipId: string; sourceName: string; assetId: string; layerId: string; sceneName: string;
  offsetMs: number; continuesFrom?: string | undefined };

/** A "show source" span open at this frame. */
export type PictureShow = { cueId: string; actionId: string; sceneName: string | null; sourceName: string; layerId: string };

/**
 * The picture at `frame`. `clips`: visible clips; `covered`: clips under a camera
 * whose decoders keep running so their reveal does not restart them; `sounds`:
 * sound clips, which no picture covers. `camera`: the camera cue in the picture, alone or
 * under clips in a composition; `held` when its own span has ended and it stays because
 * nothing else has a picture.
 */
export type OnAirPicture = { frame: number; target: PictureTarget; camera: PictureCamera | null; clips: PictureClip[]; covered: PictureClip[];
  shows: PictureShow[]; sounds: PictureClip[] };

export type PictureCamera = { cueId: string; held: boolean };

/** The scene the target puts on program, or null when the program is left as it is. */
export function pictureProgramScene(target: PictureTarget): string | null {
  return target.sceneName;
}

/**
 * The picture a stopped song leaves (2026-11-11 decision 3, design 00 §8): the
 * scene on program stays as it was, clips hold their last frame (paused by the
 * reconcile transport), sounds end, and the song's shown sources are hidden as on
 * 2026-11-09. Reconcile it with `transport: 'paused'`.
 */
export function stoppedPicture(last: OnAirPicture): OnAirPicture {
  const target: PictureTarget = { kind: 'hold', sceneName: pictureProgramScene(last.target),
    cueId: last.target.kind === 'scene' || last.target.kind === 'hold' ? last.target.cueId : null };
  return { frame: last.frame, target, camera: last.camera && { cueId: last.camera.cueId, held: true }, clips: last.clips, covered: last.covered, shows: [], sounds: [] };
}
