import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { writeFileAtomically } from './atomic-file';

const gzipAsync = promisify(gzip);
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

export type LinkLogFilter = {
  sessionId?: string;
  itemId?: string;
  cueId?: string;
  device?: string;
  result?: LinkLogEntry['result'];
  limit?: number;
};

export class LinkRunLogger {
  readonly sessionId = crypto.randomUUID();
  private readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();
  private bufferedCount = 0;
  private bufferedBytes = 0;
  private bufferedFailure: Error | null = null;
  private readonly failedBuffered: LinkLogEntry[] = [];

  constructor(
    private readonly logsDirectory: string,
    private readonly secretValues: () => readonly string[] = () => []
  ) {
    this.filePath = join(logsDirectory, `${this.sessionId}.jsonl`);
  }

  async record(entry: Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>): Promise<LinkLogEntry> {
    const sanitized = this.createEntry(entry);
    await this.persist(sanitized);
    return sanitized;
  }

  /** Admission only, never a durable-write acknowledgement. Formal output must
   * not await filesystem latency. Query/export and flush wait for persistence. */
  recordBuffered(entry: Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>,
    onFailure: (error: Error) => void): Promise<LinkLogEntry> {
    if (this.bufferedFailure) return Promise.reject(this.bufferedFailure);
    const sanitized = this.createEntry(entry), bytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
    if (this.bufferedCount >= 512 || this.bufferedBytes + bytes > 4 * 1024 * 1024) return Promise.reject(new Error('正式输出日志待写队列已满；本条未接收'));
    this.bufferedCount++; this.bufferedBytes += bytes;
    void this.persist(sanitized).then(() => {
      this.bufferedCount--; this.bufferedBytes -= bytes;
    }, (error: unknown) => {
      // Retain failed evidence for export; stop accepting more rather than
      // growing memory or retrying an uncertain disk write indefinitely.
      this.failedBuffered.push({ ...sanitized, details: { ...sanitized.details, persistence: 'failed' } });
      this.bufferedCount--; this.bufferedBytes -= bytes;
      if (!this.bufferedFailure) {
        this.bufferedFailure = new Error(`运行日志未能落盘：${error instanceof Error ? error.message : String(error)}`);
        onFailure(this.bufferedFailure);
      }
    });
    return Promise.resolve(sanitized);
  }

  async flush(): Promise<void> {
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

  async query(filter: LinkLogFilter = {}): Promise<LinkLogEntry[]> {
    await this.pending;
    const entries = await this.readAllDiskEntries(filter);
    for (const entry of this.failedBuffered) {
      if (filter.sessionId && entry.sessionId !== filter.sessionId || filter.itemId && entry.itemId !== filter.itemId
        || filter.cueId && entry.cueId !== filter.cueId || filter.device && entry.device !== filter.device
        || filter.result && entry.result !== filter.result) continue;
      entries.push(structuredClone(entry));
    }
    entries.sort(chronological);
    return filter.limit ? entries.slice(-filter.limit) : entries;
  }

  /** `build` names the exporting build (product, version, channel, commit, appId) above the entries. */
  async exportText(destinationPath: string, build: string): Promise<void> {
    if (!destinationPath.toLowerCase().endsWith('.txt')) throw new Error('运行日志必须使用 .txt 扩展名');
    const entries = await this.query();
    const text = entries.map(entry => `${entry.timestamp} [${entry.level}] [${entry.category}] [${entry.device ?? '—'}] ${entry.message}\n${JSON.stringify(entry)}`).join('\n\n');
    await writeFileAtomically(destinationPath, `团播联动台运行日志（包含历史会话）\n导出版本：${build}\n${text}\n`);
  }

  async exportDiagnosticPackage(
    destinationPath: string,
    context: Readonly<Record<string, unknown>>
  ): Promise<void> {
    if (!destinationPath.toLowerCase().endsWith('.tbdiag.gz')) throw new Error('诊断包必须使用 .tbdiag.gz 扩展名');
    const diskEntries = await this.query();
    const payload = redactValue({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      context,
      logs: diskEntries
    }, this.secretValues());
    await writeFileAtomically(destinationPath, await gzipAsync(Buffer.from(JSON.stringify(payload, null, 2), 'utf8')));
  }

  private async readAllDiskEntries(filter: LinkLogFilter = {}): Promise<LinkLogEntry[]> {
    let fileNames: string[];
    try {
      fileNames = (await readdir(this.logsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) return [];
      throw error;
    }
    const entries: LinkLogEntry[] = [];
    for (const fileName of fileNames) {
      for await (const entry of this.readDiskEntries(join(this.logsDirectory, fileName))) {
        if (filter.sessionId && entry.sessionId !== filter.sessionId) continue;
        if (filter.itemId && entry.itemId !== filter.itemId) continue;
        if (filter.cueId && entry.cueId !== filter.cueId) continue;
        if (filter.device && entry.device !== filter.device) continue;
        if (filter.result && entry.result !== filter.result) continue;
        entries.push(entry);
        if (filter.limit && entries.length >= filter.limit * 2) {
          entries.sort((a, b) => chronological(b, a));
          entries.length = filter.limit;
        }
      }
    }
    entries.sort(chronological);
    return filter.limit ? entries.slice(-filter.limit) : entries;
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
            message: `${basename(filePath)} 第 ${index} 行损坏；已保留原文件并继续读取其他日志`,
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
