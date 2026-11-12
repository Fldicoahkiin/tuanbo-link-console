import { P1_PADDING_REFUSAL, audioTracks, audioTracksEndMs, blankFrames, padSongCommand, padSongRender, songDurationMs, songLeadBlankMs, songPaddingRefusal, type LinkCommand, type LinkDesktopApi } from '@tb/core/link';
import { referenceAudioSchema, type LinkProject, type RundownItem } from '@tb/schema';

/*
 * Blank time before and after a song's music in the editor (0.5.9 E15, 05 设计 7.7–7.8): whether the song's blank
 * handles show and may be held, and what letting go does. The rules of the move are core's (song-padding.ts); this is
 * only the order of the steps and what the page says.
 */

export const PADDING_RENDERING = '正在生成音频…';

/** What the page shows of the song's blank time: `handles` drawn on the audio track; `blocked` why they and the
 * fields cannot be used now (null: they can); `waiting` when that is only a wait (the show, the audio being made). */
export type SongPaddingState = { handles: boolean; blocked: string | null; waiting: boolean };

/**
 * In this order: a song without audio has no handles (it cannot be played at all); P1 follow has none and says why;
 * the song on stage waits with the store's own words (`songAudioEditWait`); the show on waits for every song, since
 * the audio is made by the main process, which refuses while it is on (`showGate('audio.render')`); the console sync
 * asks for the song to be in step first (`ma2PaddingWait`); and only one padding is made at a time.
 */
export function songPaddingState(input: { hasAudio: boolean; internal: boolean; stageWait: string | null; renderWait: string | null; syncWait: string | null; busy: boolean }): SongPaddingState {
  if (!input.hasAudio) return { handles: false, blocked: '这首歌还没有音频，不能加空白', waiting: false };
  if (!input.internal) return { handles: false, blocked: P1_PADDING_REFUSAL, waiting: false };
  const wait = input.stageWait ?? input.renderWait;
  if (wait) return { handles: true, blocked: wait, waiting: true };
  if (input.syncWait) return { handles: true, blocked: input.syncWait, waiting: false };
  if (input.busy) return { handles: true, blocked: PADDING_RENDERING, waiting: true };
  return { handles: true, blocked: null, waiting: false };
}

/** What letting go of a handle, or a field, asks for: the same two numbers for the render and the command. */
export type PaddingRequest = { itemId: string; leadDeltaMs: number; tailMs: number };

export type PaddingSteps = {
  /** The project as it is now (the store's). */
  project: () => LinkProject | null;
  projectPath: string | null;
  /** Why the page waits now (songPaddingState `blocked`), asked again before anything is made. */
  blocked: () => string | null;
  /** The main process renders the tracks to the song's length (`link:render-audio-segments`). */
  render: (request: Parameters<LinkDesktopApi['renderAudioSegments']>[0]) => Promise<unknown>;
  /** The store's execute: one command, one undo step; it refuses a song on stage. */
  execute: (command: LinkCommand) => void;
};

/**
 * Pads the song: checked first (core songPaddingRefusal, so nothing is rendered for a padding the command would refuse),
 * rendered by the main process (padSongRender), then the one command (padSongCommand) with the same numbers and the
 * audio the song had when this began: if the song's audio changed while it was rendered, the command refuses and
 * nothing is written. Each failure is thrown for the page to show and log; nothing is tried again. 'unchanged' when
 * the blank time is already so.
 */
export async function padSongSteps(request: PaddingRequest, steps: PaddingSteps): Promise<'padded' | 'unchanged'> {
  const project = steps.project();
  if (!project) throw new Error('还没打开工程');
  const refusal = songPaddingRefusal(project, request.itemId, request.leadDeltaMs, request.tailMs);
  if (refusal) throw new Error(refusal);
  const blocked = steps.blocked();
  if (blocked) throw new Error(blocked);
  if (!steps.projectPath) throw new Error('请先保存工程，再加空白');
  // songPaddingRefusal found the song and its audio; read once more for the types.
  const audio = project.rundown.find(item => item.id === request.itemId)?.referenceAudio;
  if (!audio) throw new Error('这首歌还没有音频，不能加空白');
  const frameRate = project.timebase.frameRate;
  const plan = padSongRender(audio, request.leadDeltaMs, request.tailMs, frameRate);
  if (blankFrames(request.leadDeltaMs, frameRate) === 0 && (plan.durationMs ?? audioTracksEndMs(plan.tracks)) === songDurationMs(audio)) return 'unchanged';
  const first = plan.tracks[0];
  if (!first) throw new Error('这首歌还没有音频，不能加空白');
  const rendered = referenceAudioSchema.parse(await steps.render({ projectPath: steps.projectPath, source: first.source, segments: first.segments, tracks: plan.tracks,
    ...(plan.durationMs === undefined ? {} : { durationMs: plan.durationMs }) }));
  steps.execute(padSongCommand(request.itemId, { baseAudioSha256: audio.sha256, leadDeltaMs: request.leadDeltaMs, tailMs: request.tailMs, rendered }));
  return 'padded';
}

/** A stretch of blank time on the timeline; `unplayed` when it lies outside the song's playback range, where it is not heard. */
export type BlankPiece = { side: 'lead' | 'tail'; startMs: number; endMs: number; unplayed: boolean };

/** The blank time before and after the music, cut where the playback range starts and ends. */
export function blankPieces(item: Pick<RundownItem, 'referenceAudio' | 'playback'>): BlankPiece[] {
  const audio = item.referenceAudio;
  if (!audio) return [];
  const songMs = songDurationMs(audio), leadMs = songLeadBlankMs(audio), musicEnd = audioTracksEndMs(audioTracks(audio));
  const from = item.playback?.startMs ?? 0, to = item.playback?.endMs ? item.playback.endMs : songMs;
  const cut = (side: BlankPiece['side'], startMs: number, endMs: number): BlankPiece[] => {
    if (endMs <= startMs) return [];
    const edges = [startMs, ...[from, to].filter(edge => edge > startMs && edge < endMs).sort((a, b) => a - b), endMs];
    return edges.slice(1).map((edge, index) => {
      const begin = edges[index]!;
      return { side, startMs: begin, endMs: edge, unplayed: edge <= from || begin >= to };
    });
  };
  return [...cut('lead', 0, leadMs), ...cut('tail', musicEnd, songMs)];
}
