import { parseLinkProject, type AudioTrack, type LinkProject, type MtcFrameRate, type ReferenceAudio, type RundownItem } from '@tb/schema';
import { audioTracksEndMs, blankFrames, blankFramesMs, padAudioTimeline, songDurationMs, songLeadBlankMs, songTailBlankMs } from './audio-edit';
import { contentTimeRange, shiftContent } from './content-timeline';
import { lightingTimeRange, shiftLightingDocument } from './lighting-shift';
import type { LinkCommand } from './link-command';
import { programTimeOrigin } from './ma2-time-origin';
import { playbackFramesPerSecond } from './mtc-timecode';
import { withSchemaVersion } from './project-schema-version';

/*
 * Blank time before and after a song's music (0.5.9 E14). The song keeps its MTC start (`playback.mtcOffsetMs`) and
 * its console timeline (`timeOriginMs`, the pairing): blank time before the music makes the music, the content and
 * the lighting all start later by the same whole frames, and the console's timecode show gets them rewritten once
 * (the difference to `baselineTracks`, as any other edit). Blank time after the music is silence in the WAV.
 * One command, one undo step; the audio is rendered first (padSongRender) and handed in.
 */

export const P1_PADDING_REFUSAL = 'P1 跟随时，音频由 P1 播放，不能在这里加空白';
export const LEAD_ROOM_REFUSAL = '前面还有内容，不能再缩了';
export const TAIL_ROOM_REFUSAL = '后面还有内容，不能再缩了';

export type SongPaddingRoom = {
  /** How much blank time before the music can be taken away, in whole frames' milliseconds. */
  maxLeadRemoveMs: number;
  /** How much blank time after the music can be taken away. */
  maxTailRemoveMs: number;
};

const wholeFramesDown = (ms: number, frameRate: MtcFrameRate): number =>
  blankFramesMs(Math.max(0, Math.floor(ms / 1_000 * playbackFramesPerSecond(frameRate) + 1e-9)), frameRate);

/** How much blank time can be taken away: before the music, up to the earliest audio segment, clip, cue, lighting
 * point, marker, section or first beat; after it, up to the last audio segment and never shorter than the latest
 * clip, cue or lighting point. Whole frames, rounded down. */
export function songPaddingRoom(item: RundownItem, frameRate: MtcFrameRate): SongPaddingRoom {
  const audio = item.referenceAudio;
  if (!audio) return { maxLeadRemoveMs: 0, maxTailRemoveMs: 0 };
  const content = contentTimeRange(item, frameRate);
  const lighting = item.lighting ? lightingTimeRange(item.lighting) : null;
  const lead = Math.min(songLeadBlankMs(audio), content?.startMs ?? Infinity, lighting?.startMs ?? Infinity);
  const latest = Math.max(content?.endMs ?? 0, lighting?.endMs ?? 0);
  const tail = Math.min(songTailBlankMs(audio), songDurationMs(audio) - latest);
  return { maxLeadRemoveMs: wholeFramesDown(lead, frameRate), maxTailRemoveMs: wholeFramesDown(tail, frameRate) };
}

/** What the main process renders for this padding (`renderAudioSegments({ ..., tracks, durationMs })`): the tracks
 * with every segment moved, and the song's length only when blank time is left after the music (otherwise the song
 * ends with it, as before, and needs no newer file format). */
export function padSongRender(audio: ReferenceAudio, leadDeltaMs: number, tailMs: number, frameRate: MtcFrameRate): { tracks: AudioTrack[]; durationMs?: number } {
  const padded = padAudioTimeline(audio, leadDeltaMs, tailMs, frameRate);
  return padded.durationMs > audioTracksEndMs(padded.tracks) ? padded : { tracks: padded.tracks };
}

export type PadSongInput = {
  /** The song's audio when the operator started: a different one now means it changed while rendering. */
  baseAudioSha256: string;
  /** Blank time added before the music (negative: taken away), rounded to whole frames. */
  leadDeltaMs: number;
  /** The blank time after the music from now on, rounded to whole frames. */
  tailMs: number;
  /** The audio the main process rendered from `padSongRender` of the same numbers. */
  rendered: ReferenceAudio;
};

