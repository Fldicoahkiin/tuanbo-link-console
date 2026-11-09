import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type ProgramPlayerState } from '@tb/schema';
import { millisecondsToFrameNumber, moveContentCommand, removeContentCommand, withContentTimeline, type LinkCommand } from '@tb/core/link';
import { markedOnAir } from '../components/timeline-air';
import { NO_PENDING_PICTURE_EDITS } from './pending-picture-edits';
import { holdsSong, pictureMarks, pictureOnAir, songInPlayer, songPicture, type PlayerVersion } from './picture-on-air';

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number, durationMs: number): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
/** The third song as 联动台播放 started it: camera a, then camera b from 8 s over the opening clip. */
function started(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', mediaAssets: [
    { id: 'video', name: '开场视频', kind: 'video', folderId: null, relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 20_000, width: 1080, height: 1920 }
  ], rundown: [{ id: 'other', title: '第二首', enabled: true, notes: '' }, { id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }, { id: 'clips', name: '轨道 2', visible: true, locked: false }],
    cues: [camera('a', 2, 3_000), camera('b', 8, 2_000)],
    referenceMediaClips: [{ id: 'opening', assetId: 'video', label: '开场', startTimecode: at(0), durationMs: 12_000, layerId: 'clips', canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM }] }] });
}
const edit = (project: LinkProject, ...commands: LinkCommand[]): LinkProject => commands.reduce((value, command) => withContentTimeline(command).execute(value), project);
const holding = (status: ProgramPlayerState['status'], itemId: string | null, project: LinkProject | null, outdated: boolean | null = false): PlayerVersion => ({ state: { status, itemId }, project, outdated });
const frame = (seconds: number): number => millisecondsToFrameNumber(seconds * 1_000, '30');

describe('联动台播放拿着哪首歌：编辑器的走带和画面标记按同一个判断', () => {
  it('准备中、播放中、暂停都算拿着这首歌；停止、出错和跟随 P1 都不算', () => {
    for (const status of ['preparing', 'playing', 'paused'] as const) expect(songInPlayer({ status, itemId: 'song' }, true)).toBe('song');
    for (const status of ['stopped', 'error'] as const) expect(songInPlayer({ status, itemId: 'song' }, true)).toBeNull();
    expect(songInPlayer({ status: 'playing', itemId: 'song' }, false)).toBeNull();
  });
});

describe('OBS 按哪一版画面在播', () => {
  it('停止、在播别的歌、跟随 P1 时按时间线本身', () => {
    const project = started();
    expect(pictureOnAir('song', true, holding('stopped', null, project))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', true, holding('stopped', 'song', project))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', true, holding('playing', 'other', project))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', false, holding('playing', 'song', project))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir(null, true, holding('playing', 'song', project))).toEqual({ kind: 'timeline' });
  });

  it('准备中、播放中和暂停时按开始播放那一版，准备中已经算', () => {
    const project = started();
    for (const status of ['preparing', 'playing', 'paused'] as const) {
      expect(pictureOnAir('song', true, holding(status, 'song', project))).toEqual({ kind: 'version', song: songPicture(project, 'song') });
    }
  });

  it('界面重新加载后接回的节目和这里的工程不是同一版：无法确认，并说明原因；没拿着这首歌时不影响', () => {
    const project = started();
    for (const status of ['preparing', 'playing', 'paused'] as const) {
      const onAir = pictureOnAir('song', true, holding(status, 'song', project, true));
      expect(onAir).toEqual({ kind: 'unconfirmed', reason: '界面重新加载过，联动台播放还在按重新加载前的工程播这首歌，和这里打开的不是同一版' });
    }
    expect(pictureOnAir('song', true, holding('stopped', 'song', project, true))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', true, holding('playing', 'other', project, true))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', true, holding('playing', 'song', null))).toEqual({ kind: 'unconfirmed', reason: '联动台没有记下这首歌开始播放时的时间线' });
  });

  it('评审场景：界面重新加载后，后台先发来“在播”、还没答复打开：还不知道是哪一版，先写无法确认和原因；没拿着这首歌时不影响', () => {
    // The window reopened the project; the program it takes over has not said yet whether it plays this version.
    const reopened = started();
    for (const status of ['preparing', 'playing', 'paused'] as const) {
      expect(pictureOnAir('song', true, holding(status, 'song', reopened, null))).toEqual({ kind: 'unconfirmed', reason: '正在确认联动台播放在播哪一版', waiting: true });
    }
    expect(pictureOnAir('song', true, holding('stopped', 'song', reopened, null))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', true, holding('playing', 'other', reopened, null))).toEqual({ kind: 'timeline' });
    expect(pictureOnAir('song', false, holding('playing', 'song', reopened, null))).toEqual({ kind: 'timeline' });
  });
});

