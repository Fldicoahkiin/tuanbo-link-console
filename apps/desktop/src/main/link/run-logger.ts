import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { writeChunksAtomically } from './atomic-file';
import { LogRepeats } from './log-repeats';

const SENSITIVE_KEY = /password|credential|authorization|token|secret/i;

export type LinkLogLevel = 'info' | 'warning' | 'error';
export type LinkLogCategory = 'state' | 'action' | 'device' | 'preflight' | 'operator' | 'system';

export type LinkLogEntry = {
  id: string;
  sessionId: string;
  timestamp: string;
  monotonicMs: number;
  level: LinkLogLevel;
  category: LinkLogCategory;
  message: string;
  projectId?: string;
  itemId?: string;
  cueId?: string;
  actionId?: string;
  executionId?: string;
  device?: string;
  result?: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  details?: Readonly<Record<string, unknown>>;
};

export type LinkLogInput = Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>;

export type LinkLogFilter = {
  sessionId?: string;
  itemId?: string;
  cueId?: string;
  device?: string;
  result?: LinkLogEntry['result'];
  limit?: number;
};

export type LogExportRange = { days: 1 | 7 | 30 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** What one log query may read: the newest 500 entries, from at most the newest 20 sessions or 64 MB of files. */
export const LOG_QUERY_SCOPE = { entries: 500, sessions: 20, bytes: 64 * 1024 * 1024 } as const;

export type PrunedSessionLog = { file: string; bytes: number; reason: 'expired' | 'over-size' };
/** Session logs older than 30 days go, and the rest keep within 200 MB; the stricter of the two wins. */
export const LOG_RETENTION = { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxBytes: 200 * 1024 * 1024 } as const;

export class LinkRunLogger {
  readonly sessionId = crypto.randomUUID();
  private readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();
  private bufferedCount = 0;
  private bufferedBytes = 0;
  private bufferedFailure: Error | null = null;
  private readonly failedBuffered: LinkLogEntry[] = [];
  private readonly repeats = new LogRepeats<LinkLogInput>();
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly logsDirectory: string,
    private readonly secretValues: () => readonly string[] = () => [],
    private readonly clock: () => number = Date.now
  ) {
    this.filePath = join(logsDirectory, `${this.sessionId}.jsonl`);
  }

  /** Writes the entry, unless it repeats one already written three times this window (see LogRepeats): it is
   * then counted into a summary entry and the returned entry is not on disk. */
  async record(entry: LinkLogInput): Promise<LinkLogEntry> {
    const now = this.clock();
    await this.writeSummaries(this.repeats.settle(now));
    const sanitized = this.createEntry(entry);
    if (this.repeats.admit(entry, now) === 'merge') { this.scheduleSummaries(); return sanitized; }
    await this.persist(sanitized);
    return sanitized;
  }

  /** Writes every summary still owed now, so a query, an export or quitting sees the merged counts. */
  async settleRepeats(): Promise<void> {
    await this.writeSummaries(this.repeats.settle(this.clock(), true));
  }

  private async writeSummaries(summaries: readonly LinkLogInput[]): Promise<void> {
    for (const summary of summaries) await this.persist(this.createEntry(summary));
  }

  private scheduleSummaries(): void {
    if (this.repeatTimer) return;
    const due = this.repeats.nextDue();
    if (due === null) return;
    this.repeatTimer = setTimeout(() => {
      this.repeatTimer = null;
      void this.writeSummaries(this.repeats.settle(this.clock())).then(() => this.scheduleSummaries(),
        (error: unknown) => console.error('合并的重复日志未能写入', error));
    }, Math.max(0, due - this.clock()) + 50);
    this.repeatTimer.unref?.();
  }

  /** Admission only, never a durable-write acknowledgement. Formal output must
   * not await filesystem latency. Query/export and flush wait for persistence. */
  recordBuffered(entry: Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>,
    onFailure: (error: Error) => void): Promise<LinkLogEntry> {
    if (this.bufferedFailure) return Promise.reject(this.bufferedFailure);
    const sanitized = this.createEntry(entry), bytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
    if (this.bufferedCount >= 512 || this.bufferedBytes + bytes > 4 * 1024 * 1024) return Promise.reject(new Error('日志写入排队已满，这条没有记录'));
    this.bufferedCount++; this.bufferedBytes += bytes;
    void this.persist(sanitized).then(() => {
      this.bufferedCount--; this.bufferedBytes -= bytes;
    }, (error: unknown) => {
      // Retain failed evidence for export; stop accepting more rather than
      // growing memory or retrying an uncertain disk write indefinitely.
      this.failedBuffered.push({ ...sanitized, details: { ...sanitized.details, persistence: 'failed' } });
      this.bufferedCount--; this.bufferedBytes -= bytes;
      if (!this.bufferedFailure) {
        this.bufferedFailure = new Error(`运行日志写入失败：${error instanceof Error ? error.message : String(error)}`);
        onFailure(this.bufferedFailure);
      }
    });
    return Promise.resolve(sanitized);
  }

  async flush(): Promise<void> {
    await this.settleRepeats();
    await this.pending;
    if (this.bufferedFailure) throw this.bufferedFailure;
  }

  private createEntry(entry: Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>): LinkLogEntry {
    const sanitized = redactValue({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      monotonicMs: performance.now(),
      ...entry
    }, this.secretValues());
    if (!isLinkLogEntry(sanitized)) throw new Error('日志条目在脱敏后结构无效');
    return sanitized;
  }

  private persist(sanitized: LinkLogEntry): Promise<void> {
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8', flag: 'a' });
    });
    // Each caller receives its write error; the queue permits a later explicit write.
    this.pending = write.then(() => undefined, () => undefined);
    return write;
  }

  /**
   * Moves earlier sessions' logs out through `trash` (the system recycle bin), oldest first: every session
   * last written more than `maxAgeMs` ago, then more until all logs fit in `maxBytes`. This session's own
   * file always stays. Sessions never overlap (single instance), so the last write orders them.
   */
  async pruneSessions(trash: (path: string) => Promise<void>, limits: { maxAgeMs: number; maxBytes: number } = LOG_RETENTION, now = Date.now()): Promise<PrunedSessionLog[]> {
    const sessions = await this.sessionFiles();
    let total = sessions.reduce((sum, file) => sum + file.bytes, 0);
    const pruned: PrunedSessionLog[] = [];
    for (const file of [...sessions].reverse()) {
      if (file.path === this.filePath) continue;
      const reason = now - file.mtimeMs > limits.maxAgeMs ? 'expired' : total > limits.maxBytes ? 'over-size' : null;
      if (!reason) continue;
      await trash(file.path);
      total -= file.bytes;
      pruned.push({ file: file.path, bytes: file.bytes, reason });
    }
    return pruned;
  }

  /** Session log files, newest first by last write. */
  private async sessionFiles(): Promise<{ path: string; bytes: number; mtimeMs: number }[]> {
    let names: string[];
    try {
      names = (await readdir(this.logsDirectory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name);
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) return [];
      throw error;
    }
    const files = [];
    for (const name of names) {
      const path = join(this.logsDirectory, name);
      try { const info = await stat(path); files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs }); }
      catch (error) { if (!isErrorWithCode(error, 'ENOENT')) throw error; }
    }
    return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  /**
   * The newest `limit` matching entries (500 by default). Sessions are read newest first, each kept only as
   * the tail still needed, and reading stops once enough are found or after the newest 20 sessions / 64 MB,
   * so a long history never loads into the main process.
   */
  async query(filter: LinkLogFilter = {}): Promise<LinkLogEntry[]> {
    await this.settleRepeats();
    await this.pending;
    const limit = filter.limit ?? LOG_QUERY_SCOPE.entries;
    const files = (await this.sessionFiles()).filter(file => !filter.sessionId || basename(file.path) === `${filter.sessionId}.jsonl`);
    const found: LinkLogEntry[][] = [];
    let count = 0, sessions = 0, bytes = 0;
    for (const file of files) {
      if (count >= limit || sessions >= LOG_QUERY_SCOPE.sessions || bytes >= LOG_QUERY_SCOPE.bytes) break;
      sessions++; bytes += file.bytes;
      const tail = new Tail<LinkLogEntry>(limit - count);
      for await (const entry of this.readDiskEntries(file.path)) if (matches(entry, filter)) tail.push(entry);
      const kept = tail.items();
      found.push(kept); count += kept.length;
    }
    const entries = found.reverse().flat();
    for (const entry of this.failedBuffered) if (matches(entry, filter)) entries.push(structuredClone(entry));
    entries.sort(chronological);
    return entries.slice(-limit);
  }

  /** `build` names the exporting build (product, version, channel, commit, appId) above the entries. */
  async exportText(destinationPath: string, build: string, range: LogExportRange = { days: 7 }): Promise<void> {
    if (!destinationPath.toLowerCase().endsWith('.txt')) throw new Error('运行日志必须使用 .txt 扩展名');
    const entries = this.entriesSince(Date.now() - range.days * DAY_MS);
    await writeChunksAtomically(destinationPath, (async function* () {
      yield `团播联动台运行日志（最近 ${range.days} 天）\n导出版本：${build}\n`;
      for await (const entry of entries) yield `${entry.timestamp} [${entry.level}] [${entry.category}] [${entry.device ?? '—'}] ${entry.message}\n${JSON.stringify(entry)}\n\n`;
    })());
  }

  async exportDiagnosticPackage(destinationPath: string, context: Readonly<Record<string, unknown>>, range: LogExportRange = { days: 7 }): Promise<void> {
    if (!destinationPath.toLowerCase().endsWith('.tbdiag.gz')) throw new Error('诊断包必须使用 .tbdiag.gz 扩展名');
    const head = { schemaVersion: 1, exportedAt: new Date().toISOString(), sessionId: this.sessionId, range, context: redactValue(context, this.secretValues()) };
    const entries = this.entriesSince(Date.now() - range.days * DAY_MS);
    await writeChunksAtomically(destinationPath, (async function* () {
      yield `${JSON.stringify(head).slice(0, -1)},"logs":[`;
      let first = true;
      for await (const entry of entries) { yield `${first ? '' : ','}\n${JSON.stringify(entry)}`; first = false; }
      yield '\n]}\n';
    })(), { gzip: true });
  }

  /** Every entry written at or after `from`, oldest first, one session file at a time. */
  private async *entriesSince(from: number): AsyncGenerator<LinkLogEntry> {
    await this.settleRepeats();
    await this.pending;
    const since = new Date(from).toISOString();
    for (const file of (await this.sessionFiles()).filter(file => file.mtimeMs >= from).reverse()) {
      for await (const entry of this.readDiskEntries(file.path)) if (entry.timestamp >= since) yield entry;
    }
    // Disk entries are redacted as they are read; these were redacted when written, so again with today's secrets.
    for (const entry of this.failedBuffered) {
      if (entry.timestamp < since) continue;
      const redacted = redactValue(entry, this.secretValues());
      if (!isLinkLogEntry(redacted)) throw new Error('日志条目在脱敏后结构无效');
      yield redacted;
    }
  }

  private async *readDiskEntries(filePath: string): AsyncGenerator<LinkLogEntry> {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0;
    try {
      for await (const line of lines) {
        index++;
        if (!line) continue;
        try {
          const value: unknown = redactValue(JSON.parse(line), this.secretValues());
          if (!isLinkLogEntry(value)) throw new Error('日志条目结构无效');
          yield value;
        } catch (error) {
          // A crash can leave an incomplete final line. Keep other evidence exportable.
          yield { id: `damaged-${basename(filePath)}-${index}`, sessionId: basename(filePath, '.jsonl'),
            timestamp: new Date().toISOString(), monotonicMs: 0, level: 'error', category: 'system',
            message: `${basename(filePath)} 第 ${index} 行已损坏，原文件保留，继续读取其他日志`,
            details: { file: basename(filePath), line: index, reason: error instanceof SyntaxError ? 'JSON 不完整或格式错误' : '日志条目结构无效' } };
        }
      }
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) return;
      throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}

