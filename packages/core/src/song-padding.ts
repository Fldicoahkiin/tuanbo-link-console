import { parseLinkProject, type AudioTrack, type LinkProject, type MtcFrameRate, type ReferenceAudio, type RundownItem } from '@tb/schema';
import { audioTracks, audioTracksEndMs, blankFrames, blankFramesMs, padAudioTimeline, songDurationMs, songLeadBlankMs, songTailBlankMs } from './audio-edit';
import { contentTimeRange, shiftContent } from './content-timeline';
import { lightingTimeRanges, shiftLightingDocument } from './lighting-shift';
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
export const PADDING_AUDIO_CHANGED = '音频生成期间这首歌的音频改了，请重新拖一次';

export type SongPaddingRoom = {
  /** How much blank time before the music can be taken away, in whole frames' milliseconds. */
  maxLeadRemoveMs: number;
  /** How much blank time after the music can be taken away. */
  maxTailRemoveMs: number;
};

export const DAY_REFUSAL = '歌曲时间码超出 24 小时';
const DAY_MS = 86_400_000;

const framesDown = (ms: number, frameRate: MtcFrameRate): number => Math.max(0, Math.floor(ms / 1_000 * playbackFramesPerSecond(frameRate) + 1e-9));
const wholeFramesDown = (ms: number, frameRate: MtcFrameRate): number => blankFramesMs(framesDown(ms, frameRate), frameRate);

/**
 * What stops the blank time at one side (0.5.9 E15): the music itself (no blank left there), the earliest or latest
 * camera or clip, lighting point, marker or section, the music grid's first beat, or the song's timecode reaching 24
 * hours (only when adding).
 */
export type PaddingStop = 'music' | 'content' | 'point' | 'marker' | 'section' | 'first-beat' | 'day';
export type PaddingSideLimit = { blankMs: number; maxRemoveMs: number; stop: Exclude<PaddingStop, 'day'> };
/** Both sides of a song's blank time, and how much more the song may take before its timecode reaches 24 hours. */
export type SongPaddingLimits = { lead: PaddingSideLimit; tail: PaddingSideLimit; maxAddMs: number };

/** The candidate that is nearest, the music first when two are as near: removing up to it empties the blank there. */
function nearest(candidates: ReadonlyArray<readonly [PaddingSideLimit['stop'], number | undefined]>): { ms: number; stop: PaddingSideLimit['stop'] } {
  let best: { ms: number; stop: PaddingSideLimit['stop'] } = { ms: Infinity, stop: 'music' };
  for (const [stop, ms] of candidates) if (ms !== undefined && ms < best.ms) best = { ms, stop };
  return best;
}

/** How much blank time can be taken away at each side and what stops it there: before the music, up to the earliest
 * audio segment, clip, cue, lighting point, marker, section or first beat; after it, up to the last audio segment and
 * never shorter than the latest clip, cue or lighting point. Whole frames, rounded down. Null without audio. */
export function songPaddingLimits(item: RundownItem, frameRate: MtcFrameRate): SongPaddingLimits | null {
  const audio = item.referenceAudio;
  if (!audio) return null;
  const content = contentTimeRange(item, frameRate);
  const lighting = item.lighting ? lightingTimeRanges(item.lighting) : {};
  const songMs = songDurationMs(audio);
  const leadBlank = songLeadBlankMs(audio), tailBlank = songTailBlankMs(audio);
  const lead = nearest([['music', leadBlank], ['content', content?.startMs], ['point', lighting.point?.startMs], ['marker', lighting.marker?.startMs],
    ['section', lighting.section?.startMs], ['first-beat', lighting['first-beat']?.startMs]]);
  const after = (end: number | undefined): number | undefined => end === undefined ? undefined : songMs - end;
  const tail = nearest([['music', tailBlank], ['content', after(content?.endMs)], ['point', after(lighting.point?.endMs)], ['marker', after(lighting.marker?.endMs)],
    ['section', after(lighting.section?.endMs)], ['first-beat', after(lighting['first-beat']?.endMs)]]);
  return {
    lead: { blankMs: leadBlank, maxRemoveMs: wholeFramesDown(lead.ms, frameRate), stop: lead.stop },
    tail: { blankMs: tailBlank, maxRemoveMs: wholeFramesDown(tail.ms, frameRate), stop: tail.stop },
    // The song's last timecode stays before 24:00:00:00 (validateItemSettings refuses it there).
    maxAddMs: wholeFramesDown(DAY_MS - 1 - programTimeOrigin(item) - songMs, frameRate)
  };
}

