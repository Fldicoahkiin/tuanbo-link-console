import { z } from 'zod';
import { linkCueSchema } from './link-project';

const identity = {
  version: z.literal(1), sessionId: z.string().min(1), programId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(), transactionId: z.string().min(1)
};
export const liveCueEditRequestSchema = z.object({ ...identity, cues: z.array(linkCueSchema) }).strict().superRefine((value, context) => {
  if (new Set(value.cues.map(cue => cue.id)).size !== value.cues.length) context.addIssue({ code: 'custom', message: '实时修改的 Cue ID 重复' });
});
export const liveCueEditCommitSchema = z.object({ ...identity,
  channels: z.array(z.object({ channel: z.enum(['obs', 'midi']), state: z.enum(['ready', 'failed', 'not-participating']), reason: z.string().optional() }).strict())
}).strict().superRefine((value, context) => {
  if (new Set(value.channels.map(channel => channel.channel)).size !== value.channels.length) context.addIssue({ code: 'custom', message: '实时修改通道确认重复' });
});
export type LiveCueEditRequest = z.infer<typeof liveCueEditRequestSchema>;
export type LiveCueEditCommit = z.infer<typeof liveCueEditCommitSchema>;
