import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
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
    const entries = await this.readAllDiskEntries();
    return entries.filter((entry) => {
      if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
      if (filter.itemId && entry.itemId !== filter.itemId) return false;
      if (filter.cueId && entry.cueId !== filter.cueId) return false;
      if (filter.device && entry.device !== filter.device) return false;
      if (filter.result && entry.result !== filter.result) return false;
      return true;
    }).map((entry) => structuredClone(entry));
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

  private async readAllDiskEntries(): Promise<LinkLogEntry[]> {
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
      entries.push(...await this.readDiskEntries(join(this.logsDirectory, fileName)));
    }
    return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  private async readDiskEntries(filePath: string): Promise<LinkLogEntry[]> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) return [];
      throw error;
    }
    return content.split(/\r?\n/).filter(Boolean).map((line, index): LinkLogEntry => {
      try {
        const value: unknown = JSON.parse(line);
        if (!isLinkLogEntry(value)) throw new Error('日志条目结构无效');
        return value;
      } catch (error) {
        throw new Error(`${filePath} 第 ${index + 1} 行损坏`, { cause: error });
      }
    });
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
