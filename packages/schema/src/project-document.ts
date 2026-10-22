import { z } from 'zod';

export const projectDocumentTextSchema = z.string().min(1).max(256 * 1024 * 1024);
export const projectDocumentEnvelopeSchema = z.object({ version: z.literal(1), path: z.string().min(1).max(4096), content: projectDocumentTextSchema }).strict();

const archiveBase = z.object({ version: z.literal(1), projectPath: z.string().min(1).max(4096) });
export const projectArchiveRequestSchema = z.discriminatedUnion('action', [
  archiveBase.extend({ action: z.literal('create'), content: projectDocumentTextSchema, reason: z.enum(['manual', 'before-sync']) }).strict(),
  archiveBase.extend({ action: z.literal('list') }).strict(),
  archiveBase.extend({ action: z.literal('reveal'), name: z.string().min(1).max(512).optional() }).strict(),
  /** Writes the named archive back to projectPath after archiving the current file. */
  archiveBase.extend({ action: z.literal('restore'), name: z.string().min(1).max(512) }).strict()
]);
export const projectArchiveResultSchema = z.object({ version: z.literal(1), entries: z.array(z.object({
  name: z.string(), path: z.string(), createdAt: z.string().datetime(), reason: z.enum(['manual', 'before-sync'])
}).strict()), createdPath: z.string().optional(),
  /** Automatic archiving is switched off on this computer; nothing was written. */
  disabled: z.boolean().optional() }).strict();
export type ProjectArchiveRequest = z.infer<typeof projectArchiveRequestSchema>;
export type ProjectArchiveResult = z.infer<typeof projectArchiveResultSchema>;

/** File names never contain a path or characters Windows rejects. Tokens: {工程名} {日期} {时间} {类型}. */
export const projectArchiveNameTemplateSchema = z.string().trim().min(1).max(120)
  .refine(value => !/[\\/:*?"<>|\u0000-\u001f]/.test(value), '名称模板不能包含 \\ / : * ? " < > | 或控制字符');
/** Machine settings: never stored in a .tblink, which keeps no absolute paths. */
export const projectArchiveSettingsSchema = z.object({ version: z.literal(1), enabled: z.boolean(), directory: z.string().min(1).max(4096).nullable(),
  keep: z.number().int().min(1).max(500), nameTemplate: projectArchiveNameTemplateSchema }).strict();
export const projectArchiveSettingsStatusSchema = z.object({ settings: projectArchiveSettingsSchema, directory: z.string(), defaultDirectory: z.string(),
  usageBytes: z.number().int().nonnegative(), fileCount: z.number().int().nonnegative() }).strict();
export const projectArchiveSettingsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('save'), enabled: z.boolean(), keep: z.number().int().min(1).max(500), nameTemplate: projectArchiveNameTemplateSchema }).strict(),
  z.object({ action: z.literal('choose-directory') }).strict(),
  z.object({ action: z.literal('reset-directory') }).strict(),
  z.object({ action: z.literal('open-directory') }).strict()
]);
export type ProjectArchiveSettings = z.infer<typeof projectArchiveSettingsSchema>;
export type ProjectArchiveSettingsStatus = z.infer<typeof projectArchiveSettingsStatusSchema>;
export type ProjectArchiveSettingsAction = z.infer<typeof projectArchiveSettingsActionSchema>;
