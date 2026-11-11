import { savedSongVolume } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

/**
 * VOLUME-ONLY STAND-IN FOR THE VERSION STREAM (design 059, 02-session-show-state §3.3 and §7; song volume 2026-11-09,
 * docs/SONG_VOLUME.md). While 联动台播放 holds a song the program plays the project as it was when it opened
 * (LinkApp keeps `playbackProject` until 停止), so a project edit does not reach it. The song's own volume is the one
 * exception: whenever the window's project changes (the player-bar slider let go, undo, redo, 节目属性 歌曲音量), each
 * song whose saved volume differs from what the program last heard is sent to it with one call, `setSongVolume`. When
 * the version stream lands it carries the whole project to the program and this goes.
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
