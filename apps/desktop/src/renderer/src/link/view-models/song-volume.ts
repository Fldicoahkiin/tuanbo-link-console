import { savedSongVolume } from '@tb/core/link';
import type { LinkProject, ProgramPlayerState, RundownItem } from '@tb/schema';
import { songInPlayer } from './picture-on-air';

/** What the player-bar volume slider shows (2026-11-09, docs/SONG_VOLUME.md). */
export type SongVolumeView = {
  /** "This song": the one 联动台播放 holds, otherwise the selected one; null when neither (the slider is disabled). */
  item: RundownItem | null;
  /** The song in the player, which hears a drag at once; null when none is. */
  playing: string | null;
  /** The song's own volume as saved. */
  saved: number;
  /** This run's MIDI CC7 volume, shown next to the slider; null when none holds. */
  override: number | null;
};

export function songVolumeView(project: LinkProject | null, state: Pick<ProgramPlayerState, 'status' | 'itemId' | 'volumeOverride'>, selectedItemId: string | null): SongVolumeView {
  const playing = songInPlayer(state, true), itemId = playing ?? selectedItemId;
  const item = project?.rundown.find(entry => entry.id === itemId) ?? null;
  return { item, playing, saved: item ? savedSongVolume(item) : 100, override: playing && item ? state.volumeOverride ?? null : null };
}
