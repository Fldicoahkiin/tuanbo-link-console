export type CueMarkerPosition = { id: string; cue: string; ms: number };
export type CueMarkerGroup = { ids: string[]; left: number; right: number; width: number; row: number; clustered: boolean };
export function displayCueNumber(cue: string): string {
  return cue.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
export const cueMarkerWidth = (cue: string): number => Math.max(44, Math.ceil(displayCueNumber(cue).length * 8) + 20);

/** Display-only grouping. Original positions are never rounded or rewritten. */
export function layoutCueMarkers(entries: readonly CueMarkerPosition[], pixelsPerSecond: number): CueMarkerGroup[] {
  const groups: CueMarkerGroup[] = [];
  let component: CueMarkerPosition[] = [];
  let end = -Infinity;
  const flush = (): void => {
    const rows = [-Infinity, -Infinity];
    const placements: CueMarkerGroup[] = [];
    let crowded = false;
    for (const entry of component) {
      const left = entry.ms / 1000 * pixelsPerSecond;
      const width = cueMarkerWidth(entry.cue);
      const row = rows.findIndex(value => value + 6 <= left);
      if (row < 0) { crowded = true; break; }
      rows[row] = left + width;
      placements.push({ ids: [entry.id], left, right: left + width, width, row, clustered: false });
    }
    if (crowded) groups.push({ ids: component.map(entry => entry.id), left: component[0]!.ms / 1000 * pixelsPerSecond, right: end, width: Math.max(66, String(component.length).length * 8 + 48), row: 0, clustered: true });
    else groups.push(...placements);
    component = [];
  };
  for (const entry of [...entries].sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id))) {
    const left = entry.ms / 1000 * pixelsPerSecond;
    if (component.length && left >= end + 6) { flush(); end = -Infinity; }
    component.push(entry);
    end = Math.max(end, left + cueMarkerWidth(entry.cue), component[0]!.ms / 1000 * pixelsPerSecond + 80);
  }
  if (component.length) flush();
  return groups;
}
