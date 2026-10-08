import { z } from 'zod';

export const projectDocumentTextSchema = z.string().min(1).max(256 * 1024 * 1024);
export const projectDocumentEnvelopeSchema = z.object({ version: z.literal(1), path: z.string().min(1).max(4096), content: projectDocumentTextSchema }).strict();

const archiveBase = z.object({ version: z.literal(1), projectPath: z.string().min(1).max(4096) });
export const projectArchiveRequestSchema = z.discriminatedUnion('action', [
  archiveBase.extend({ action: z.literal('create'), content: projectDocumentTextSchema, reason: z.enum(['manual', 'before-sync']) }).strict(),
  archiveBase.extend({ action: z.literal('list') }).strict(),
  archiveBase.extend({ action: z.literal('reveal'), name: z.string().min(1).max(512).optional() }).strict()
]);
export const projectArchiveResultSchema = z.object({ version: z.literal(1), entries: z.array(z.object({
  name: z.string(), path: z.string(), createdAt: z.string().datetime(), reason: z.enum(['manual', 'before-sync'])
}).strict()), createdPath: z.string().optional() }).strict();
export type ProjectArchiveRequest = z.infer<typeof projectArchiveRequestSchema>;
export type ProjectArchiveResult = z.infer<typeof projectArchiveResultSchema>;
