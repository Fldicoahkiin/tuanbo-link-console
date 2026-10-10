export type CueMarkerPosition = { id: string; cue: string; ms: number };
export type CueMarkerPlacement = { id: string; left: number; width: number; row: number };
export function displayCueNumber(cue: string): string {
  return cue.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
export const cueMarkerWidth = (cue: string): number => Math.max(44, Math.ceil(displayCueNumber(cue).length * 8) + 20);

/** Each Cue keeps its exact time; overlapping labels use separate rows. */
export function layoutCueMarkers(entries: readonly CueMarkerPosition[], pixelsPerSecond: number): CueMarkerPlacement[] {
  const rows: number[] = [];
  return [...entries].sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id)).map(entry => {
    const left = entry.ms / 1000 * pixelsPerSecond;
    const width = cueMarkerWidth(entry.cue);
    const available = rows.findIndex(right => right + 6 <= left);
    const row = available < 0 ? rows.length : available;
    rows[row] = left + width;
    return { id: entry.id, left, width, row };
  });
}
