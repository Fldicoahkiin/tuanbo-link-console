import { z } from 'zod';
import { integrationProfileSchema } from './integration-profile';

const time = z.number().finite().nonnegative();
export const programPlayerStateSchema = z.object({
  playlistId: z.string().optional(), status: z.enum(['stopped', 'preparing', 'playing', 'paused', 'error']),
  itemId: z.string().nullable(), positionMs: time, durationMs: time, volume: z.number().min(0).max(100),
  endAction: z.enum(['stop', 'next', 'loop', 'pause']), error: z.string().nullable(), playedItemIds: z.array(z.string()),
  mtcEnabled: z.boolean(), mtcPositionMs: time.nullable(), mtcPortName: z.string().nullable().optional(),
  mtcSentPositionMs: time.nullable().optional(), errorTitle: z.string().nullable(), notice: z.string().nullable(), mtcConnectionFailed: z.boolean(),
  preparation: z.string().nullable().optional(),
  /** Latest live output failure of this song; playback continues. */
  fault: z.string().nullable().optional()
}).strict();
export type ProgramPlayerState = z.infer<typeof programPlayerStateSchema>;
export const nativeProgramConfigurationSchema = z.object({
  outputDeviceId: z.string().min(1), audioSampleRate: z.union([z.literal(44100), z.literal(48000)]).optional(),
  mtcPortName: z.string().nullable(), preload: z.boolean().optional(), fadeInMs: time.optional(), fadeOutMs: time.optional(),
  lightingProfile: integrationProfileSchema.nullable().optional(), preciseSeeking: z.boolean()
}).strict();
export type NativeProgramConfiguration = z.infer<typeof nativeProgramConfigurationSchema>;
export const nativeProgramOpenSchema = z.object({
  version: z.literal(1), ownerId: z.string().uuid(), projectPath: z.string(), revision: z.number().int().nonnegative(),
  // Large documents cross contextBridge as text, then undergo project validation in main.
  document: z.string().min(1).max(128 * 1024 * 1024), configuration: nativeProgramConfigurationSchema
}).strict();
export type NativeProgramOpen = z.infer<typeof nativeProgramOpenSchema>;
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play'), itemId: z.string(), positionMs: time.optional(), paused: z.boolean().optional() }).strict(),
  z.object({ kind: z.enum(['pause', 'resume', 'stop', 'reset', 'toggle', 'toggleMtc', 'close']) }).strict(),
  z.object({ kind: z.literal('seek'), positionMs: time }).strict(),
  z.object({ kind: z.literal('scrub'), itemId: z.string(), positionMs: time }).strict(),
  z.object({ kind: z.literal('skip'), direction: z.union([z.literal(-1), z.literal(1)]) }).strict(),
  z.object({ kind: z.literal('volume'), volume: z.number().min(0).max(100) }).strict(),
  z.object({ kind: z.literal('endAction'), endAction: z.enum(['stop', 'next', 'loop', 'pause']) }).strict(),
  z.object({ kind: z.literal('playlist'), playlistId: z.string() }).strict(),
  z.object({ kind: z.literal('preload'), itemId: z.string() }).strict(),
  z.object({ kind: z.literal('fade'), out: z.boolean() }).strict(),
  z.object({ kind: z.literal('midi'), bytes: z.array(z.number().int().min(0).max(255)).max(65536) }).strict(),
  z.object({ kind: z.enum(['freeze', 'unavailable', 'runtimeUnavailable']), message: z.string() }).strict(),
  z.object({ kind: z.literal('configure'), configuration: nativeProgramConfigurationSchema }).strict()
]);
export const nativeProgramControlSchema = z.object({ version: z.literal(1), ownerId: z.string().uuid(), operation,
  configuration: nativeProgramConfigurationSchema.optional() }).strict();
export type NativeProgramControl = z.infer<typeof nativeProgramControlSchema>;
export type NativeProgramOperation = NativeProgramControl['operation'];
export const nativeProgramEventSchema = z.object({
  version: z.literal(1), ownerId: z.string().uuid(), sequence: z.number().int().nonnegative(), state: programPlayerStateSchema,
  clock: z.object({ positionMs: time, durationMs: time, ready: z.boolean(), playing: z.boolean(), seeking: z.boolean() }).strict(),
  boundary: z.enum(['pause', 'seek', 'end']).optional(), currentCueId: z.string().nullable()
}).strict();
export type NativeProgramEvent = z.infer<typeof nativeProgramEventSchema>;
