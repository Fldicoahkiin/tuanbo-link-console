import type { LinkWaveformResult } from '@tb/schema';
import { waveformBytes } from '../view-models/waveform-draw';

type Source = { projectPath: string; url: string; sha256: string; durationMs: number };
type Entry = { users: number; bytes: number; result: Promise<LinkWaveformResult>; settled: Promise<LinkWaveformResult> | null; url: string; failed: boolean };
export type WaveformLease = {
  /** What the cache holds now; an old cache that was saved before its file was checked comes back `unverified`. */
  result: Promise<LinkWaveformResult>;
  /** The final peaks: for an `unverified` result the one rebuild from this song's file, shared by every page. */
  settled: () => Promise<LinkWaveformResult>;
  release: () => void;
};

const EMPTY: LinkWaveformResult = { state: 'verified', waveform: { sampleRate: 48_000, sampleCount: 1, levels: [], spectrum: null } };

/** Shared by the home player, the editor and the lighting workbench. Re-entering a page must not copy the
 * same levels and spectrum across the desktop bridge again. Live users pin their entry. */
export class WaveformCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly generate: (request: Source & { rebuild: boolean }) => Promise<LinkWaveformResult>,
    private readonly maximumBytes = 32 * 1024 * 1024, private readonly maximumEntries = 16) {}
  acquire(source: Source): WaveformLease {
    const key = JSON.stringify([source.projectPath, source.sha256, source.durationMs]);
    let entry = this.entries.get(key);
    // A failure stays for its own link, so more mounts never retry it. A newly issued link (the song or
    // project opened again) asks once more: 2026-11-09 a stale link kept the waveform failed until a restart.
    if (!entry || entry.failed && entry.url !== source.url) {
      const created: Entry = { users: 0, bytes: 0, result: Promise.resolve(EMPTY), settled: null, url: source.url, failed: false };
      created.result = this.request(created, source, false);
      entry = created;
    }
    this.entries.delete(key); this.entries.set(key, entry); entry.users++;
    const leased = entry;
    let released = false;
    return {
      result: leased.result,
      settled: () => leased.settled ??= leased.result.then(first => first.state === 'unverified' ? this.request(leased, source, true) : first),
      release: () => { if (released) return; released = true; leased.users--; this.evict(); }
    };
  }
  private request(entry: Entry, source: Source, rebuild: boolean): Promise<LinkWaveformResult> {
    return this.generate({ ...source, rebuild }).then(value => { entry.bytes = waveformBytes(value.waveform); this.evict(); return value; },
      (error: unknown) => { entry.failed = true; throw error; });
  }
  private evict(): void {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bytes;
    for (const [key, entry] of this.entries) {
      if (bytes <= this.maximumBytes && this.entries.size <= this.maximumEntries) break;
      if (entry.users > 0) continue;
      this.entries.delete(key); bytes -= entry.bytes;
    }
  }
}