describe('时间线上标出的画面', () => {
  it('不在播这首歌时，高亮按时间线本身，没有提示条', () => {
    const current = songPicture(started(), 'song')!;
    expect(pictureMarks({ kind: 'timeline' }, current)).toEqual({ onAirtime: current.airtime, pending: NO_PENDING_PICTURE_EDITS, notice: null });
  });

  it('播放中没改：高亮按开始播放那一版；提示条一直留着，写明规则', () => {
    const project = started(), current = songPicture(project, 'song')!;
    const marks = pictureMarks(pictureOnAir('song', true, holding('paused', 'song', project)), current);
    expect(marks.onAirtime).toEqual(current.airtime);
    expect(marks.pending).toEqual(NO_PENDING_PICTURE_EDITS);
    expect(marks.notice).toEqual({ tone: 'info', text: '播放中改画面，停下重播才生效', detail: 'OBS 按开始播放时的时间线播这首歌，播放中改过的部分会用虚线框标出来。' });
  });

  it('播放中挪了机位：在播的高亮跟着 OBS 那一版，挪过的标“停下重播才生效”不高亮，提示条写出按钮名', () => {
    const playing = started();
    const moved = edit(playing, moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' }));
    const marks = pictureMarks(pictureOnAir('song', true, holding('playing', 'song', playing)), songPicture(moved, 'song')!);
    expect(marks.onAirtime).toEqual(songPicture(playing, 'song')!.airtime);
    expect([...marks.pending.changed]).toEqual(['cue:b']);
    // At 9 s OBS still shows b where it started; b is drawn at 12 s, waiting for a replay.
    expect([...markedOnAir(marks.onAirtime, marks.pending.changed, frame(9), [])]).toEqual([]);
    expect([...markedOnAir(marks.onAirtime, marks.pending.changed, frame(1), [])]).toEqual(['media:opening']);
    expect(marks.notice).toEqual({ tone: 'warning', text: '播放中改了 1 处，停下重播才生效',
      detail: 'OBS 还在按开始播放时的时间线播。点方块按钮“停止播放”（或按 Esc）后重新播放，才会用上改过的时间线。' });
  });

  it('删掉的部分照常播出，提示里计数', () => {
    const playing = started();
    const removed = edit(playing, removeContentCommand('song', [{ kind: 'cue', id: 'a' }, { kind: 'cue', id: 'b' }]));
    const marks = pictureMarks(pictureOnAir('song', true, holding('playing', 'song', playing)), songPicture(removed, 'song')!);
    expect(marks.notice).toEqual({ tone: 'warning', text: '播放中删了 2 处，停下重播才生效',
      detail: 'OBS 还在按开始播放时的时间线播，删掉的 2 处也照常播出。点方块按钮“停止播放”（或按 Esc）后重新播放，才会用上改过的时间线。' });
    const both = edit(playing, removeContentCommand('song', [{ kind: 'cue', id: 'a' }]), moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' }));
    expect(pictureMarks(pictureOnAir('song', true, holding('playing', 'song', playing)), songPicture(both, 'song')!).notice?.text).toBe('播放中改了 1 处、删了 1 处，停下重播才生效');
  });

  it('开始播放那一版里没有这首歌时，什么都不算在播，会播出的部分全都等重播', () => {
    const playing = { ...started(), rundown: started().rundown.filter(entry => entry.id !== 'song') };
    const marks = pictureMarks(pictureOnAir('song', true, holding('playing', 'song', playing)), songPicture(started(), 'song')!);
    expect(marks.onAirtime).toEqual(new Map());
    expect([...marks.pending.changed].sort()).toEqual(['cue:a', 'cue:b', 'media:opening']);
  });

  it('评审场景：播放中把机位 B 拖走，界面重新加载后接回的节目对不上，不标任何正在播出，提示写无法确认和原因', () => {
    // The window reopened the project with b moved; the program still plays the version from before the reload.
    const reopened = edit(started(), moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' }));
    const marks = pictureMarks(pictureOnAir('song', true, holding('paused', 'song', reopened, true)), songPicture(reopened, 'song')!);
    expect(marks.onAirtime).toBeNull();
    expect(marks.pending).toEqual(NO_PENDING_PICTURE_EDITS);
    for (const seconds of [1, 3, 9, 12.5]) expect([...markedOnAir(marks.onAirtime, marks.pending.changed, frame(seconds), ['b'])]).toEqual([]);
    expect(marks.notice).toEqual({ tone: 'warning', text: '无法确认 OBS 按哪一版时间线在播',
      detail: '原因：界面重新加载过，联动台播放还在按重新加载前的工程播这首歌，和这里打开的不是同一版。时间线上先不标正在播出和改过的部分。点方块按钮“停止播放”（或按 Esc）后重新播放，就会按这里的时间线播。' });
  });

  it('评审场景：后台还没答复打开时不按重新打开的工程标正在播出，提示写正在确认', () => {
    const reopened = edit(started(), moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' }));
    const marks = pictureMarks(pictureOnAir('song', true, holding('playing', 'song', reopened, null)), songPicture(reopened, 'song')!);
    expect(marks.onAirtime).toBeNull();
    expect(marks.pending).toEqual(NO_PENDING_PICTURE_EDITS);
    for (const seconds of [1, 3, 9, 12.5]) expect([...markedOnAir(marks.onAirtime, marks.pending.changed, frame(seconds), ['b'])]).toEqual([]);
    expect(marks.notice).toEqual({ tone: 'warning', text: '无法确认 OBS 按哪一版时间线在播',
      detail: '原因：正在确认联动台播放在播哪一版。时间线上先不标正在播出和改过的部分。确认以后这里会自动更新。' });
  });
});

describe('联动台播放拿着歌的状态只在一处判断', () => {
  it('准备中、播放中、暂停算拿着，停止和出错不算', () => {
    expect((['preparing', 'playing', 'paused', 'stopped', 'error'] as const).map(holdsSong)).toEqual([true, true, true, false, false]);
  });
});
