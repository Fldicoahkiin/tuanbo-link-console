import { mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const requestId = z.string().regex(/^[a-f0-9]{32}$/);
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function processHasExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false;
    throw error;
  }
}

/** The marker records the request ID and the owner's PID in a single filesystem operation, before admission. */
export class Ma2RequestJournal {
  private readonly directory: string;
  private readonly abandoned = new Map<string, string>();
  constructor(path: string) {
    this.directory = `${path}.pending`;
    mkdirSync(this.directory, { recursive: true });
    // The legacy JSON belongs to older clients. It carries no process ownership
    // information and can be mid-write even when our own markers are readable.
  }

  /** Requests this process can reclaim on reconnect, or a confirmed dead process left behind. */
  pending(): string[] {
    const ids = new Set<string>(), exited = new Map<number, boolean>();
    for (const marker of readdirSync(this.directory, { withFileTypes: true })) {
      if (!marker.isDirectory()) continue;
      const entry = marker.name;
      const match = /^([a-f0-9]{32})\.([1-9]\d{0,9})$/.exec(entry);
      if (!match) continue; // Other formats have no verified ownership.
      const id = match[1]!, pid = Number(match[2]);
      if (pid > 0x7fffffff) continue; // process.kill accepts signed 32-bit PIDs.
      if (pid !== process.pid) {
        if (!exited.has(pid)) exited.set(pid, processHasExited(pid));
        if (!exited.get(pid)) continue;
        this.abandoned.set(id, entry);
      }
      ids.add(id);
    }
    return [...ids];
  }

  begin(id: string): void {
    mkdirSync(join(this.directory, `${requestId.parse(id)}.${process.pid}`), { recursive: true });
  }

  released(id: string): void {
    const marker = this.abandoned.get(id) ?? `${requestId.parse(id)}.${process.pid}`;
    try { rmdirSync(join(this.directory, marker)); }
    catch (error) { if (!missing(error)) throw error; }
    this.abandoned.delete(id);
  }
}
