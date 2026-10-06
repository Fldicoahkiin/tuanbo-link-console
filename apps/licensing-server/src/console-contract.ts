import { z } from 'zod';

export const roleSchema = z.enum(['owner', 'operations', 'finance', 'viewer']);
export type ConsoleRole = z.infer<typeof roleSchema>;
export const reasonSchema = z.string().trim().min(1).max(500);
const id = z.string().uuid();
const text = z.string().trim().min(1).max(160);
const date = z.string().datetime();
export const userSchema = z.object({ id, username: text, role: roleSchema, enabled: z.boolean(), enrolled: z.boolean() });
export type ConsoleUser = z.infer<typeof userSchema>;
export const sessionSchema = z.object({ user: userSchema, csrf: z.string(), verifiedAt: z.number() });
export const loginSchema = z.object({ username: text, password: z.string().min(1).max(256), code: z.string().min(6).max(100) }).strict();
export const enrollmentSchema = z.object({ token: z.string().min(32).max(128), password: z.string().min(12).max(256), code: z.string().regex(/^\d{6}$/) }).strict();
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-order'), reference: text, customer: text, customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100), amountFen: z.number().int().positive().max(100_000_000), useUntil: date, reason: reasonSchema }),
  z.object({ action: z.literal('fulfill'), id, amountFen: z.number().int().positive(), paymentReference: text, paymentMethod: text, reason: reasonSchema }),
  z.object({ action: z.literal('reconcile'), id, reason: reasonSchema }),
  z.object({ action: z.literal('retry-delivery'), id, reason: reasonSchema }),
  z.object({ action: z.literal('delivery-access'), id, reason: reasonSchema }),
  z.object({ action: z.literal('revoke-delivery-access'), id, reason: reasonSchema }),
  z.object({ action: z.literal('reveal'), id, reason: reasonSchema }),
  z.object({ action: z.literal('revoke'), id, reason: reasonSchema }),
  z.object({ action: z.literal('migrate'), id, reason: reasonSchema }),
  z.object({ action: z.literal('grant'), customer: text, customerType: z.enum(['personal', 'company']), quantity: z.number().int().min(1).max(100), useUntil: date, purpose: z.enum(['test', 'gift']), reason: reasonSchema }),
  z.object({ action: z.literal('create-user'), username: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/), role: roleSchema, reason: reasonSchema }),
  z.object({ action: z.literal('update-user'), id, role: roleSchema, enabled: z.boolean(), reason: reasonSchema }),
  z.object({ action: z.literal('reset-user'), id, reason: reasonSchema }),
  z.object({ action: z.literal('create-ticket'), id, licenseId: id.nullable(), category: z.enum(['migration', 'refund', 'invoice', 'recovery', 'other']), note: reasonSchema, reason: reasonSchema }),
  z.object({ action: z.literal('update-ticket'), id, state: z.enum(['open', 'processing', 'closed']), conclusion: z.string().trim().max(500), reason: reasonSchema }),
  z.object({ action: z.literal('refund'), id, amountFen: z.number().int().positive(), reference: text, handledAt: date, reason: reasonSchema }),
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
export const pageSchema = z.object({ items: z.array(rowSchema), page: z.number().int(), hasMore: z.boolean() });
export const detailSchema = z.object({ item: rowSchema, related: z.array(rowSchema), history: z.array(rowSchema) });
export const resultSchema = z.object({ id: z.string().optional(), message: z.string(), secret: z.string().optional(), expiresAt: z.string().optional() }).strict();
export type ConsoleResult = z.infer<typeof resultSchema>;
export const permissions: Record<ConsoleAction['action'], readonly ConsoleRole[]> = {
  'create-order': ['owner', 'operations'], fulfill: ['owner', 'finance'], reconcile: ['owner', 'operations'],
  'retry-delivery': ['owner', 'operations'], 'delivery-access': ['owner', 'operations'], 'revoke-delivery-access': ['owner', 'operations'],
  reveal: ['owner', 'operations'], revoke: ['owner', 'operations'], migrate: ['owner', 'operations'], grant: ['owner'],
  'create-user': ['owner'], 'update-user': ['owner'], 'reset-user': ['owner'],
  'create-ticket': ['owner', 'operations', 'finance'], 'update-ticket': ['owner', 'operations', 'finance'], refund: ['owner', 'finance'], invoice: ['owner', 'finance']
};
export const sensitiveActions = new Set<ConsoleAction['action']>(['fulfill', 'reveal', 'revoke', 'migrate', 'grant', 'create-user', 'update-user', 'reset-user', 'delivery-access']);
