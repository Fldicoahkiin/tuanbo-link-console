import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { FEEDBACK_LIMITS, feedbackReceiptSchema, feedbackSubmissionSchema, type FeedbackReceipt, type FeedbackSubmission } from '../../../packages/schema/src/feedback';
import { ServiceError } from './service';

/**
 * What the server takes from in-app problem reports. The desktop app limits itself too (one at a time, a minute
 * apart, five an hour); these hold against anyone calling the endpoint directly.
 */
export const FEEDBACK_SERVER_LIMITS = {
  perSourceHour: 6, perSourceDay: 20, perMachineDay: 10, perDay: 500,
  /** Diagnostic packages kept, counting upload slots still open. */
  storageBytes: 2 * 1024 ** 3,
  /** Left free on the disk after a package, for the database and the other services on this machine. */
  freeSpaceBytes: 1024 ** 3,
  uploadMs: 30 * 60_000, concurrentUploads: 4,
  attachmentDays: 180, recordDays: 730, pruneMs: 3_600_000, duplicateMs: 24 * 3_600_000
} as const;
export type FeedbackServerLimits = { [K in keyof typeof FEEDBACK_SERVER_LIMITS]: number };

/** Additive only: the production database may only gain tables. Not tracked in console_migrations, so older builds still start. */
export function migrateFeedback(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, created TEXT NOT NULL, source TEXT NOT NULL,
      machine_code TEXT, license_id TEXT, version TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, digest TEXT NOT NULL,
      contact TEXT NOT NULL, occurred_at TEXT NOT NULL, environment TEXT NOT NULL, attachment_limit INTEGER NOT NULL,
      declared_bytes INTEGER, declared_sha256 TEXT, upload_hash TEXT UNIQUE, upload_until TEXT,
      attachment_bytes INTEGER, attachment_at TEXT, attachment_removed TEXT, attachment_issue TEXT,
      state TEXT NOT NULL DEFAULT 'open', conclusion TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created);
    CREATE INDEX IF NOT EXISTS feedback_source ON feedback(source, created);
    CREATE INDEX IF NOT EXISTS feedback_machine ON feedback(machine_code, created);`);
}

const priorSchema = z.object({ id: z.string(), number: z.string(), attachment_at: z.string().nullable(), attachment_limit: z.number() });
const slotSchema = z.object({ declared_bytes: z.number(), declared_sha256: z.string(), upload_until: z.string() });
const NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAVE_HINT = '请用「另存为文件」导出后发给售后';

export type FeedbackOptions = {
  limits?: Partial<FeedbackServerLimits>;
  /** Free bytes on the disk holding `directory`; tests replace it. */
  freeBytes?: (directory: string) => Promise<number>;
};

/**
 * Problem reports and their diagnostic packages. Reports live in the licensing database; packages are files in
 * `directory`, named by report id. A report's sender is kept only as a keyed hash of its network address.
 */
export class FeedbackStore {
  private readonly limits: FeedbackServerLimits;
  private readonly freeBytes: (directory: string) => Promise<number>;
  private readonly uploading = new Set<string>();
  private pruned = Number.NEGATIVE_INFINITY;

  constructor(private readonly db: DatabaseSync, readonly directory: string, private readonly sourceKey: Buffer,
    private readonly license: (token: string, machineCode: string) => string | null, private readonly now: () => number, options: FeedbackOptions = {}) {
    if (sourceKey.length !== 32) throw new Error('反馈来源密钥必须为 32 字节');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.limits = { ...FEEDBACK_SERVER_LIMITS, ...options.limits };
    this.freeBytes = options.freeBytes ?? (async path => { const info = await statfs(path); return info.bavail * info.bsize; });
  }

  /** POST /v1/feedback. `source` is the sender's rate-limit bucket (IPv4 address or IPv6 /64). */
  async submit(input: unknown, source: string): Promise<FeedbackReceipt> {
    const submission = parseSubmission(input);
    await this.prune();
    // Measured before the synchronous part, so nothing else runs between the checks and the insert.
    const free = submission.diagnostic ? await this.freeBytes(this.directory) : 0;
    const now = this.now(); const at = new Date(now).toISOString();
    const sender = createHmac('sha256', this.sourceKey).update(source).digest('hex').slice(0, 32);
    const licenseId = submission.license && submission.machineCode ? this.license(submission.license, submission.machineCode) : null;
    const limit = licenseId ? FEEDBACK_LIMITS.attachmentBytes : FEEDBACK_LIMITS.unlicensedAttachmentBytes;
    const digest = createHash('sha256').update(JSON.stringify([submission.category, submission.description.replace(/\s+/g, ' ')])).digest('hex');
    const since = (ms: number) => new Date(now - ms).toISOString();
    // A retry of a report whose answer was lost: the same number, and a new upload slot if the package never arrived.
    const priorRow = this.db.prepare('SELECT id,number,attachment_at,attachment_limit FROM feedback WHERE source=? AND machine_code IS ? AND digest=? AND created>=? ORDER BY created DESC LIMIT 1')
      .get(sender, submission.machineCode, digest, since(this.limits.duplicateMs));
    const prior = priorRow ? priorSchema.parse(priorRow) : null;
    if (!prior) this.enforceLimits(sender, submission.machineCode, since);
    let issue: string | null = null;
    if (submission.diagnostic && prior?.attachment_at) issue = '这条反馈的诊断包服务器已经收到，不用重复上传';
    else if (submission.diagnostic) issue = this.attachmentIssue(submission.diagnostic.bytes, prior ? Math.max(limit, prior.attachment_limit) : limit, Boolean(licenseId), free, at);
    const upload = submission.diagnostic && !issue ? { token: `TBF-${randomBytes(32).toString('hex').toUpperCase()}`, expiresAt: new Date(now + this.limits.uploadMs).toISOString() } : null;
    const uploadHash = upload ? sha256(upload.token) : null;
    if (prior) {
      if (upload) this.db.prepare('UPDATE feedback SET declared_bytes=?,declared_sha256=?,upload_hash=?,upload_until=?,attachment_issue=NULL WHERE id=?')
        .run(submission.diagnostic?.bytes ?? null, submission.diagnostic?.sha256 ?? null, uploadHash, upload.expiresAt, prior.id);
      return feedbackReceiptSchema.parse({ id: prior.id, number: prior.number, upload, attachmentIssue: issue });
    }
    const id = randomUUID(); const number = this.newNumber(now);
    this.db.prepare(`INSERT INTO feedback (id,number,created,source,machine_code,license_id,version,category,description,digest,contact,occurred_at,environment,
        attachment_limit,declared_bytes,declared_sha256,upload_hash,upload_until,attachment_issue,state,conclusion,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','',?)`)
      .run(id, number, at, sender, submission.machineCode, licenseId, submission.version, submission.category, submission.description, digest, submission.contact,
        submission.occurredAt, JSON.stringify(submission.environment), limit, submission.diagnostic?.bytes ?? null, submission.diagnostic?.sha256 ?? null,
        uploadHash, upload?.expiresAt ?? null, issue, at);
    return feedbackReceiptSchema.parse({ id, number, upload, attachmentIssue: issue });
  }

  /** PUT /v1/feedback/<id>/diagnostic: the package declared in the report, once, before the slot expires. */
  async upload(id: string, authorization: string | undefined, request: IncomingMessage): Promise<{ received: true; bytes: number }> {
    const token = /^Bearer (TBF-[A-F0-9]{64})$/.exec(authorization ?? '')?.[1];
    const tokenHash = token ? sha256(token) : '';
    const row = token ? this.db.prepare('SELECT declared_bytes,declared_sha256,upload_until FROM feedback WHERE id=? AND upload_hash=?').get(id, tokenHash) : undefined;
    const slot = row ? slotSchema.parse(row) : null;
    if (!slot || Date.parse(slot.upload_until) <= this.now()) throw new ServiceError(401, 'UPLOAD_UNAUTHORIZED', '上传凭据无效或已过期，请重新提交反馈');
    if (!/^application\/gzip$/i.test(request.headers['content-type'] ?? '')) throw new ServiceError(415, 'CONTENT_TYPE', '需要 application/gzip');
    if (Number(request.headers['content-length']) !== slot.declared_bytes) throw new ServiceError(400, 'UPLOAD_SIZE', '诊断包大小与提交反馈时不一致');
    if (this.uploading.has(id)) throw new ServiceError(409, 'UPLOAD_BUSY', '这条反馈的诊断包正在上传');
    if (this.uploading.size >= this.limits.concurrentUploads) throw new ServiceError(503, 'UPLOAD_BUSY', '服务器正在接收其他诊断包，请稍后再试');
    this.uploading.add(id);
    const part = join(this.directory, `${id}.part`); const target = this.attachmentPath(id);
    try {
      const hash = createHash('sha256'); let bytes = 0; let head = Buffer.alloc(0);
      const check = new Transform({
        transform(chunk: unknown, _encoding, done) {
          const buffer = z.instanceof(Buffer).parse(chunk);
          bytes += buffer.length;
          if (bytes > slot.declared_bytes) { done(new ServiceError(413, 'UPLOAD_SIZE', '诊断包超过提交反馈时声明的大小')); return; }
          if (head.length < 2) head = Buffer.concat([head, buffer.subarray(0, 2 - head.length)]);
          hash.update(buffer); done(null, buffer);
        }
      });
      try { await pipeline(request, check, createWriteStream(part, { flags: 'wx', mode: 0o600 })); }
      catch (error) { throw uploadFailure(error); }
      if (bytes !== slot.declared_bytes) throw new ServiceError(400, 'UPLOAD_INCOMPLETE', '诊断包没有传完整，请重新提交反馈');
      if (hash.digest('hex') !== slot.declared_sha256) throw new ServiceError(400, 'UPLOAD_DIGEST', '诊断包内容与提交反馈时不一致');
      if (head[0] !== 0x1f || head[1] !== 0x8b) throw new ServiceError(400, 'UPLOAD_FORMAT', '诊断包不是 gzip 文件');
      await rename(part, target);
      const at = new Date(this.now()).toISOString();
      const saved = this.db.prepare('UPDATE feedback SET attachment_bytes=?,attachment_at=?,attachment_issue=NULL,upload_hash=NULL,upload_until=NULL WHERE id=? AND upload_hash=?').run(bytes, at, id, tokenHash);
      if (saved.changes !== 1) {
        await removeFile(target);
        throw new ServiceError(401, 'UPLOAD_UNAUTHORIZED', '上传凭据已过期，请重新提交反馈');
      }
      return { received: true, bytes };
    } catch (error) {
      await removeFile(part);
      throw error;
    } finally { this.uploading.delete(id); }
  }

  /** Where a received package is kept; the console checks the report before serving it. */
  attachmentPath(id: string): string {
    return join(this.directory, `${z.string().uuid().parse(id)}.tbdiag.gz`);
  }

  /** The size of a received package on disk, or null when the file is gone. */
  async attachmentSize(id: string): Promise<number | null> {
    try { return (await stat(this.attachmentPath(id))).size; }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }

  private enforceLimits(sender: string, machineCode: string | null, since: (ms: number) => string): void {
    const count = (sql: string, ...values: (string | null)[]) => Number(z.object({ n: z.number() }).parse(this.db.prepare(sql).get(...values)).n);
    const hour = 3_600_000; const day = 24 * hour;
    if (count('SELECT COUNT(*) AS n FROM feedback WHERE source=? AND created>=?', sender, since(hour)) >= this.limits.perSourceHour)
      throw new ServiceError(429, 'FEEDBACK_LIMITED', `这个网络一小时内已提交 ${this.limits.perSourceHour} 条反馈`);
    if (count('SELECT COUNT(*) AS n FROM feedback WHERE source=? AND created>=?', sender, since(day)) >= this.limits.perSourceDay)
      throw new ServiceError(429, 'FEEDBACK_LIMITED', `这个网络今天已提交 ${this.limits.perSourceDay} 条反馈`);
    if (machineCode && count('SELECT COUNT(*) AS n FROM feedback WHERE machine_code=? AND created>=?', machineCode, since(day)) >= this.limits.perMachineDay)
      throw new ServiceError(429, 'FEEDBACK_LIMITED', `这台电脑今天已提交 ${this.limits.perMachineDay} 条反馈`);
    if (count('SELECT COUNT(*) AS n FROM feedback WHERE created>=?', since(day)) >= this.limits.perDay)
      throw new ServiceError(429, 'FEEDBACK_LIMITED', '今天收到的反馈已达上限');
  }

  private attachmentIssue(bytes: number, limit: number, licensed: boolean, free: number, at: string): string | null {
    if (bytes > limit) return `诊断包 ${megabytes(bytes)} 超过${licensed ? '' : '未激活电脑的'}上传上限 ${megabytes(limit)}，没有上传；${SAVE_HINT}`;
    const held = Number(z.object({ n: z.number() }).parse(this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN attachment_at IS NOT NULL AND attachment_removed IS NULL THEN attachment_bytes
      WHEN upload_hash IS NOT NULL AND upload_until>? THEN declared_bytes ELSE 0 END),0) AS n FROM feedback`).get(at)).n);
    if (held + bytes > this.limits.storageBytes || free - bytes < this.limits.freeSpaceBytes) return `服务器暂存空间不足，诊断包没有上传；${SAVE_HINT}`;
    return null;
  }

  /** FB-<Beijing date>-XXXX; four letters or digits, skipping the easily confused 0/O and 1/I. */
  private newNumber(now: number): string {
    const day = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10).replaceAll('-', '');
    for (let attempt = 0; attempt < 8; attempt++) {
      const number = `FB-${day}-${Array.from({ length: 4 }, () => NUMBER_ALPHABET.charAt(randomInt(NUMBER_ALPHABET.length))).join('')}`;
      if (!this.db.prepare('SELECT 1 FROM feedback WHERE number=?').get(number)) return number;
    }
    throw new ServiceError(503, 'FEEDBACK_NUMBER', '反馈编号分配失败，请稍后重试');
  }

  /**
   * At most hourly, from a new report: close expired upload slots, drop packages and reports past their
   * retention and parts left by an interrupted upload. Never at startup, so a release activation sees the
   * existing tables unchanged.
   */
  private async prune(): Promise<void> {
    const now = this.now();
    if (now - this.pruned < this.limits.pruneMs) return;
    this.pruned = now;
    const at = new Date(now).toISOString();
    const ids = (sql: string, ...values: string[]) => this.db.prepare(sql).all(...values).map(row => z.object({ id: z.string() }).parse(row).id);
    for (const id of ids('SELECT id FROM feedback WHERE upload_hash IS NOT NULL AND upload_until<=?', at)) {
      if (this.uploading.has(id)) continue;
      this.db.prepare("UPDATE feedback SET upload_hash=NULL,upload_until=NULL,attachment_issue='诊断包没有在上传期限内传到服务器' WHERE id=? AND attachment_at IS NULL").run(id);
    }
    for (const id of ids('SELECT id FROM feedback WHERE attachment_at IS NOT NULL AND attachment_removed IS NULL AND attachment_at<=?', new Date(now - this.limits.attachmentDays * 86_400_000).toISOString())) {
      if (await removeFile(this.attachmentPath(id))) this.db.prepare('UPDATE feedback SET attachment_removed=? WHERE id=?').run(at, id);
    }
    for (const id of ids('SELECT id FROM feedback WHERE created<=?', new Date(now - this.limits.recordDays * 86_400_000).toISOString())) {
      if (await removeFile(this.attachmentPath(id))) this.db.prepare('DELETE FROM feedback WHERE id=?').run(id);
    }
    for (const name of await readdir(this.directory)) {
      const id = /^([a-f0-9-]{36})\.part$/.exec(name)?.[1];
      if (!id || this.uploading.has(id)) continue;
      const path = join(this.directory, name);
      if (now - (await stat(path)).mtimeMs > 3_600_000) await removeFile(path);
    }
  }
}

function parseSubmission(input: unknown): FeedbackSubmission {
  const parsed = feedbackSubmissionSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  // The description and contact limits carry wording meant for the person filling in the form.
  throw new ServiceError(400, 'INVALID_FEEDBACK', field === 'description' || field === 'contact' ? issue?.message ?? '反馈内容无效' : `反馈字段无效：${issue?.path.join('.') || '请求'}`);
}

function uploadFailure(error: unknown): unknown {
  if (error instanceof ServiceError) return error;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOSPC') return new ServiceError(507, 'STORAGE_FULL', '服务器存储空间不足，诊断包没有保存');
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED') return new ServiceError(400, 'UPLOAD_INCOMPLETE', '诊断包没有传完整，请重新提交反馈');
  }
  return error;
}

/** Removes a file the store owns; true when it is gone. A failure is logged and left for the next prune. */
async function removeFile(path: string): Promise<boolean> {
  try { await unlink(path); return true; }
  catch (error) {
    if (isMissing(error)) return true;
    console.error(JSON.stringify({ error: 'FEEDBACK_FILE_REMOVE_FAILED', path, code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN' }));
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
