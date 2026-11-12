import { z } from 'zod';

export const roleSchema = z.enum(['owner', 'operations', 'finance', 'viewer']);
export type ConsoleRole = z.infer<typeof roleSchema>;
// 原因一律选填（2026-11-12 用户要求放宽）：审计照记操作人、操作、对象和时间，写了原因就一并记下。工单和问题反馈关闭时的处理结论仍必填，在 console-service.ts 里判断。
const noteSchema = z.string().trim().max(500).default('');
const id = z.string().uuid();
const text = z.string().trim().min(1).max(160);
const description = z.string().trim().min(1).max(500);
const date = z.string().datetime();
// A staged Windows release: version plus the first 12 hex digits of its commit (receive-update.py).
const stagedRelease = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[a-f0-9]{12}$/);
const releaseVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const userSchema = z.object({ id, username: text, role: roleSchema, enabled: z.boolean(), enrolled: z.boolean() });
export type ConsoleUser = z.infer<typeof userSchema>;
// now 为服务器当前时间，前端据此校正二次验证倒计时，不依赖运营电脑的时钟。
export const sessionSchema = z.object({ user: userSchema, csrf: z.string(), verifiedAt: z.number(), now: z.number() });
export const loginSchema = z.object({ username: text, password: z.string().min(1).max(256), code: z.string().min(6).max(100) }).strict();
export const enrollmentSchema = z.object({ token: z.string().min(32).max(128), password: z.string().min(12).max(256), code: z.string().regex(/^\d{6}$/) }).strict();
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-order'), reference: text, customer: text, customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100), amountFen: z.number().int().positive().max(100_000_000), useUntil: date, reason: noteSchema }),
  z.object({ action: z.literal('fulfill'), id, amountFen: z.number().int().positive(), paymentReference: text, paymentMethod: text, reason: noteSchema }),
  z.object({ action: z.literal('reconcile'), id, reason: noteSchema }),
  z.object({ action: z.literal('payment-link'), id, reason: noteSchema }),
  z.object({ action: z.literal('close-order'), id, reason: noteSchema }),
  z.object({ action: z.literal('retry-delivery'), id, reason: noteSchema }),
  z.object({ action: z.literal('delivery-access'), id, reason: noteSchema }),
  z.object({ action: z.literal('revoke-delivery-access'), id, reason: noteSchema }),
  z.object({ action: z.literal('reveal'), id, reason: noteSchema }),
  z.object({ action: z.literal('set-expiry'), id, useUntil: date, reason: noteSchema }),
  z.object({ action: z.literal('revoke'), id, reason: noteSchema }),
  z.object({ action: z.literal('migrate'), id, reason: noteSchema }),
  z.object({ action: z.literal('grant'), customer: text, customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100), useUntil: date, purpose: z.enum(['test', 'gift']), reason: noteSchema }),
  z.object({ action: z.literal('create-user'), username: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/), role: roleSchema, reason: noteSchema }),
  z.object({ action: z.literal('update-user'), id, role: roleSchema, enabled: z.boolean(), reason: noteSchema }),
  z.object({ action: z.literal('reset-user'), id, reason: noteSchema }),
  z.object({ action: z.literal('create-ticket'), id, licenseId: id.nullable(), category: z.enum(['migration', 'refund', 'invoice', 'recovery', 'other']), note: description, reason: noteSchema }),
  z.object({ action: z.literal('update-ticket'), id, state: z.enum(['open', 'processing', 'closed']), conclusion: z.string().trim().max(500), reason: noteSchema }),
  // 问题反馈：可重新打开；关闭时必须写处理结论。
  z.object({ action: z.literal('update-feedback'), id, state: z.enum(['open', 'processing', 'closed']), conclusion: z.string().trim().max(500), reason: noteSchema }),
  z.object({ action: z.literal('refund'), id, amountFen: z.number().int().positive(), reference: text, handledAt: date, reason: noteSchema }),
  // 支付宝 refund_reason 会展示在买卖双方退款账单中，上限 256 字符，超长直接拒绝而不截断。
  z.object({ action: z.literal('alipay-refund'), id, amountFen: z.number().int().positive(), reason: z.string().trim().max(256).default('') }),
  z.object({ action: z.literal('refund-review'), id, decision: z.enum(['revoke', 'keep']), reason: noteSchema }),
  z.object({ action: z.literal('publish-update'), id: stagedRelease, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), reason: noteSchema }),
  z.object({ action: z.literal('rollback-update'), id: releaseVersion, reason: noteSchema }),
  z.object({ action: z.literal('discard-update'), id: stagedRelease, reason: noteSchema }),
  z.object({ action: z.literal('invoice'), id, state: z.enum(['requested', 'processing', 'issued', 'rejected']), buyer: text, taxId: z.string().trim().max(100), reference: z.string().trim().max(160), reason: noteSchema })
]);
export type ConsoleAction = z.infer<typeof actionSchema>;
export const commandSchema = z.object({ operationId: id, input: actionSchema }).strict();
const calendarDate = z.string().refine(value => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, '日期无效');
export const pageQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), q: z.string().max(160).default(''), state: z.string().max(32).default(''), channel: z.enum(['', 'manual', 'alipay', 'wechat', 'test', 'gift']).default(''), from: calendarDate.default(''), to: calendarDate.default('') }).strict().refine(value => !value.from || !value.to || value.from <= value.to, '日期范围无效');
export type PageQuery = z.infer<typeof pageQuerySchema>;
// Table DTOs deliberately permit only scalars; secrets and raw database bodies are never projected.
export const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const rowSchema = z.record(z.string(), cellSchema);
export type ConsoleRow = z.infer<typeof rowSchema>;
export const pageSchema = z.object({ items: z.array(rowSchema), page: z.number().int(), hasMore: z.boolean(), summary: rowSchema.optional() });
// timeline 仅授权详情返回：签发、激活、换机、调整到期、续费、撤销或过期，按时间排列。
export const detailSchema = z.object({ item: rowSchema, related: z.array(rowSchema), history: z.array(rowSchema), timeline: z.array(rowSchema).optional() });
export const resultSchema = z.object({ id: z.string().optional(), message: z.string(), secret: z.string().optional(), paymentUrl: z.string().url().optional(), expiresAt: z.string().optional(), licenseId: z.string().uuid().optional() }).strict();
export type ConsoleResult = z.infer<typeof resultSchema>;
export const permissions: Record<ConsoleAction['action'], readonly ConsoleRole[]> = {
  // 创建线下订单与确认线下收款不能同属一个非管理员角色，避免一人凭空给自己发码。
  'create-order': ['owner', 'operations'], fulfill: ['owner', 'finance'], reconcile: ['owner', 'operations', 'finance'],
  'payment-link': ['owner', 'operations', 'finance'], 'close-order': ['owner', 'operations', 'finance'],
  'retry-delivery': ['owner', 'operations'], 'delivery-access': ['owner', 'operations'], 'revoke-delivery-access': ['owner', 'operations'],
  'set-expiry': ['owner'], reveal: ['owner', 'operations'], revoke: ['owner', 'operations'], migrate: ['owner', 'operations'], grant: ['owner'],
  'create-user': ['owner'], 'update-user': ['owner'], 'reset-user': ['owner'],
  'create-ticket': ['owner', 'operations', 'finance'], 'update-ticket': ['owner', 'operations', 'finance'], refund: ['owner', 'finance'], invoice: ['owner', 'finance'],
  // 反馈带联系方式和诊断包，只给管理员和运营（与 feedbackRoles 一致）。
  'update-feedback': ['owner', 'operations'],
  'alipay-refund': ['owner', 'finance'], 'refund-review': ['owner', 'operations'],
  'publish-update': ['owner'], 'rollback-update': ['owner'], 'discard-update': ['owner']
};
/** Who reads problem reports, their contact details and diagnostic packages. */
export const feedbackRoles: readonly ConsoleRole[] = ['owner', 'operations'];
/** 后台的时限只在这里定（2026-11-12 用户要求放宽）：服务端的判断、Cookie 有效期和页面上的提示都读它。 */
export const consolePolicy = { sessionIdleMs: 7 * 86400000, sessionMaxMs: 30 * 86400000, stepUpMs: 30 * 60000 } as const;
export const sensitiveActions = new Set<ConsoleAction['action']>(['set-expiry', 'fulfill', 'reveal', 'revoke', 'migrate', 'grant', 'create-user', 'update-user', 'reset-user', 'delivery-access', 'alipay-refund', 'refund-review', 'publish-update', 'rollback-update', 'discard-update']);

/** update-status.json, written by the root publish-update.py; the console only reads it. */
export const updateStatusSchema = z.object({
  version: z.literal(1), generatedAt: z.string(),
  feed: z.object({ version: z.string(), releaseDate: z.string(), signed: z.boolean() }).nullable(),
  rollback: z.object({ version: z.string().nullable(), issue: z.string().nullable() }),
  staged: z.array(z.object({ name: z.string(), issue: z.string().nullable(), version: z.string().optional(), gitSha: z.string().optional(),
    manifestSha256: z.string().optional(), releaseDate: z.string().optional(), kid: z.string().optional(), size: z.number().optional() })),
  // The last automatic publish of a staged release; absent before the publisher that writes it is installed.
  autoPublish: z.object({ name: z.string(), ok: z.boolean(), message: z.string(), at: z.string() }).nullable().optional()
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type UpdateRequest = { id: string; action: 'publish' | 'rollback' | 'discard'; staged?: string; version?: string; manifestSha256?: string; actor: string; reason: string; requestedAt: string };
export type UpdateOutcome = { ok: boolean; message: string };
