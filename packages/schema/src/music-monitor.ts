import { z } from 'zod';
import { referenceAudioSourceSchema } from './link-project';
import { lightingTempoSchema } from './lighting';
export const musicMonitorRequestSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(), projectPath: z.string().min(1).max(4096), deviceId: z.string().min(1).max(4096), volume: z.number().finite().min(0).max(1),
  mode: z.enum(['segment', 'metronome']), source: referenceAudioSourceSchema,
  startMs: z.number().finite().nonnegative(), endMs: z.number().finite().positive(), firstBeatMs: z.number().finite().nonnegative(), tempos: z.array(lightingTempoSchema).min(1)
}).strict().refine(value => value.deviceId !== 'default' && value.startMs < value.endMs && value.endMs <= value.source.durationMs, '请选择独立监听设备与有效试听范围');
export type MusicMonitorRequest = z.infer<typeof musicMonitorRequestSchema>;
export const musicMonitorStatusSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(), state: z.enum(['preparing', 'playing', 'stopped', 'error']), message: z.string().max(4096), pid: z.number().int().positive().optional(), title: z.string().max(4096).optional() }).strict();
export type MusicMonitorStatus = z.infer<typeof musicMonitorStatusSchema>;
