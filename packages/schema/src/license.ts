import { z } from 'zod';

export const licenseMachineCodeSchema = z.string().regex(/^TB1-[A-F0-9]{64}$/);
export const licenseClaimsSchema = z.object({
  version: z.literal(1), product: z.literal('tuanbo-link-console'),
  licenseId: z.string().uuid(), customer: z.string().trim().min(1).max(160),
  machineCode: licenseMachineCodeSchema,
  kind: z.enum(['perpetual', 'subscription', 'trial']),
  issuedAt: z.string().datetime(), useUntil: z.string().datetime().nullable(),
  updatesUntil: z.string().datetime(),
  online: z.object({ leaseUntil: z.string().datetime(), customerType: z.enum(['personal', 'company']) }).strict().optional()
}).strict().superRefine((value, context) => {
  if ((value.kind === 'perpetual') !== (value.useUntil === null)) context.addIssue({ code: 'custom', message: '买断授权不设使用期限；订阅和试用必须有期限' });
  if (value.useUntil && Date.parse(value.useUntil) <= Date.parse(value.issuedAt)) context.addIssue({ code: 'custom', message: '使用期限必须晚于签发时间' });
  if (!value.online && Date.parse(value.updatesUntil) < Date.parse(value.issuedAt)) context.addIssue({ code: 'custom', message: '升级期限不能早于签发时间' });
  if (value.online && (Date.parse(value.online.leaseUntil) <= Date.parse(value.issuedAt) || value.useUntil && Date.parse(value.online.leaseUntil) > Date.parse(value.useUntil))) context.addIssue({ code: 'custom', message: '离线授权的期限无效' });
});
export const licenseRequestSchema = z.object({ version: z.literal(1), product: z.literal('tuanbo-link-console'), machineCode: licenseMachineCodeSchema }).strict();
export const licenseStatusSchema = z.object({
  machineCode: licenseMachineCodeSchema,
  state: z.enum(['unconfigured', 'inactive', 'active', 'expired', 'invalid', 'renewal-required']),
  claims: licenseClaimsSchema.nullable(), message: z.string(),
  enforcement: z.literal('required'),
  onlineAvailable: z.boolean().default(false),
  /** Set when this run started on the local lease because the licensing server was unreachable. */
  offlineUntil: z.string().datetime().optional()
}).strict();
export const activationCodeSchema = z.string().trim().toUpperCase().regex(/^TBA-[A-F0-9]{32}$/, '请输入完整激活码，格式为 TBA- 加 32 位字符');
export const licenseActivationSchema = z.object({ product: z.literal('tuanbo-link-console'), code: activationCodeSchema, machineCode: licenseMachineCodeSchema }).strict();
export const licenseActivationResponseSchema = z.object({ license: z.string().min(1).max(16384) }).strict();
export type LicenseClaims = z.infer<typeof licenseClaimsSchema>;
export type LicenseStatus = z.infer<typeof licenseStatusSchema>;
