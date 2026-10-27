type Contents = {
  lighting?: { tracks: ReadonlyArray<{ clips: ReadonlyArray<{ events: readonly unknown[] }> }> } | undefined;
  cues: readonly unknown[];
  referenceMediaClips: readonly unknown[];
};

/** What a program holds, by kind: lighting points, OBS/MIDI actions and media clips; empty kinds are left out. */
export function programContents(item: Contents): string {
  const lights = item.lighting?.tracks.reduce((total, track) => total + track.clips.reduce((sum, clip) => sum + clip.events.length, 0), 0) ?? 0;
  const parts = [lights ? `${lights} 个灯光点` : '', item.cues.length ? `${item.cues.length} 个动作` : '', item.referenceMediaClips.length ? `${item.referenceMediaClips.length} 个素材` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '还没有编排';
}
