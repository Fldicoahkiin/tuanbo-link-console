import type { LightingDocument, LinkProject, MtcFrameRate, RundownItem } from '@tb/schema';
import { songDurationMs } from './audio-edit';
import { savedSongVolume } from './link-command';
import { programTimeOrigin } from './ma2-time-origin';
import { isMidiAction } from './midi-program';
import { compileRundownTimelineCues } from './timeline-state';
import { createObsProgramSnapshot } from './obs-program-snapshot';

/**
 * A newer version of the project reaches the program while it holds a song (0.5.9 S8a, design 02 §3.5). The song on air
 * keeps playing the version it started with: its audio and its timecode. What takes effect in this pass: the song's
 * saved volume, its own end action, the executors its lighting may run (they only grow until the song stops), and,
 * while its audio is the one it started with, its action MIDI after the playhead (S8b) and its picture (S8b part 2,
 * where the program has a picture output that retargets). Everything else waits for the next song, which plays the newest version. Which song is next and what
 * is prepared for it are not decided here: the program compares what it asked to prepare with what it wants now
 * (next-song-identity.ts), as the player bar can change that too.
 *
 * `before` is the version the program had until now, `after` the one that arrived, `started` the version the held song
 * started with, `actions` the version its action MIDI follows now and `picture` the one its picture follows or was last
 * asked to follow (`started` until it took a newer one). Branches an
 * edit did not touch are the same objects (shareProjectStructure), so the song is compared by reference first.
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
  /** The held song's action MIDI in `after` (when its cues fire and what they send, songActionsKey) differs from the
   * version it follows now, and its audio is the one it started with: the actions after the playhead follow `after`.
   * Actions that cannot be scheduled differ too: taking them fails and says so, and the song keeps the ones it has. */
  actions: boolean;
  /** The held song's picture in `after` (songPictureKey) differs from the version its picture follows now (`picture`,
   * else `started`), and its audio is the one it started with (0.5.9 S8b part 2): the picture is retargeted to `after`
   * (ProgramPictureOutput.retarget). Unlike the others it is compared with that version, not with `before`, so a later
   * version that puts the picture back says so too. */
  picture: boolean;
};

const NOTHING: LiveRevisionEffect = { volume: null, endAction: false, lighting: null, audio: false, removedHeld: false, actions: false, picture: false };

export function liveRevisionEffect(before: LinkProject, after: LinkProject,
  held: { itemId: string; started: LinkProject; actions?: LinkProject; picture?: LinkProject }): LiveRevisionEffect {
  const now = after.rundown.find(item => item.id === held.itemId);
  const was = before.rundown.find(item => item.id === held.itemId);
  const first = held.started.rundown.find(item => item.id === held.itemId);
  const audio = Boolean(first && now && !sameAudio(first, now));
  // Compared with the version the picture follows, not with `before`: the project's media list and canvas count too.
  const picture = Boolean(now?.enabled) && !audio && !samePicture(held.picture ?? held.started, after, held.itemId);
  // Said once, as the version that removes or changes it arrives: a later version that leaves it so changes nothing.
  if (now === was) return { ...NOTHING, picture };
  if (!now || !now.enabled) return { ...NOTHING, removedHeld: Boolean(was?.enabled) };
  const volume = !was || savedSongVolume(was) !== savedSongVolume(now) ? savedSongVolume(now) : null;
  const actionsVersion = held.actions ?? held.started, following = actionsVersion.rundown.find(item => item.id === held.itemId);
  // The same cues and layers are the same actions without working out their keys (a lighting or volume edit).
  const untouched = following?.cues === now.cues && following.visualLayers === now.visualLayers && actionsVersion.timebase.frameRate === after.timebase.frameRate;
  const actions = !audio && !untouched && (!following || songActionsKey(now, after.timebase.frameRate) !== songActionsKey(following, actionsVersion.timebase.frameRate));
  return {
    volume,
    endAction: was?.playback?.endAction !== now.playback?.endAction,
    lighting: now.lighting && now.lighting !== was?.lighting ? now.lighting : null,
    audio,
    removedHeld: false,
    actions,
    picture
  };
}

/** What a song's picture is (0.5.9 S8b part 2): its picture snapshot (createObsProgramSnapshot: cameras, material clips,
 * layers, OBS cue actions, the media they use, the canvas) without the version number, title and notes; why there is
 * none, when so. */
export function songPictureKey(project: LinkProject, itemId: string): string {
  try {
    const { item: { title, notes, ...item }, ...snapshot } = createObsProgramSnapshot(project, itemId, 0);
    void title; void notes;
    return JSON.stringify({ ...snapshot, item });
  } catch (error) { return JSON.stringify({ unavailable: error instanceof Error ? error.message : String(error) }); }
}

function samePicture(a: LinkProject, b: LinkProject, itemId: string): boolean {
  const left = a.rundown.find(item => item.id === itemId), right = b.rundown.find(item => item.id === itemId);
  if (left && right && left.cues === right.cues && left.visualLayers === right.visualLayers && left.referenceMediaClips === right.referenceMediaClips
    && a.mediaAssets === b.mediaAssets && a.outputCanvas === b.outputCanvas && a.internalVideoAudio === b.internalVideoAudio && a.playbackSource === b.playbackSource
    && a.timebase.frameRate === b.timebase.frameRate && left.referenceAudio === right.referenceAudio) return true;
  return songPictureKey(a, itemId) === songPictureKey(b, itemId);
}

/** What a song's action MIDI is (0.5.9 S8b): each MIDI action of the cues that run, with its cue and the frame it fires
 * at, as MidiProgramSession schedules them; why they cannot be scheduled (a cue on a layer that is gone), when so. */
export function songActionsKey(item: RundownItem, frameRate: MtcFrameRate): string {
  try {
    return JSON.stringify(compileRundownTimelineCues(item, frameRate)
      .flatMap(({ cue, scheduledFrame }) => cue.actions.filter(isMidiAction).map(action => [cue.id, scheduledFrame, action])));
  } catch (error) { return JSON.stringify({ unscheduled: error instanceof Error ? error.message : String(error) }); }
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
