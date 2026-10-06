import { z } from 'zod';
import { linkFilePathSchema, projectDocumentTextSchema } from '@tb/schema';

const envelope = { version: z.literal(1), id: z.number().int().positive() };
export const projectDocumentRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('open'), path: linkFilePathSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('save'), path: linkFilePathSchema, content: projectDocumentTextSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('inspect'), content: projectDocumentTextSchema }).strict()
]);
export const projectDocumentResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('opened'), content: projectDocumentTextSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('saved') }).strict(),
  z.object({ ...envelope, kind: z.literal('inspected'), name: z.string().min(1) }).strict(),
  z.object({ ...envelope, kind: z.literal('error'), error: z.string().min(1).max(8192) }).strict()
]);
export type ProjectDocumentRequest = z.infer<typeof projectDocumentRequestSchema>;
export type ProjectDocumentResponse = z.infer<typeof projectDocumentResponseSchema>;
