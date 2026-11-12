import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type ProgramPlayerState } from '@tb/schema';
import { moveContentCommand, withContentTimeline } from '@tb/core/link';
import { NO_PENDING_PICTURE_EDITS } from './pending-picture-edits';
import { PENDING_REPLAY, PENDING_THIS_PASS, pictureMarks, pictureOnAir, songPicture, type PlayerVersion } from './picture-on-air';

/*
 * Rules of 0.5.9 R9 (2026-11-10 decision 1, “这一遍立即生效”) for the editor: a picture edit to the song on air goes to
 * OBS by itself and is used in this pass, also while paused. Until the picture took it (the program's pictureVersion),
 * the edited part says 「正在送到 OBS」 as information, never as a warning and never with advice to stop and replay; the
 * on-air highlight follows the version the picture runs. Following P1 nothing of it applies.
 * When the held song's picture does not follow edits now (the player says so, `pictureTakesEdits`: no picture session,
 * failed or stopped, past its restore limit, or a version refused), the window says what is true: a warning that the
 * edit is not used in this pass, why is in the status panel, and the edited parts say 「停下重播才生效」 as before R9.
 */

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number): LinkCue => ({ id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs: 2_000, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }] });
function started(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', enabled: true, notes: '',
    visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }], cues: [camera('a', 2), camera('b', 8)] }] });
}
const moved = (project: LinkProject): LinkProject => withContentTimeline(moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' })).execute(project);
const holding = (status: ProgramPlayerState['status'], picture: LinkProject): PlayerVersion => ({ state: { status, itemId: 'song' }, project: picture, outdated: false });

describe('R9 规则：播放中改画面，这一遍就用上', () => {
  it('播放中、暂停时改了机位：送到 OBS 之前标“正在送到 OBS”，是说明不是警告，不叫人停下重播', () => {
    const playing = started(), edited = moved(playing);
    for (const status of ['playing', 'paused', 'preparing'] as const) {
      const marks = pictureMarks(pictureOnAir('song', true, holding(status, playing)), songPicture(edited, 'song')!);
      expect([...marks.pending.changed]).toEqual(['cue:b']);
      expect(marks.notice?.tone).toBe('info');
      expect(marks.notice?.text).toBe('播放中改了 1 处，正在送到 OBS');
      expect(`${marks.notice?.text}${marks.notice?.detail}`).not.toMatch(/停下重播才|停止播放|按 Esc/u);
    }
  });

  it('画面用上了这一版（pictureVersion 跟上来）：不再标，在播的高亮按这一版', () => {
    const edited = moved(started());
    const marks = pictureMarks(pictureOnAir('song', true, holding('playing', edited)), songPicture(edited, 'song')!);
    expect(marks.pending).toEqual(NO_PENDING_PICTURE_EDITS);
    expect(marks.onAirtime).toEqual(songPicture(edited, 'song')!.airtime);
    expect(marks.notice).toEqual({ tone: 'info', text: '播放中改画面，这一遍就用上', detail: '改过的部分送到 OBS 之前用虚线框标出来，送到以后照改过的播，不用停下重播。' });
  });

  it('跟随 P1 时照旧：不标正在送、没有提示条，高亮按时间线本身', () => {
    const playing = started(), edited = moved(playing), current = songPicture(edited, 'song')!;
    expect(pictureMarks(pictureOnAir('song', false, holding('playing', playing)), current)).toEqual({ onAirtime: current.airtime, pending: NO_PENDING_PICTURE_EDITS, notice: null });
  });

  it('这首歌的画面现在没有联动：提示是警告，说清这一遍用不上、原因在哪看、怎么让它生效；改过的部分标“停下重播才生效”', () => {
    const playing = started(), edited = moved(playing);
    for (const status of ['playing', 'paused', 'preparing'] as const) {
      const player: PlayerVersion = { state: { status, itemId: 'song', pictureTakesEdits: false }, project: playing, outdated: false };
      const marks = pictureMarks(pictureOnAir('song', true, player), songPicture(edited, 'song')!);
      expect([...marks.pending.changed]).toEqual(['cue:b']);
      expect(marks.pendingMark).toBe(PENDING_REPLAY);
      expect(PENDING_REPLAY.text).toBe('停下重播才生效');
      expect(marks.notice).toEqual({ tone: 'warning', text: '这首歌的画面现在没有联动，播放中改的画面这一遍用不上',
        detail: '原因见状态面板「这首歌的画面」。点方块按钮“停止播放”（或按 Esc）后重新播放，就按改过的放。' });
    }
    // A player that does not say: as before, the edit is on its way.
    expect(pictureMarks(pictureOnAir('song', true, holding('playing', playing)), songPicture(edited, 'song')!).pendingMark).toBe(PENDING_THIS_PASS);
    // Following P1 nothing changes, whatever the player says.
    const p1 = pictureMarks(pictureOnAir('song', false, { state: { status: 'playing', itemId: 'song', pictureTakesEdits: false }, project: playing, outdated: false }), songPicture(edited, 'song')!);
    expect(p1).toEqual({ onAirtime: songPicture(edited, 'song')!.airtime, pending: NO_PENDING_PICTURE_EDITS, notice: null });
  });
});
