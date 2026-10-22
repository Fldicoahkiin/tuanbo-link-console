import { z } from 'zod';

export const projectDocumentTextSchema = z.string().min(1).max(256 * 1024 * 1024);
/** Save options: `defaultPath` suggests a folder when the save dialog opens; `backupOriginal` keeps
 * the file as it was before the first save after an in-memory upgrade. */
export const projectSaveOptionsSchema = z.object({ defaultPath: z.string().min(1).max(4096).optional(), backupOriginal: z.boolean().optional() }).strict();
/** `upgraded`: the opened content differs from the file, which stays unchanged until saved. */
export const projectDocumentEnvelopeSchema = z.object({ version: z.literal(1), path: z.string().min(1).max(4096), content: projectDocumentTextSchema, upgraded: z.boolean() }).strict();

/** A document's recovery copy belongs to its project file, or to an unnamed project by id. */
const recoveryOwner = { projectPath: z.string().min(1).max(4096).nullable(), projectId: z.string().min(1).max(200) };
/** Unsaved edits written beside the program's data, never over the project file. */
export const recoveryCopyWriteSchema = z.object({ version: z.literal(1), ...recoveryOwner, name: z.string().max(512),
  sessionId: z.uuid(), revision: z.number().int().nonnegative(), content: projectDocumentTextSchema }).strict();
/** With `keep`, a copy that session wrote after that revision stays: it holds edits made after the save. */
export const recoveryCopyDiscardSchema = z.object({ version: z.literal(1), ...recoveryOwner,
  keep: z.object({ sessionId: z.uuid(), revision: z.number().int().nonnegative() }).strict().optional() }).strict();
/** Startup asks with `projectPath: null` for the newest unnamed project; opening a file names it and its project. */
export const recoveryCopyQuerySchema = z.object({ version: z.literal(1), projectPath: z.string().min(1).max(4096).nullable(), projectId: z.string().min(1).max(200).optional() }).strict();
export const recoveryCopyContentSchema = z.object({ version: z.literal(1), content: projectDocumentTextSchema }).strict();
export type RecoveryCopyWrite = z.infer<typeof recoveryCopyWriteSchema>;
export type RecoveryCopyDiscard = z.infer<typeof recoveryCopyDiscardSchema>;
export type RecoveryCopyQuery = z.infer<typeof recoveryCopyQuerySchema>;

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
