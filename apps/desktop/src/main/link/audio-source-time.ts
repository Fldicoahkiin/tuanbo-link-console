/** Playback and waveform analysis share container time zero, including AAC
 * edit-list lead-in. A cold seek is absolute, not start_time + position. */
export function audioSourceInputArgs(positionMs: number): string[] {
  return ['-copyts', '-seek_timestamp', '1', '-ss', String(positionMs / 1000)];
}

export function audioSourceTimeFilter(sampleRate: number, positionMs = 0): string {
  // Reset PTS before resampling: first_pts uses the input rate, so expressing a
  // seek in output-rate samples would shift (or erase) a resampled cold seek.
  return `asetpts=PTS-${positionMs}/1000/TB,aresample=${sampleRate}:async=1:first_pts=0`;
}
