import { playlistItems, type InternalPlayerState } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';

/*
 * What the play buttons do with 联动台播放. Space presses the play button of the page on screen (0.5.9,
 * playback-keys.ts), so the key and the button cannot pick different songs: the home page plays the song on its
 * button, the editor and the lighting workbench play the song open in them from the playhead.
 */

type Status = InternalPlayerState['status'];

/** The home player's play button (2026-10-30 player). */
export type HomePlayButton = {
  /** The songs of the player's playlist that can play. */
  items: RundownItem[];
  /** The song shown: the one playing or paused, otherwise the one chosen in the program list. */
  selected: RundownItem | undefined;
  /** The song the button plays when stopped. */
  target: RundownItem | undefined;
  /** Why the button cannot be pressed now, or null. */
  unavailable: string | null;
};

export function homePlayButton(project: LinkProject | null, state: Pick<InternalPlayerState, 'status' | 'itemId' | 'playlistId'>,
  selectedItem: RundownItem | null | undefined, ready: boolean): HomePlayButton {
  const items = project ? playlistItems(project, state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio) : [];
  const active = state.status === 'playing' || state.status === 'paused';
  const selected = active ? project?.rundown.find(item => item.id === state.itemId) : selectedItem ?? items.find(item => item.id === state.itemId);
  const target = selected?.enabled && selected.referenceAudio ? selected : items[0];
  const unavailable = !ready ? '播放器还没准备好' : state.status === 'preparing' ? '正在准备音频，点“停止”可以取消'
    : !active && !target ? '当前节目和播放列表里没有可以播放的音频' : null;
  return { items, selected, target, unavailable };
}

/** Pressing the home button: pause while playing, go on while paused, otherwise play the song on the button. Nothing
 * while it cannot be pressed, such as while a song is being prepared. */
export function homePlayPress(button: Pick<HomePlayButton, 'target' | 'unavailable'>, status: Status): { kind: 'pause' } | { kind: 'resume' } | { kind: 'play'; itemId: string } | null {
  if (button.unavailable !== null) return null;
  if (status === 'playing') return { kind: 'pause' };
  if (status === 'paused') return { kind: 'resume' };
  return button.target ? { kind: 'play', itemId: button.target.id } : null;
}

/**
 * The editor's and the lighting workbench's play button: `play` says whether to play or pause, `active` whether the
 * show is on this song. Pausing pauses only this song; playing goes on after a pause, or plays this song from the
 * playhead, never before its start. Nothing while the show is being prepared: pressing again would start the
 * preparation over.
 */
export function editorPlayRequest(play: boolean, status: Status, active: boolean, startMs: number, playheadMs: number): { kind: 'pause' } | { kind: 'resume' } | { kind: 'play'; positionMs: number } | null {
  if (!play) return active && status === 'playing' ? { kind: 'pause' } : null;
  if (status === 'preparing') return null;
  if (active && status === 'paused') return { kind: 'resume' };
  return { kind: 'play', positionMs: Math.max(startMs, playheadMs) };
}
