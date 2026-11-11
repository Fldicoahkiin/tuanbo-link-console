import { useMemo } from 'react';
import { millisecondsToFrameNumber, SceneOutputTimeline } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import type { Airtime } from './timeline-air';
import { NO_PENDING_PICTURE_EDITS } from '../view-models/pending-picture-edits';
import { usePlayheadValue, type EditorPlayhead } from './editor-playhead';
import { pictureMarks, pictureOnAir, type PictureMarks, type PlayerVersion } from '../view-models/picture-on-air';

const NO_AIRTIME: Airtime = new Map();
const NO_MARKS: PictureMarks = { onAirtime: NO_AIRTIME, pending: NO_PENDING_PICTURE_EDITS, notice: null };

/** One reading of what the output shows, by the output's own rule: which part of each clip and camera
 * plays in this timeline (`airtime`, for dimming what upper cameras cover), the marks for the picture
 * on air (`marks`, view-models/picture-on-air: while 联动台播放 holds the song, OBS plays the version it
 * started with), and the picture at the playhead for the preview drawn without OBS.
 * `playbackProject`: the project the player was opened with; LinkApp keeps it until 停止. */
export function useSceneOutput(project: LinkProject | null, itemId: string | null, playhead: EditorPlayhead, connected: boolean,
  player: Pick<PlayerVersion, 'state' | 'outdated'>, playbackProject: LinkProject | null) {
  const timeline = useMemo(() => project && itemId ? new SceneOutputTimeline(project, itemId) : null, [project, itemId]);
  const airtime = useMemo<Airtime>(() => timeline?.airtime() ?? NO_AIRTIME, [timeline]);
  const item = project?.rundown.find(entry => entry.id === itemId);
  const frameRate = project?.timebase.frameRate ?? '30';
  const internal = project?.playbackSource === 'internal';
  const { status, itemId: playing } = player.state;
  // Worked out when playback starts or stops, not on every frame the playhead moves.
  const onAir = useMemo(() => pictureOnAir(itemId, internal, { state: { status, itemId: playing }, project: playbackProject, outdated: player.outdated }),
    [itemId, internal, status, playing, playbackProject, player.outdated]);
  const marks = useMemo(() => item ? pictureMarks(onAir, { item, frameRate, airtime }) : NO_MARKS, [onAir, item, frameRate, airtime]);
  // The picture is worked out every frame (cheap), but the editor hears only when it changes (0.5.9 E2).
  const picture = usePlayheadValue(playhead, positionMs => timeline && !connected ? pictureKey(timeline, millisecondsToFrameNumber(positionMs, frameRate)) : null);
  const preview = useMemo(() => timeline && picture !== null ? resolveScenePreviewOutput(timeline, millisecondsToFrameNumber(playhead.read(), frameRate)) : null,
    [timeline, picture, playhead, frameRate]);
  return { airtime, marks, preview };
}

/** The picture at `frame` as one string: the camera, then the clips in it. */
function pictureKey(timeline: SceneOutputTimeline, frame: number): string {
  const { camera, clipIds } = timeline.picture(frame);
  return JSON.stringify([camera?.id ?? null, clipIds]);
}

/** What the output would show without OBS: every clip in the picture, with the
 * camera beneath them, never just the topmost one. */
function resolveScenePreviewOutput(timeline: SceneOutputTimeline, frame: number) {
  const { camera, clipIds } = timeline.picture(frame);
  const action = camera?.actions.find((entry) => entry.kind === 'obs.setProgramScene');
  return { scene: camera && action?.kind === 'obs.setProgramScene' ? { cueId: camera.id, sceneName: action.sceneName } : null,
    mediaClipIds: new Set(clipIds) };
}