/** How much blank time can be taken away (songPaddingLimits without what stops it). */
export function songPaddingRoom(item: RundownItem, frameRate: MtcFrameRate): SongPaddingRoom {
  const limits = songPaddingLimits(item, frameRate);
  return { maxLeadRemoveMs: limits?.lead.maxRemoveMs ?? 0, maxTailRemoveMs: limits?.tail.maxRemoveMs ?? 0 };
}

const STOPPED_BY: Record<Exclude<PaddingStop, 'music' | 'day'>, readonly [string, string]> = {
  content: ['最早的机位或素材', '最晚的机位或素材'], point: ['最早的灯光点', '最晚的灯光点'], marker: ['最早的标记', '最晚的标记'],
  section: ['最早的段落', '最晚的段落'], 'first-beat': ['音乐的第一拍', '音乐的第一拍']
};

/** What the operator reads when one side's blank time stops at `stop`: what is in the way, in everyday words. */
export function paddingStopText(side: 'lead' | 'tail', stop: PaddingStop): string {
  if (stop === 'day') return DAY_REFUSAL;
  if (stop === 'music') return side === 'lead' ? '音乐前面已经没有空白了' : '音乐后面已经没有空白了';
  return `${side === 'lead' ? LEAD_ROOM_REFUSAL : TAIL_ROOM_REFUSAL}：挡住的是${STOPPED_BY[stop][side === 'lead' ? 0 : 1]}`;
}

/**
 * Why this padding of the song cannot be made, or null when it can: the one check the command makes before it looks
 * at the rendered audio, asked by the editor before it renders (so a refused padding renders nothing). `leadDeltaMs`
 * and `tailMs` are the same numbers padSongRender and padSongCommand take.
 */
export function songPaddingRefusal(project: LinkProject, itemId: string, leadDeltaMs: number, tailMs: number): string | null {
  const item = project.rundown.find(entry => entry.id === itemId);
  if (!item) return '这首歌已经不在节目单里了';
  if (project.playbackSource !== 'internal') return P1_PADDING_REFUSAL;
  const audio = item.referenceAudio;
  const frameRate = project.timebase.frameRate;
  const limits = songPaddingLimits(item, frameRate);
  if (!audio || !limits) return '这首歌还没有音频，不能加空白';
  if (!Number.isFinite(leadDeltaMs) || !Number.isFinite(tailMs) || tailMs < 0) return '空白的长度无效';
  const deltaMs = blankFramesMs(blankFrames(leadDeltaMs, frameRate), frameRate);
  if (deltaMs < 0 && -deltaMs > limits.lead.maxRemoveMs) return paddingStopText('lead', limits.lead.stop);
  const tail = blankFramesMs(blankFrames(tailMs, frameRate), frameRate);
  if (limits.tail.blankMs - tail > limits.tail.maxRemoveMs) return paddingStopText('tail', limits.tail.stop);
  // The new length as padAudioTimeline makes it, worked out before it: past 24 hours it would refuse in its own words.
  if (programTimeOrigin(item) + audioTracksEndMs(audioTracks(audio)) + deltaMs + tail >= DAY_MS) return DAY_REFUSAL;
  return null;
}

/** Whole frames a drag of the blank handles moves by: a step whose milliseconds are whole where there is one (25 fps
 * every frame, 40 ms; 30 and 24 fps every 3 frames, 100 and 125 ms), so the content (whole frames) and the audio and
 * lighting (whole milliseconds) move by exactly the same time; 29.97 has none, so every frame. */
export const PADDING_STEP_FRAMES: Readonly<Record<MtcFrameRate, number>> = { '24': 3, '25': 1, '29.97df': 1, '30': 3 };

