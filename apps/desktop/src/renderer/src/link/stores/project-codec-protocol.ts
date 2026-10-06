import { z } from 'zod';
import { projectDocumentTextSchema, type LinkProject } from '@tb/schema';

const id = z.number().int().positive();
// This is an internal worker envelope. The worker performs the entire project
// schema and relation check; callers cannot turn arbitrary input into a result.
const projectShape = z.custom<LinkProject>(value => typeof value === 'object' && value !== null
  && 'schemaVersion' in value && 'rundown' in value && Array.isArray(value.rundown));
export const projectCodecRequestSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), id, kind: z.literal('decode'), content: projectDocumentTextSchema }).strict(),
  z.object({ version: z.literal(1), id, kind: z.literal('encode'), project: projectShape }).strict()
]);
export const projectCodecResponseSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), id, kind: z.literal('decoded'), project: projectShape }).strict(),
  z.object({ version: z.literal(1), id, kind: z.literal('encoded'), content: projectDocumentTextSchema }).strict(),
  z.object({ version: z.literal(1), id, kind: z.literal('error'), message: z.string() }).strict()
]);
export type ProjectCodecResponse = z.infer<typeof projectCodecResponseSchema>;
