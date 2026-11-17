import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const requests = z.array(z.string().regex(/^[a-f0-9]{32}$/));
/** Persist ownership before begin: a process exit or lost ACK must not strand the console slot. */
export class Ma2RequestJournal {
  private ids: Set<string>;
  constructor(private readonly path: string) {
    try { this.ids = new Set(requests.parse(JSON.parse(readFileSync(path, 'utf8')))); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      this.ids = new Set();
    }
  }
  pending(): string[] { return [...this.ids]; }
  begin(id: string): void { this.save(new Set([...this.ids, id])); }
  released(id: string): void { const next = new Set(this.ids); next.delete(id); this.save(next); }
  private save(ids: Set<string>): void {
    const data = JSON.stringify(requests.parse([...ids]));
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, data, 'utf8');
    renameSync(temporary, this.path);
    this.ids = ids;
  }
}
