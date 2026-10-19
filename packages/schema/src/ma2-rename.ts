import { z } from 'zod';
import { ma2NetworkTargetSchema } from './ma2-bridge';

export const ma2LabelSchema = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f"\\]/u.test(value), '控台名称不能包含双引号、反斜杠或控制字符');
export const ma2RenameRecordSchema = z.object({
  endpoint: z.string().min(1), show: z.string().min(1),
  sequence: z.number().int().min(1).max(99999), kind: z.enum(['single', 'sequence']),
  cue: z.string().regex(/^\d+(?:\.\d{1,3})?$/),
  // An undo frame may restore an originally unlabelled console object.
  // Explicit user edits still pass ma2LabelSchema in queueMa2Rename.
  confirmedName: z.string().max(512), name: z.union([z.literal(''), ma2LabelSchema])
}).strict();
export const ma2RenameRequestSchema = z.object({
  dataDirectory: z.string().max(4096), network: ma2NetworkTargetSchema.optional(),
  change: ma2RenameRecordSchema, generation: z.string().min(1).max(256)
}).strict();
export const ma2RenameResultSchema = z.object({
  sequence: z.number().int().positive(), kind: z.enum(['single', 'sequence']), cue: z.string(),
  show: z.string(), generation: z.string(), name: z.string(),
  backupFile: z.string().regex(/^tblink_label_[a-f0-9]{32}\.xml$/)
}).strict();
export type Ma2RenameRecord = z.infer<typeof ma2RenameRecordSchema>;
export type Ma2RenameRequest = z.infer<typeof ma2RenameRequestSchema>;
export type Ma2RenameResult = z.infer<typeof ma2RenameResultSchema>;