/** A blank handle held: which side, the song's limits at the press. */
export type PaddingDrag = { side: 'lead' | 'tail'; limits: SongPaddingLimits; frameRate: MtcFrameRate };
/** Where a held blank handle puts the blank time: the numbers for padSongRender and padSongCommand, the new blank at
 * the held side, and what stopped it (null: nothing, the pointer is free). */
export type PaddingDragFrame = { leadDeltaMs: number; tailMs: number; blankMs: number; stop: PaddingStop | null };

/** The blank time with the handle moved by `movedMs` from the press (right: more before the music, a longer song),
 * on the step's grid and held to the limits. */
export function paddingDragFrame(drag: PaddingDrag, movedMs: number): PaddingDragFrame {
  const fps = playbackFramesPerSecond(drag.frameRate), step = PADDING_STEP_FRAMES[drag.frameRate];
  const wanted = Math.round(movedMs / 1_000 * fps / step) * step;
  const maxAdd = framesDown(drag.limits.maxAddMs, drag.frameRate);
  const { lead, tail } = drag.limits;
  if (drag.side === 'lead') {
    const least = -framesDown(lead.maxRemoveMs, drag.frameRate);
    const frames = Math.min(maxAdd, Math.max(least, wanted));
    const leadDeltaMs = blankFramesMs(frames, drag.frameRate);
    return { leadDeltaMs, tailMs: tail.blankMs, blankMs: lead.blankMs + leadDeltaMs, stop: wanted < least ? lead.stop : wanted > maxAdd ? 'day' : null };
  }
  const base = blankFrames(tail.blankMs, drag.frameRate);
  const least = Math.max(0, Math.ceil((tail.blankMs - tail.maxRemoveMs) / 1_000 * fps - 1e-9));
  const frames = Math.min(base + maxAdd, Math.max(least, base + wanted));
  const tailMs = blankFramesMs(frames, drag.frameRate);
  return { leadDeltaMs: 0, tailMs, blankMs: tailMs, stop: base + wanted < least ? tail.stop : base + wanted > base + maxAdd ? 'day' : null };
}

/** The songs `after` moved as a whole from `before` (blank time before the music added or taken away, the lighting
 * with it), by any step: the command, its undo or its redo. The console sync treats each as rewritten from here
 * (LIGHTING_WORKFLOW 「歌曲前后加空白」): blank time after the music moves nothing. */
export function songsShiftedBetween(before: LinkProject, after: LinkProject): string[] {
  const earlier = new Map(before.rundown.map(item => [item.id, item]));
  return after.rundown.flatMap(item => {
    const was = earlier.get(item.id);
    if (!was || was === item || !was.lighting || !item.lighting || was.lighting === item.lighting || !was.referenceAudio || !item.referenceAudio) return [];
    return songLeadBlankMs(was.referenceAudio) === songLeadBlankMs(item.referenceAudio) ? [] : [item.id];
  });
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
      const audio = item?.referenceAudio;
      // Its audio changed meanwhile (an edit, an undo): this padding was worked out from another song.
      if (audio && audio.sha256 !== input.baseAudioSha256) throw new Error(PADDING_AUDIO_CHANGED);
      const refusal = songPaddingRefusal(project, itemId, input.leadDeltaMs, input.tailMs);
      if (refusal || !item || !audio) throw new Error(refusal ?? '这首歌还没有音频，不能加空白');
      const frameRate = project.timebase.frameRate;
      const frames = blankFrames(input.leadDeltaMs, frameRate);
      const deltaMs = blankFramesMs(frames, frameRate);
      const expected = padSongRender(audio, input.leadDeltaMs, input.tailMs, frameRate);
      const songMs = expected.durationMs ?? audioTracksEndMs(expected.tracks);
      const rendered = input.rendered;
      if (rendered.durationMs !== songMs || rendered.timeline?.durationMs !== expected.durationMs
        || !sameTracks(rendered.timeline?.tracks, expected.tracks)) throw new Error('生成的音频和这次的空白对不上，请重新拖一次');
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
