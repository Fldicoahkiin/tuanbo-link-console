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
  fault: z.string().nullable().optional(),
  /** The temporary volume MIDI CC7 set for this run of the song (2026-11-09): not saved, gone when the song changes
   * or stops. Null or absent: the song plays at its own saved volume. */
  volumeOverride: z.number().min(0).max(100).nullable().optional()
}).strict();
export type ProgramPlayerState = z.infer<typeof programPlayerStateSchema>;
export const nativeProgramConfigurationSchema = z.object({
  outputDeviceId: z.string().min(1), audioSampleRate: z.union([z.literal(44100), z.literal(48000)]).optional(),
  mtcPortName: z.string().nullable(), mtcSendMode: z.enum(['standard', 'quarter-frames']).optional(), preload: z.boolean().optional(), fadeInMs: time.optional(), fadeOutMs: time.optional(),
  lightingProfile: integrationProfileSchema.nullable().optional(), preciseSeeking: z.boolean()
}).strict();
export type NativeProgramConfiguration = z.infer<typeof nativeProgramConfigurationSchema>;
export const nativeProgramOpenSchema = z.object({
  version: z.literal(1), ownerId: z.string().uuid(), projectPath: z.string(), revision: z.number().int().nonnegative(),
  // Large documents cross contextBridge as text, then undergo project validation in main.
  document: z.string().min(1).max(128 * 1024 * 1024), configuration: nativeProgramConfigurationSchema
}).strict();
export type NativeProgramOpen = z.infer<typeof nativeProgramOpenSchema>;
/** How a window's open request attached: a new program, or the program that kept
 * playing after the previous window's renderer exited. `outdated` means that
 * program plays a different document than the reloaded window shows. */
export type NativeProgramAttachment = 'opened' | 'adopted' | 'outdated';
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play'), itemId: z.string(), positionMs: time.optional(), paused: z.boolean().optional() }).strict(),
  z.object({ kind: z.enum(['pause', 'resume', 'stop', 'reset', 'toggle', 'toggleMtc', 'close']) }).strict(),
  z.object({ kind: z.literal('seek'), positionMs: time }).strict(),
  z.object({ kind: z.literal('scrub'), itemId: z.string(), positionMs: time }).strict(),
  z.object({ kind: z.literal('skip'), direction: z.union([z.literal(-1), z.literal(1)]) }).strict(),
  // The player-bar slider while it is dragged: heard at once, saved nowhere (song volume, 2026-11-09).
  z.object({ kind: z.literal('volume'), volume: z.number().min(0).max(100), preview: z.literal(true) }).strict(),
  // A song's saved volume changed in the window's project (useSongVolumeSync); the program plays it from now on.
  z.object({ kind: z.literal('songVolume'), itemId: z.string().min(1), volume: z.number().min(0).max(100) }).strict(),
  z.object({ kind: z.literal('endAction'), endAction: z.enum(['stop', 'next', 'loop', 'pause']) }).strict(),
  z.object({ kind: z.literal('playlist'), playlistId: z.string() }).strict(),
  z.object({ kind: z.literal('preload'), itemId: z.string() }).strict(),
  z.object({ kind: z.literal('fade'), out: z.boolean() }).strict(),
  z.object({ kind: z.literal('midi'), bytes: z.array(z.number().int().min(0).max(255)).max(65536) }).strict(),
  z.object({ kind: z.enum(['freeze', 'unavailable', 'runtimeUnavailable', 'fault']), message: z.string() }).strict(),
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
/** The quit closed the program the window `ownerId` opened, and the operator went back to the app (返回软件, or a quit
 * step that failed): the window opens a new program, as after a project change, so the next song plays. */
export const nativeProgramClosedSchema = z.object({ version: z.literal(1), ownerId: z.string().uuid() }).strict();
export type NativeProgramClosed = z.infer<typeof nativeProgramClosedSchema>;
