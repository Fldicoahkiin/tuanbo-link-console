import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
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
};

export class LinkRunLogger {
  readonly sessionId = crypto.randomUUID();
  private readonly filePath: string;

  constructor(
    private readonly logsDirectory: string,
    private readonly secretValues: () => readonly string[] = () => []
  ) {
    this.filePath = join(logsDirectory, `${this.sessionId}.jsonl`);
  }

  async record(entry: Omit<LinkLogEntry, 'id' | 'sessionId' | 'timestamp' | 'monotonicMs'>): Promise<LinkLogEntry> {
    const sanitized = redactValue({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      monotonicMs: performance.now(),
      ...entry
    }, this.secretValues());
    if (!isLinkLogEntry(sanitized)) throw new Error('日志条目在脱敏后结构无效');
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8', flag: 'a' });
    return sanitized;
  }

  async query(filter: LinkLogFilter = {}): Promise<LinkLogEntry[]> {
    return this.readAllDiskEntries(filter);
  }

  async exportDiagnosticPackage(
    destinationPath: string,
    context: Readonly<Record<string, unknown>>
  ): Promise<void> {
    if (!destinationPath.toLowerCase().endsWith('.tbdiag.gz')) throw new Error('诊断包必须使用 .tbdiag.gz 扩展名');
    const diskEntries = await this.readAllDiskEntries();
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
      }
    }
    return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
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
          const value: unknown = JSON.parse(line);
          if (!isLinkLogEntry(value)) throw new Error('日志条目结构无效');
          yield value;
        } catch (error) {
          throw new Error(`${filePath} 第 ${index} 行损坏`, { cause: error });
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
