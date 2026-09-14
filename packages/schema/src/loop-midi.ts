import { z } from 'zod';

export const loopMidiActionSchema = z.enum(['detect', 'start', 'download']);
export const loopMidiStatusSchema = z.object({
  state: z.enum(['missing', 'installed', 'running']),
  executablePath: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  startTime: z.string().nullable()
});
export type LoopMidiStatus = z.infer<typeof loopMidiStatusSchema>;
