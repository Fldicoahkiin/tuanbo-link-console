import { savedSongVolume } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

/**
 * VOLUME-ONLY STAND-IN FOR THE VERSION STREAM (design 059, 02-session-show-state §3.3 and §7; song volume 2026-11-09,
 * docs/SONG_VOLUME.md). While 联动台播放 holds a song the program keeps the version it started it with and takes the
 * newer ones after 停止 (0.5.9 S7, NativeProgramService pending), so a project edit does not reach the held song. The song's own volume is the one
 * exception: whenever the window's project changes (the player-bar slider let go, undo, redo, 节目属性 歌曲音量), each
 * song whose saved volume differs from what the program last heard is sent to it with one call, `setSongVolume`. When
 * a held song takes newer versions as it plays (S10), this goes.
 *
 * `opened`: the project the program was opened with. Returns what to call with the window's project after each change.
 * A slider drag changes nothing in the project while it moves, so nothing here overrides what the drag plays.
 */
export function songVolumeSync(opened: LinkProject, send: (itemId: string, volume: number) => void): (project: LinkProject | null) => void {
  const heard = new Map(opened.rundown.map(item => [item.id, savedSongVolume(item)]));
  return project => {
    for (const item of project?.rundown ?? []) {
      const volume = savedSongVolume(item);
      if (heard.get(item.id) === volume) continue;
      heard.set(item.id, volume); send(item.id, volume);
    }
  };
}
