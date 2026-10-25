import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  FEEDBACK_LIMITS, feedbackCategoryLabels, feedbackReceiptSchema, feedbackSubmissionSchema, feedbackUploadResponseSchema,
  type FeedbackEnvironment, type LinkFeedbackDraft, type LinkFeedbackResult
} from '@tb/schema';
import type { LinkLogInput } from './run-logger';

/**
 * How often this app sends feedback, on top of the server's own limits: one at a time, a minute apart once one
 * reached the server, at most five an hour, and the same text only once a day.
 */
export const FEEDBACK_CLIENT_LIMITS = { spacingMs: 60_000, attemptSpacingMs: 10_000, perHour: 5, duplicateMs: 24 * 3_600_000 } as const;

/**
 * Who sends the report. A machine whose license cannot be read still sends one, without a machine code;
 * `licenseSummary` then says why, so support sees it next to the report.
 */
export type FeedbackIdentity = { machineCode: string | null; license: string | null; licensed: boolean; licenseSummary: string; version: string };
export type FeedbackDependencies = {
  serverUrl: string;
  identity: () => Promise<FeedbackIdentity>;
  /** Everything in the summary except the license line, which comes with the identity. */
  environment: () => Omit<FeedbackEnvironment, 'license'>;
  /** Writes the gzip diagnostic package for this report to `path`, covering the last `days`. */
  writeDiagnostic: (path: string, context: Readonly<Record<string, unknown>>, days: 1 | 7 | 30) => Promise<void>;
  temporaryDirectory: string;
  log: (entry: LinkLogInput) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
};

type Sent = { at: number; digest: string; number: string };
const errorBodySchema = z.object({ code: z.string().max(64), message: z.string().max(300) }).passthrough();
const SAVE_HINT = '也可以点「另存为文件」，把反馈和诊断包发给售后';

class FeedbackNetworkError extends Error {
  constructor(message: string, readonly technical: string) { super(message); }
}

/** The log range a report needs: enough to cover when it happened. */
export function feedbackRange(occurredAt: string, now: number): 1 | 7 | 30 {
  const age = now - Date.parse(occurredAt);
  return age <= 24 * 3_600_000 ? 1 : age <= 7 * 24 * 3_600_000 ? 7 : 30;
}

/** What a report adds to a diagnostic package, so the package explains itself when sent by hand. */
export function feedbackContext(draft: LinkFeedbackDraft, environment: FeedbackEnvironment): Record<string, unknown> {
  return { ...draft.context, problem: draft.description,
    feedback: { category: draft.category, categoryLabel: feedbackCategoryLabels[draft.category], description: draft.description,
      contact: draft.contact, occurredAt: draft.occurredAt, environment } };
}

