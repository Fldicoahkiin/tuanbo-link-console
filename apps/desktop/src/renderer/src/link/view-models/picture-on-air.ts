import { SceneOutputTimeline, type FrameRange } from '@tb/core/link';
import type { LinkProject, ProgramPlayerState } from '@tb/schema';
import { NO_PENDING_PICTURE_EDITS, pendingPictureEdits, type PendingPictureEdits, type SongPicture } from './pending-picture-edits';

/**
 * Which version of a song's picture OBS plays while the editor shows it, and what the timeline marks
 * for it (0.5.9). While 联动台播放 prepares, plays or pauses a song, OBS follows the project as it was
 * when playback started: LinkApp keeps that version until 停止, and edits made since wait for a replay
 * (pending-picture-edits). After a window reload the background program may play an older version
 * than the one this window opened (RemoteNativeProgramPlayer.outdated), and it sends its state before
 * it answers the open that says so. Until it answered, and when it plays another version, the window
 * cannot tell which version is on air: it says so and why, and marks nothing on air. Worked out again
 * on every edit, never stored.
 */

type Airtime = ReadonlyMap<string, readonly FrameRange[]>;
const NO_AIRTIME: Airtime = new Map();

/** 联动台播放 holds a song while it prepares, plays or pauses it; not once it stopped or failed. */
export function holdsSong(status: ProgramPlayerState['status']): boolean {
  switch (status) {
    case 'preparing': case 'playing': case 'paused': return true;
    case 'stopped': case 'error': return false;
  }
}

/** The song 联动台播放 holds (holdsSong); null while it holds none, and in a project that follows P1 (`internal`
 * false). The editor's transport follows the same song. */
export function songInPlayer(state: Pick<ProgramPlayerState, 'status' | 'itemId'>, internal: boolean): string | null {
  return internal && holdsSong(state.status) ? state.itemId : null;
}

/** What this window knows of 联动台播放: its state, the project it opened it with (LinkApp keeps it as it was
 * when playback started, until 停止), and whether the background program plays another version of that
 * project, taken over after a window reload (`outdated`; null while the program has not answered the open
 * yet, see program-attachment). */
export type PlayerVersion = { state: Pick<ProgramPlayerState, 'status' | 'itemId'>; project: LinkProject | null; outdated: boolean | null };

/**
 * - `timeline`: 联动台播放 does not hold the song (stopped, another song, P1 follow): the timeline is what will play.
 * - `version`: it holds the song as the project was when playback started; `song` is undefined when that
 *   version has no such song.
 * - `unconfirmed`: it holds the song, but this window cannot tell from which version, for `reason`.
 */
export type PictureOnAir =
  | { kind: 'timeline' }
  | { kind: 'version'; song: SongPicture | undefined }
  | { kind: 'unconfirmed'; reason: string };

export function pictureOnAir(itemId: string | null, internal: boolean, player: PlayerVersion): PictureOnAir {
  if (itemId === null || songInPlayer(player.state, internal) !== itemId) return { kind: 'timeline' };
  // A program kept playing over a window reload sends its state first: until it answers, it may play any version.
  if (player.outdated === null) return { kind: 'unconfirmed', reason: '正在确认联动台播放在播哪一版' };
  if (player.outdated) return { kind: 'unconfirmed', reason: '界面重新加载过，联动台播放还在按重新加载前的工程播这首歌，和这里打开的不是同一版' };
  if (!player.project) return { kind: 'unconfirmed', reason: '联动台没有记下这首歌开始播放时的时间线' };
  return { kind: 'version', song: songPicture(player.project, itemId) };
}

/** The song as `project` has it, with the frames each of its parts plays there; undefined when it has no such song. */
export function songPicture(project: LinkProject, itemId: string): SongPicture | undefined {
  const item = project.rundown.find(entry => entry.id === itemId);
  return item && { item, frameRate: project.timebase.frameRate, airtime: new SceneOutputTimeline(project, itemId).airtime() };
}

/** The line above the tracks: what happened, then why and what to do. */
export type PictureNotice = { tone: 'info' | 'warning'; text: string; detail: string };

/** What the timeline marks for the picture on air. */
export type PictureMarks = {
  /** The frames by which parts are marked on air: the airtime of the version OBS plays; null when that version
   * cannot be confirmed, so no part is. */
  onAirtime: Airtime | null;
  /** Parts changed since the song started, which OBS does not have yet: marked, never on air. */
  pending: PendingPictureEdits;
  /** The line above the tracks, there for as long as 联动台播放 holds the song, so the tracks move when
   * playback starts and stops, not in the middle of an edit; null otherwise. */
  notice: PictureNotice | null;
};

/** How to replay, named as the editor toolbar shows it: a square button with the tooltip 停止播放 (Esc). */
const REPLAY = '点方块按钮“停止播放”（或按 Esc）后重新播放';

/** `current`: the song as the editor has it. */
export function pictureMarks(onAir: PictureOnAir, current: SongPicture): PictureMarks {
  switch (onAir.kind) {
    case 'timeline': return { onAirtime: current.airtime, pending: NO_PENDING_PICTURE_EDITS, notice: null };
    case 'unconfirmed': return { onAirtime: null, pending: NO_PENDING_PICTURE_EDITS, notice: { tone: 'warning', text: '无法确认 OBS 按哪一版时间线在播',
      detail: `原因：${onAir.reason}。时间线上先不标正在播出和改过的部分。${REPLAY}，就会按这里的时间线播。` } };
    case 'version': {
      const pending = pendingPictureEdits(onAir.song, current);
      return { onAirtime: onAir.song?.airtime ?? NO_AIRTIME, pending, notice: versionNotice(pending) };
    }
  }
}

function versionNotice(edits: PendingPictureEdits): PictureNotice {
  const changed = edits.changed.size, removed = edits.removed;
  if (!changed && !removed) return { tone: 'info', text: '播放中改画面，停下重播才生效', detail: 'OBS 按开始播放时的时间线播这首歌，播放中改过的部分会用虚线框标出来。' };
  const counts = [changed ? `改了 ${changed} 处` : '', removed ? `删了 ${removed} 处` : ''].filter(Boolean).join('、');
  return { tone: 'warning', text: `播放中${counts}，停下重播才生效`,
    detail: `OBS 还在按开始播放时的时间线播${removed ? `，删掉的 ${removed} 处也照常播出` : ''}。${REPLAY}，才会用上改过的时间线。` };
}
