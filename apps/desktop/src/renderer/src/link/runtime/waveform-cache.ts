type Source = { projectPath: string; url: string; sha256: string; durationMs: number };
type Entry = { users: number; bytes: number; result: Promise<number[]>; url: string; failed: boolean };

/** Shared by the player and editor. Re-entering a page must not copy the same
 * 500,000 samples across the desktop bridge again. Live users pin their entry. */
export class WaveformCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly generate: (source: Source) => Promise<number[]>,
    private readonly maximumBytes = 32 * 1024 * 1024, private readonly maximumEntries = 16) {}
  acquire(source: Source): { result: Promise<number[]>; release: () => void } {
    const key = JSON.stringify([source.projectPath, source.sha256, source.durationMs]);
    let entry = this.entries.get(key);
    // A failure stays for its own link, so more mounts never retry it. A newly issued link (the song or
    // project opened again) asks once more: 2026-11-09 a stale link kept the waveform failed until a restart.
    if (!entry || entry.failed && entry.url !== source.url) {
      entry = { users: 0, bytes: 0, result: Promise.resolve([]), url: source.url, failed: false };
      const created = entry;
      entry.result = this.generate(source).then(peaks => { created.bytes = peaks.length * 8; this.evict(); return peaks; },
        (error: unknown) => { created.failed = true; throw error; });
    }
    this.entries.delete(key); this.entries.set(key, entry); entry.users++;
    let released = false;
    return { result: entry.result, release: () => { if (released) return; released = true; entry.users--; this.evict(); } };
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
