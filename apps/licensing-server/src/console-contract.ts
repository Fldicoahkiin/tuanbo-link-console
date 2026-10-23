import { z } from 'zod';

export const roleSchema = z.enum(['owner', 'operations', 'finance', 'viewer']);
export type ConsoleRole = z.infer<typeof roleSchema>;
export const reasonSchema = z.string().trim().min(1).max(500);
// 选填备注：查询、生成链接、补发、建单、建工单这类可重复或无损的操作不强制写原因；审计照记操作人、操作、对象和时间。
const noteSchema = z.string().trim().max(500).default('');
const id = z.string().uuid();
const text = z.string().trim().min(1).max(160);
const date = z.string().datetime();
export const userSchema = z.object({ id, username: text, role: roleSchema, enabled: z.boolean(), enrolled: z.boolean() });
export type ConsoleUser = z.infer<typeof userSchema>;
// now 为服务器当前时间，前端据此校正二次验证倒计时，不依赖运营电脑的时钟。
export const sessionSchema = z.object({ user: userSchema, csrf: z.string(), verifiedAt: z.number(), now: z.number() });
export const loginSchema = z.object({ username: text, password: z.string().min(1).max(256), code: z.string().min(6).max(100) }).strict();
export const enrollmentSchema = z.object({ token: z.string().min(32).max(128), password: z.string().min(12).max(256), code: z.string().regex(/^\d{6}$/) }).strict();
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-order'), reference: text, customer: text, customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100), amountFen: z.number().int().positive().max(100_000_000), useUntil: date, reason: noteSchema }),
  z.object({ action: z.literal('fulfill'), id, amountFen: z.number().int().positive(), paymentReference: text, paymentMethod: text, reason: reasonSchema }),
  z.object({ action: z.literal('reconcile'), id, reason: noteSchema }),
  z.object({ action: z.literal('payment-link'), id, reason: noteSchema }),
  z.object({ action: z.literal('close-order'), id, reason: reasonSchema }),
  z.object({ action: z.literal('retry-delivery'), id, reason: noteSchema }),
  z.object({ action: z.literal('delivery-access'), id, reason: noteSchema }),
  z.object({ action: z.literal('revoke-delivery-access'), id, reason: reasonSchema }),
  z.object({ action: z.literal('reveal'), id, reason: reasonSchema }),
  z.object({ action: z.literal('set-expiry'), id, useUntil: date, reason: reasonSchema }),
  z.object({ action: z.literal('revoke'), id, reason: reasonSchema }),
  z.object({ action: z.literal('migrate'), id, reason: reasonSchema }),
  z.object({ action: z.literal('grant'), customer: text, customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100), useUntil: date, purpose: z.enum(['test', 'gift']), reason: reasonSchema }),
  z.object({ action: z.literal('create-user'), username: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/), role: roleSchema, reason: reasonSchema }),
  z.object({ action: z.literal('update-user'), id, role: roleSchema, enabled: z.boolean(), reason: reasonSchema }),
  z.object({ action: z.literal('reset-user'), id, reason: reasonSchema }),
  z.object({ action: z.literal('create-ticket'), id, licenseId: id.nullable(), category: z.enum(['migration', 'refund', 'invoice', 'recovery', 'other']), note: reasonSchema, reason: noteSchema }),
  z.object({ action: z.literal('update-ticket'), id, state: z.enum(['open', 'processing', 'closed']), conclusion: z.string().trim().max(500), reason: reasonSchema }),
  z.object({ action: z.literal('refund'), id, amountFen: z.number().int().positive(), reference: text, handledAt: date, reason: reasonSchema }),
  // 支付宝 refund_reason 会展示在买卖双方退款账单中，上限 256 字符，超长直接拒绝而不截断。
  z.object({ action: z.literal('alipay-refund'), id, amountFen: z.number().int().positive(), reason: z.string().trim().min(1).max(256) }),
  z.object({ action: z.literal('refund-review'), id, decision: z.enum(['revoke', 'keep']), reason: reasonSchema }),
  z.object({ action: z.literal('invoice'), id, state: z.enum(['requested', 'processing', 'issued', 'rejected']), buyer: text, taxId: z.string().trim().max(100), reference: z.string().trim().max(160), reason: reasonSchema })
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
export const detailSchema = z.object({ item: rowSchema, related: z.array(rowSchema), history: z.array(rowSchema) });
export const resultSchema = z.object({ id: z.string().optional(), message: z.string(), secret: z.string().optional(), paymentUrl: z.string().url().optional(), expiresAt: z.string().optional() }).strict();
export type ConsoleResult = z.infer<typeof resultSchema>;
export const permissions: Record<ConsoleAction['action'], readonly ConsoleRole[]> = {
  // 创建线下订单与确认线下收款不能同属一个非管理员角色，避免一人凭空给自己发码。
  'create-order': ['owner', 'operations'], fulfill: ['owner', 'finance'], reconcile: ['owner', 'operations', 'finance'],
  'payment-link': ['owner', 'operations', 'finance'], 'close-order': ['owner', 'operations', 'finance'],
  'retry-delivery': ['owner', 'operations'], 'delivery-access': ['owner', 'operations'], 'revoke-delivery-access': ['owner', 'operations'],
  'set-expiry': ['owner'], reveal: ['owner', 'operations'], revoke: ['owner', 'operations'], migrate: ['owner', 'operations'], grant: ['owner'],
  'create-user': ['owner'], 'update-user': ['owner'], 'reset-user': ['owner'],
  'create-ticket': ['owner', 'operations', 'finance'], 'update-ticket': ['owner', 'operations', 'finance'], refund: ['owner', 'finance'], invoice: ['owner', 'finance'],
  'alipay-refund': ['owner', 'finance'], 'refund-review': ['owner', 'operations']
};
export const sensitiveActions = new Set<ConsoleAction['action']>(['set-expiry', 'fulfill', 'reveal', 'revoke', 'migrate', 'grant', 'create-user', 'update-user', 'reset-user', 'delivery-access', 'alipay-refund', 'refund-review']);
