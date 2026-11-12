import { z } from 'zod';
import { lightingDocumentSchema } from './lighting';

/** The rundown song a lights-off is for, as a failure names it. */
export const lightingOffSongSchema = z.object({ itemId: z.string().min(1).max(200), title: z.string().max(500) }).strict();

/**
 * The window tells the main process's lights-off ledger (lighting-off-service.ts, design 01 R13) about lighting only the
 * window runs (link:lighting-off). Only the song's lighting document goes over IPC: which executors that means, and what
 * to switch off, is decided in the main process.
 * - `preview`: the editor's or the lighting workbench's own preview. `start`: its timecode runs the song's executors
 *   now, so nothing owed for them is sent. `pause`: its timecode no longer runs (paused, or it failed to start): the
 *   executors are not in use by the window any more, and nothing is owed, the lights stay as they are until the
 *   operator stops. `stop`: the operator stopped it, every executor of the song is owed an Off.
 * Following P1 is the main process's own (0.5.9 P4): its stop goes to the ledger there (LightingOffService.followStop).
 */
export const lightingOffRequestSchema = z.object({
  version: z.literal(1),
  source: z.literal('preview'),
  phase: z.enum(['start', 'pause', 'stop']),
  document: lightingDocumentSchema,
  song: lightingOffSongSchema.nullable()
}).strict();
export type LightingOffRequest = z.infer<typeof lightingOffRequestSchema>;

/** The Offs of the request that did not go out, with why: they stay owed in the ledger. */
export const lightingOffResultSchema = z.object({
  failed: z.array(z.object({ song: lightingOffSongSchema.nullable(), reason: z.string().max(8192) }).strict()).max(512)
}).strict();
export type LightingOffResult = z.infer<typeof lightingOffResultSchema>;

const executorSchema = z.string().regex(/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/);
/** What the status details show of the lights-off read-back (M8, packages/core lighting-off-ledger.ts `check`), sent on
 * every change (link:lighting-off-check) and read once by a new page (link:lighting-off-check-get): the Offs the console
 * confirmed but read back still running, and the ones read that could not be confirmed. */
export const lightingOffCheckSchema = z.object({
  running: z.array(z.object({ executor: executorSchema, song: lightingOffSongSchema.nullable() }).strict()).max(512),
  unconfirmed: z.array(z.object({ executor: executorSchema, song: lightingOffSongSchema.nullable(), reason: z.string().max(8192) }).strict()).max(512)
}).strict();
export type LightingOffCheckState = z.infer<typeof lightingOffCheckSchema>;
