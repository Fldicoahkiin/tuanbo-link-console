import { z } from 'zod';

export const projectDocumentTextSchema = z.string().min(1).max(256 * 1024 * 1024);
export const projectDocumentEnvelopeSchema = z.object({ version: z.literal(1), path: z.string().min(1).max(4096), content: projectDocumentTextSchema }).strict();
