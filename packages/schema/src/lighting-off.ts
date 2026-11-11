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
 * - `p1`: following P1, the operator pressed stop in the app (00-order §8 item 4): `stop` switches the song's executors
 *   off and sends every Off still owed once more, without stopping P1. `start` as for a preview.
 */
export const lightingOffRequestSchema = z.object({
  version: z.literal(1),
  source: z.enum(['preview', 'p1']),
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
