import { z } from 'zod';
import { linkFilePathSchema, projectDocumentTextSchema } from '@tb/schema';

const envelope = { version: z.literal(1), id: z.number().int().positive() };
export const projectDocumentRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('open'), path: linkFilePathSchema }).strict(),
  /** `replaceOlderFormat`: the operator agreed to save over a file that only older releases open ('check-save'). */
  z.object({ ...envelope, kind: z.literal('save'), path: linkFilePathSchema, content: projectDocumentTextSchema, backupOriginal: z.boolean(), replaceOlderFormat: z.boolean() }).strict(),
  /** Before a save: would it turn a file 0.5.8 and earlier open into one they cannot? */
  z.object({ ...envelope, kind: z.literal('check-save'), path: linkFilePathSchema, content: projectDocumentTextSchema }).strict(),
  /** A validated copy outside the project file: no upgrade backups, no merge with other saves of that file. */
  z.object({ ...envelope, kind: z.literal('copy'), path: linkFilePathSchema, content: projectDocumentTextSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('inspect'), content: projectDocumentTextSchema }).strict()
]);
export const projectDocumentResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('opened'), content: projectDocumentTextSchema, upgraded: z.boolean() }).strict(),
  /** `keptOlderFormat`: the backup of the older-format file this save kept beside it. */
  z.object({ ...envelope, kind: z.literal('saved'), keptOlderFormat: z.string().min(1).max(32768).optional() }).strict(),
  /** `olderFormat`: the file is one older releases open and the content is not; its backup would get this name. */
  z.object({ ...envelope, kind: z.literal('save-checked'), olderFormat: z.object({ backupName: z.string().min(1).max(4096) }).strict().nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal('inspected'), name: z.string().min(1) }).strict(),
  z.object({ ...envelope, kind: z.literal('error'), error: z.string().min(1).max(8192) }).strict()
]);
export type ProjectDocumentRequest = z.infer<typeof projectDocumentRequestSchema>;
export type ProjectDocumentResponse = z.infer<typeof projectDocumentResponseSchema>;
