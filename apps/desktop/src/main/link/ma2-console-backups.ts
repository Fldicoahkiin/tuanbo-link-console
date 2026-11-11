import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { writeFileAtomically } from './atomic-file';
import type { ShowGateReader } from '@tb/core/link';

const KEEP_PER_OBJECT = 10;
const fileSchema = z.string().regex(/^tblink_(?:backup|label|library)_[a-f0-9]{32}$/);
const ledgerSchema = z.object({ version: z.literal(1), entries: z.array(z.object({
  console: z.string().min(1), object: z.string().min(1), file: fileSchema, recordedAt: z.iso.datetime()
}).strict()) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;

/**
 * Write-before backups this program left in the console's importexport folder. Only files recorded
 * here are ever removed, newest ten kept per console object (Timecode N, Sequence N); older files,
 * files from other computers and anything written before this ledger existed stay untouched.
 */
export class Ma2ConsoleBackups {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly show: ShowGateReader, private readonly report: (message: string) => Promise<unknown>) {}

  /**
   * Records backups the console now holds and removes the object's oldest recorded ones beyond ten.
   * The write that made them already succeeded, so a failure here is reported instead of thrown:
   * the files stay listed and are removed after a later write. Nothing is removed while the program moves (paused it is,
   * 第 3 题: removing old backups is changing the console like an executor).
   */
  record(bridge: Pick<Ma2OnpcBridge, 'request'>, backup: { console: string; object: string; files: readonly string[] }): Promise<void> {
    const run = this.queue.then(async () => {
      try {
        const files = backup.files.map(file => fileSchema.parse(file.replace(/\.xml$/, '')));
        const ledger = await this.read();
        const recordedAt = new Date().toISOString();
        for (const file of files) if (!ledger.entries.some(entry => entry.file === file)) ledger.entries.push({ console: backup.console, object: backup.object, file, recordedAt });
        await writeFileAtomically(this.path, JSON.stringify(ledger, null, 2));
        if (this.show('ma2.executor.mutate').kind === 'wait') return;
        const own = ledger.entries.filter(entry => entry.console === backup.console && entry.object === backup.object);
        const expired = own.slice(0, Math.max(0, own.length - KEEP_PER_OBJECT)).map(entry => entry.file);
        if (!expired.length) return;
        // DISCARD answers with the files now gone; any other file stays listed for the next write.
        const gone = new Set((await bridge.request('DISCARD', 1, expired.join(','))).split(',').filter(Boolean));
        await writeFileAtomically(this.path, JSON.stringify({ ...ledger, entries: ledger.entries.filter(entry => !gone.has(entry.file)) }, null, 2));
        const kept = expired.filter(file => !gone.has(file));
        if (kept.length) await this.report(`控台旧备份未能全部清理（${backup.object}）：${kept.join('、')} 仍保留，下次写入后再试`);
      } catch (cause) {
        await this.report(`控台旧备份清理未完成（${backup.object}）：${cause instanceof Error ? cause.message : String(cause)}；备份文件均已保留`);
      }
    });
    this.queue = run;
    return run;
  }

  private async read(): Promise<Ledger> {
    try { return ledgerSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, entries: [] }; throw new Error(`控台备份记录无法读取：${this.path}`, { cause: error }); }
  }
}