export class FeedbackService {
  private readonly sent: Sent[] = [];
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private readonly origin: URL;
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly dependencies: FeedbackDependencies) {
    this.origin = new URL(dependencies.serverUrl);
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password || this.origin.search || this.origin.hash || this.origin.pathname !== '/') throw new Error('反馈服务器必须是固定的 HTTPS 域名');
    this.request = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async submit(draft: LinkFeedbackDraft): Promise<Extract<LinkFeedbackResult, { outcome: 'submitted' }>> {
    if (this.busy) throw new Error('上一条反馈正在提交，请稍候');
    this.throttle(draft);
    this.busy = true; this.lastAttempt = this.now();
    const packagePath = draft.includeDiagnostics ? join(this.dependencies.temporaryDirectory, `tblink-feedback-${randomUUID()}.tbdiag.gz`) : null;
    try {
      const identity = await this.dependencies.identity();
      const environment: FeedbackEnvironment = { ...this.dependencies.environment(), license: identity.licenseSummary.slice(0, 160) };
      let diagnostic: { bytes: number; sha256: string; body: Buffer } | null = null;
      let localIssue: string | null = null;
      if (packagePath) {
        await this.dependencies.writeDiagnostic(packagePath, feedbackContext(draft, environment), feedbackRange(draft.occurredAt, this.now()));
        const limit = identity.licensed ? FEEDBACK_LIMITS.attachmentBytes : FEEDBACK_LIMITS.unlicensedAttachmentBytes;
        const bytes = (await stat(packagePath)).size;
        if (bytes > limit) localIssue = `诊断包 ${megabytes(bytes)} 超过上传上限 ${megabytes(limit)}，没有上传；请用「另存为文件」导出后发给售后`;
        else {
          const body = await readFile(packagePath);
          diagnostic = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), body };
        }
      }
      const submission = feedbackSubmissionSchema.parse({ product: 'tuanbo-link-console', version: identity.version, category: draft.category,
        description: draft.description, contact: draft.contact, occurredAt: draft.occurredAt, machineCode: identity.machineCode, license: identity.license,
        environment, diagnostic: diagnostic ? { bytes: diagnostic.bytes, sha256: diagnostic.sha256 } : null });
      const receipt = feedbackReceiptSchema.parse(await this.call(new URL('/v1/feedback', this.origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission) }, 15_000));
      this.sent.push({ at: this.now(), digest: digest(draft), number: receipt.number });
      let attachment: 'uploaded' | 'none' | 'refused' | 'failed' = diagnostic ? 'refused' : localIssue ? 'refused' : 'none';
      let attachmentIssue = localIssue ?? receipt.attachmentIssue;
      if (diagnostic && receipt.upload) {
        try {
          feedbackUploadResponseSchema.parse(await this.call(new URL(`/v1/feedback/${receipt.id}/diagnostic`, this.origin), {
            method: 'PUT', headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${receipt.upload.token}` }, body: new Uint8Array(diagnostic.body) }, 180_000));
          attachment = 'uploaded'; attachmentIssue = null;
        } catch (error) {
          attachment = 'failed';
          const reason = error instanceof FeedbackNetworkError ? `${error.message.split('，')[0]}（${error.technical}）` : message(error).split('；')[0];
          attachmentIssue = `诊断包上传失败：${reason}；文字已提交，请用「另存为文件」导出诊断包后发给售后并注明编号 ${receipt.number}`;
        }
      } else if (diagnostic && !attachmentIssue) attachmentIssue = '服务器没有接收诊断包；请用「另存为文件」导出后发给售后';
      await this.dependencies.log({ level: attachment === 'failed' || attachment === 'refused' ? 'warning' : 'info', category: 'operator', device: '问题反馈',
        message: `问题反馈已提交，编号 ${receipt.number}（${feedbackCategoryLabels[draft.category]}，发生于 ${chinaTime(draft.occurredAt)}）：${excerpt(draft.description)}`,
        result: 'succeeded', details: { number: receipt.number, category: draft.category, occurredAt: draft.occurredAt, description: draft.description,
          attachment, attachmentIssue, attachmentBytes: diagnostic?.bytes ?? null, machineCode: identity.machineCode, license: environment.license } });
      return { outcome: 'submitted', number: receipt.number, attachment, attachmentIssue };
    } catch (error) {
      await this.dependencies.log({ level: 'error', category: 'operator', device: '问题反馈', result: 'failed',
        message: `问题反馈未能提交：${message(error)}`, details: { category: draft.category, occurredAt: draft.occurredAt, description: draft.description,
          ...(error instanceof FeedbackNetworkError ? { technicalError: error.technical } : {}) } });
      throw error;
    } finally {
      this.busy = false;
      // The package is a copy of what stays in the logs; a leftover temp file is noted, never a failed report.
      if (packagePath) await unlink(packagePath).catch(async (error: unknown) => {
        if (isMissing(error)) return;
        await this.dependencies.log({ level: 'warning', category: 'system', device: '问题反馈', message: `反馈用的临时诊断包未能删除：${packagePath}（${message(error)}）` });
      });
    }
  }

  private throttle(draft: LinkFeedbackDraft): void {
    const now = this.now();
    const recent = this.sent.filter(entry => now - entry.at < FEEDBACK_CLIENT_LIMITS.duplicateMs);
    this.sent.splice(0, this.sent.length, ...recent);
    const duplicate = recent.find(entry => entry.digest === digest(draft));
    if (duplicate) throw new Error(`这条反馈已经提交过（编号 ${duplicate.number}），不用重复提交；有新情况请补充在说明里`);
    const last = recent.at(-1);
    if (last && now - last.at < FEEDBACK_CLIENT_LIMITS.spacingMs) throw new Error(`刚提交过一条反馈，请 ${Math.ceil((FEEDBACK_CLIENT_LIMITS.spacingMs - (now - last.at)) / 1000)} 秒后再提交`);
    if (recent.filter(entry => now - entry.at < 3_600_000).length >= FEEDBACK_CLIENT_LIMITS.perHour) throw new Error(`一小时内最多提交 ${FEEDBACK_CLIENT_LIMITS.perHour} 条反馈，请稍后再提交；${SAVE_HINT}`);
    if (now - this.lastAttempt < FEEDBACK_CLIENT_LIMITS.attemptSpacingMs) throw new Error('提交太快了，请几秒后再试');
  }

  /** One request to the feedback server; any failure is an Error whose message tells the operator what to do. */
  private async call(url: URL, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try { response = await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) {
      // The window shows this text as is; the network error itself goes to the run log.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new FeedbackNetworkError(`${timedOut ? '连接反馈服务器超时' : '无法连接反馈服务器'}，请检查网络后重试；${SAVE_HINT}`, message(error));
    }
    const text = await boundedText(response, 20_000);
    if (response.ok) {
      try { return JSON.parse(text) as unknown; }
      catch (error) { if (error instanceof SyntaxError) throw new Error('反馈服务器返回的内容无法识别'); throw error; }
    }
    const body = parseError(text);
    if (response.status === 404 && !body) throw new Error(`反馈服务尚未开通；${SAVE_HINT}`);
    if (response.status === 429) throw new Error(`${body?.message ?? '提交太频繁'}，请稍后再试；${SAVE_HINT}`);
    if (response.status >= 500) throw new Error(`反馈服务器暂时不可用（${response.status}），请稍后重试；${SAVE_HINT}`);
    throw new Error(body?.message ?? `反馈服务器拒绝了这条反馈（${response.status}）；${SAVE_HINT}`);
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new Error('反馈服务器返回超过大小限制');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function parseError(text: string): z.infer<typeof errorBodySchema> | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = errorBodySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function digest(draft: LinkFeedbackDraft): string {
  return createHash('sha256').update(JSON.stringify([draft.category, draft.description.replace(/\s+/g, ' ')])).digest('hex');
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function chinaTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
