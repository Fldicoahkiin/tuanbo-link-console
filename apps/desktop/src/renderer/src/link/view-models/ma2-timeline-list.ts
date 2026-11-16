import type { LinkProject } from '@tb/schema';
import { ma2ShowStartTicks, programTimeOrigin } from '@tb/core/link';
export type Ma2TimelineRow = { target: number; name: string; startMs: number | null; count: number; owner: string | null; pending: boolean; error: string | null; loaded: boolean };
export function ma2TimelineRows(project: LinkProject): Ma2TimelineRow[] {
  const catalog = project.ma2ReadState?.catalog;
  const rows = new Map<number, Ma2TimelineRow>();
  for (const directory of catalog?.directory.entries ?? []) rows.set(directory.target, { target: directory.target, name: directory.name ?? '', startMs: null, count: 0, owner: null, pending: false, error: null, loaded: false });
  for (const entry of catalog?.entries ?? []) {
    const ticks = ma2ShowStartTicks(entry);
    rows.set(entry.target, { target: entry.target, name: entry.name, startMs: ticks === null ? null : Math.ceil(ticks * 1000 / 30), count: entry.eventCount ?? 0, owner: null, pending: false, error: entry.error ?? entry.conversionError ?? null, loaded: Boolean(entry.preview) });
  }
  for (const item of project.rundown) {
    for (const binding of item.lighting?.ma2Bindings ?? []) {
      const row = rows.get(binding.timecode);
      rows.set(binding.timecode, { target: binding.timecode, name: row?.name ?? binding.name, startMs: row?.startMs ?? binding.timeOriginMs ?? 0, count: row?.count ?? binding.mappings.length, owner: item.id, pending: false, error: row?.error ?? null, loaded: true });
    }
    const lighting = item.lighting; const own = lighting?.consoleSong; const planned = lighting?.timelineDestination;
    const target = own?.timecode?.number ?? planned?.timecode;
    if (!lighting || !target) continue;
    rows.set(target, { target, name: own?.name ?? planned!.name, startMs: programTimeOrigin(item), count: lighting.tracks.reduce((n, track) => n + track.clips.reduce((sum, clip) => sum + clip.events.length, 0), 0), owner: item.id, pending: !own?.timecode, error: null, loaded: true });
  }
  for (const failure of project.ma2ReadState?.failures ?? []) { const row = rows.get(failure.target); if (row) row.error = failure.message; }
  return [...rows.values()].sort((a, b) => a.target - b.target);
}