export function padSongCommand(itemId: string, input: PadSongInput, now: () => string = () => new Date().toISOString()): LinkCommand {
  return {
    id: crypto.randomUUID(),
    label: '调整歌曲前后的空白',
    execute(project) {
      const item = project.rundown.find(entry => entry.id === itemId);
      if (!item) throw new Error('这首歌已经不在节目单里了');
      if (project.playbackSource !== 'internal') throw new Error(P1_PADDING_REFUSAL);
      const audio = item.referenceAudio;
      if (!audio) throw new Error('这首歌还没有音频，不能加空白');
      if (audio.sha256 !== input.baseAudioSha256) throw new Error('音频生成期间这首歌的音频改了，请重新拖一次');
      if (!Number.isFinite(input.leadDeltaMs) || !Number.isFinite(input.tailMs) || input.tailMs < 0) throw new Error('空白的长度无效');
      const frameRate = project.timebase.frameRate;
      const frames = blankFrames(input.leadDeltaMs, frameRate);
      const deltaMs = blankFramesMs(frames, frameRate);
      const room = songPaddingRoom(item, frameRate);
      if (deltaMs < 0 && -deltaMs > room.maxLeadRemoveMs) throw new Error(LEAD_ROOM_REFUSAL);
      const tailMs = blankFramesMs(blankFrames(input.tailMs, frameRate), frameRate);
      if (songTailBlankMs(audio) - tailMs > room.maxTailRemoveMs) throw new Error(TAIL_ROOM_REFUSAL);
      const expected = padSongRender(audio, input.leadDeltaMs, input.tailMs, frameRate);
      const songMs = expected.durationMs ?? audioTracksEndMs(expected.tracks);
      const rendered = input.rendered;
      if (rendered.durationMs !== songMs || rendered.timeline?.durationMs !== expected.durationMs
        || !sameTracks(rendered.timeline?.tracks, expected.tracks)) throw new Error('生成的音频和这次的空白对不上，请重新拖一次');
      if (programTimeOrigin(item) + songMs >= 86_400_000) throw new Error('歌曲时间码超出 24 小时');
      const next: RundownItem = {
        ...item,
        ...shiftContent(item, frames, frameRate),
        referenceAudio: rendered,
        ...(item.lighting ? { lighting: shiftLightingDocument(item.lighting, deltaMs) } : {}),
        ...(item.playback ? { playback: shiftedPlayback(item.playback, deltaMs, songMs) } : {})
      };
      const rundown = project.rundown.map(entry => entry === item ? next : entry);
      return parseLinkProject(withSchemaVersion({ ...project, rundown, updatedAt: now() } satisfies LinkProject));
    },
    // History keeps the project as it was, already checked: undoing puts every field back.
    undo: before => before
  };
}

/** The rendered tracks are these: same tracks in the same order, same sources, every segment where it was asked. */
function sameTracks(rendered: readonly AudioTrack[] | undefined, expected: readonly AudioTrack[]): boolean {
  if (!rendered || rendered.length !== expected.length) return false;
  return rendered.every((track, index) => {
    const want = expected[index]!;
    return track.id === want.id && track.source.sha256 === want.source.sha256 && track.source.durationMs === want.source.durationMs
      && track.segments.length === want.segments.length && track.segments.every((segment, at) => {
        const other = want.segments[at]!;
        return segment.id === other.id && segment.startMs === other.startMs && segment.sourceOffsetMs === other.sourceOffsetMs && segment.durationMs === other.durationMs;
      });
  });
}

/** The playback range moves with the music: 0 (from the start, to the end) stays and plays the blank time too; a
 * start or end inside the music moves with it, and stays inside the song. */
function shiftedPlayback(playback: NonNullable<RundownItem['playback']>, deltaMs: number, songMs: number): NonNullable<RundownItem['playback']> {
  const startMs = playback.startMs === 0 ? 0 : Math.max(0, playback.startMs + deltaMs);
  const endMs = playback.endMs === 0 ? 0 : Math.min(songMs, playback.endMs + deltaMs);
  if (endMs !== 0 && endMs <= startMs) throw new Error('播放范围会变成空的，请先改这首歌的播放范围');
  if (startMs >= songMs) throw new Error('播放起点会落到歌曲结尾之后，请先改这首歌的播放范围');
  return { ...playback, startMs, endMs };
}