function matches(entry: LinkLogEntry, filter: LinkLogFilter): boolean {
  return !(filter.sessionId && entry.sessionId !== filter.sessionId || filter.itemId && entry.itemId !== filter.itemId
    || filter.cueId && entry.cueId !== filter.cueId || filter.device && entry.device !== filter.device
    || filter.result && entry.result !== filter.result);
}

/** The last `capacity` items pushed, oldest first. */
class Tail<T> {
  private readonly buffer: T[] = [];
  private next = 0;
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    if (this.capacity <= 0) return;
    if (this.buffer.length < this.capacity) this.buffer.push(item);
    else this.buffer[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
  }
  items(): T[] {
    return this.buffer.length < this.capacity ? [...this.buffer] : [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)];
  }
}

function chronological(left: LinkLogEntry, right: LinkLogEntry): number {
  return left.timestamp.localeCompare(right.timestamp) || left.monotonicMs - right.monotonicMs;
}

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  const effectiveSecrets = secrets.filter((secret) => secret.length > 0);
  if (typeof value === 'string') {
    return effectiveSecrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, effectiveSecrets));
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, effectiveSecrets);
  }
  return result;
}

function isLinkLogEntry(value: unknown): value is LinkLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  return hasString(value, 'id')
    && hasString(value, 'sessionId')
    && hasString(value, 'timestamp')
    && hasNumber(value, 'monotonicMs')
    && hasString(value, 'level')
    && hasString(value, 'category')
    && hasString(value, 'message');
}

function hasString(value: object, property: string): boolean {
  return typeof Object.getOwnPropertyDescriptor(value, property)?.value === 'string';
}

function hasNumber(value: object, property: string): boolean {
  return typeof Object.getOwnPropertyDescriptor(value, property)?.value === 'number';
}

function isErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}
