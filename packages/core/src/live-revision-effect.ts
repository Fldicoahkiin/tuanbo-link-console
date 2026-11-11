import type { LightingDocument, LinkProject, RundownItem } from '@tb/schema';
import { songDurationMs } from './audio-edit';
import { savedSongVolume } from './link-command';
import { programTimeOrigin } from './ma2-time-origin';

/**
 * A newer version of the project reaches the program while it holds a song (0.5.9 S8a, design 02 §3.5). The song on air
 * keeps playing the version it started with: its audio, its timecode, its picture and its action MIDI (the picture and
 * the actions follow in S8b). Only what does not touch them takes effect in this pass: the song's saved volume, its own
 * end action, and the executors its lighting may run (they only grow until the song stops). Everything else waits for
 * the next song, which plays the newest version.
 *
 * `before` is the version the program had until now, `after` the one that arrived, `started` the version the held song
 * started with. Branches an edit did not touch are the same objects (shareProjectStructure), so the song is compared by
 * reference first.
 */
export type LiveRevisionEffect = {
  /** The held song's saved volume in `after`, when it changed from `before`; null when it did not. */
  volume: number | null;
  /** The held song's own end action changed from `before` (absent and present count as a change). */
  endAction: boolean;
  /** The held song's lighting in `after`, when it changed from `before` and `after` has some; null otherwise. A song
   * whose lighting was removed keeps the executors it holds until it stops. */
  lighting: LightingDocument | null;
  /** The held song's audio itself (songAudioStructureKey) differs from the version it started with: not taken. */
  audio: boolean;
  /** The held song is gone from `after`, or is disabled there, and was there and enabled in `before`: it plays on as it started. */
  removedHeld: boolean;
};

const NOTHING: LiveRevisionEffect = { volume: null, endAction: false, lighting: null, audio: false, removedHeld: false };

export function liveRevisionEffect(before: LinkProject, after: LinkProject, held: { itemId: string; started: LinkProject }): LiveRevisionEffect {
  const now = after.rundown.find(item => item.id === held.itemId);
  const was = before.rundown.find(item => item.id === held.itemId);
  const first = held.started.rundown.find(item => item.id === held.itemId);
  // Said once, as the version that removes or changes it arrives: a later version that leaves it so changes nothing.
  if (now === was) return NOTHING;
  if (!now || !now.enabled) return { ...NOTHING, removedHeld: Boolean(was?.enabled) };
  const volume = !was || savedSongVolume(was) !== savedSongVolume(now) ? savedSongVolume(now) : null;
  return {
    volume,
    endAction: was?.playback?.endAction !== now.playback?.endAction,
    lighting: now.lighting && now.lighting !== was?.lighting ? now.lighting : null,
    audio: Boolean(first && !sameAudio(first, now)),
    removedHeld: false
  };
}

/** The one place that says what "the song's audio itself" is (0.5.9 S8a): the audio file and its segments and tracks,
 * the song's length (songDurationMs, with the silence after the music), the range played and the timecode the song
 * starts at (its MTC start, or the start its lighting or P1 binding gives). Two versions of a song with the same key
 * play the same audio with the same timecode. The beats kept in old files are not part of it. */
export function songAudioStructureKey(item: RundownItem): string {
  const audio = item.referenceAudio;
  let origin: number | string;
  try { origin = programTimeOrigin(item); } catch (error) { origin = error instanceof Error ? error.message : String(error); }
  if (!audio) return JSON.stringify([null, item.playback?.startMs ?? null, item.playback?.endMs ?? null, origin]);
  const { beats, ...sound } = audio;
  void beats;
  return JSON.stringify([sound, songDurationMs(audio), item.playback?.startMs ?? null, item.playback?.endMs ?? null, origin]);
}

/** Same audio itself; the same object is the same song without working out its key. */
export function sameAudio(a: RundownItem, b: RundownItem): boolean {
  return a === b || (a.referenceAudio === b.referenceAudio && a.playback === b.playback && a.lighting === b.lighting && a.p1Media === b.p1Media)
    || songAudioStructureKey(a) === songAudioStructureKey(b);
}

/** The songs an edit changes in a way a song on stage cannot take (0.5.9 S8a): its audio itself (sameAudio), or it was
 * enabled and is deleted or disabled. The document store asks showGate about each ('song.audio.edit', 'song.remove'). */
export function songStructureChanges(before: LinkProject, after: LinkProject): { audio: string[]; removed: string[] } {
  const audio: string[] = [], removed: string[] = [];
  if (before.rundown === after.rundown) return { audio, removed };
  const next = new Map(after.rundown.map(item => [item.id, item]));
  for (const item of before.rundown) {
    const now = next.get(item.id);
    if (now === item) continue;
    if (item.enabled && (!now || !now.enabled)) removed.push(item.id);
    else if (now && !sameAudio(item, now)) audio.push(item.id);
  }
  return { audio, removed };
}
