import { z } from 'zod';
import { integrationProfileSchema } from './integration-profile';
import { obsPictureItemSchema } from './obs-playback';

const time = z.number().finite().nonnegative();
export const programPlayerStateSchema = z.object({
  playlistId: z.string().optional(), status: z.enum(['stopped', 'preparing', 'playing', 'paused', 'error']),
  itemId: z.string().nullable(), positionMs: time, durationMs: time, volume: z.number().min(0).max(100),
  /** What the song in the player does when it ends, this run: its own end action, else `defaultEndAction`. */
  endAction: z.enum(['stop', 'next', 'loop', 'pause']),
  /** The player bar's 播完后, for every song without its own end action (0.5.9). Absent in older events: the same as
   * `endAction`. */
  defaultEndAction: z.enum(['stop', 'next', 'loop', 'pause']).optional(),
  error: z.string().nullable(), playedItemIds: z.array(z.string()),
  mtcEnabled: z.boolean(), mtcPositionMs: time.nullable(), mtcPortName: z.string().nullable().optional(),
  mtcSentPositionMs: time.nullable().optional(), errorTitle: z.string().nullable(), notice: z.string().nullable(), mtcConnectionFailed: z.boolean(),
  preparation: z.string().nullable().optional(),
  /** Latest live output failure of this song; playback continues. */
  fault: z.string().nullable().optional(),
  /** The parts of this song's picture with something to report, as the picture host lists them (0.5.9 R5). */
  pictureItems: z.array(obsPictureItemSchema).max(256).optional(),
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
/** Which version of the window's project a document is (0.5.9 S7): the document store's `sessionId` (new on every
 * open, new project and revert) and its `revision` within it. */
export const nativeProgramDocumentVersionSchema = z.object({ sessionId: z.string().uuid(), revision: z.number().int().nonnegative() }).strict();
export type NativeProgramDocumentVersion = z.infer<typeof nativeProgramDocumentVersionSchema>;
/** A window's page attaches to the background program (0.5.9 S7): `ownerId` is the page's, made once when it loads. */
export const nativeProgramOpenSchema = z.object({
  version: z.literal(1), ownerId: z.string().uuid(), projectPath: z.string(), revision: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  // Large documents cross contextBridge as text, then undergo project validation in main.
  document: z.string().min(1).max(128 * 1024 * 1024), configuration: nativeProgramConfigurationSchema
}).strict();
export type NativeProgramOpen = z.infer<typeof nativeProgramOpenSchema>;
/** Only what changed since `base` (0.5.9 S9, design 02 §3.3): the songs that changed (whole, as JSON), the ids of the
 * songs removed, the order of the songs when it changed or songs came or went, and the project without its songs
 * (`shell`) when any of it changed. */
/** What one increment may carry; more goes as the whole document (core projectItemsChange). */
export const ITEMS_CHANGE_LIMITS = { songs: 512, songLength: 16 * 1024 * 1024, order: 4096, shellLength: 32 * 1024 * 1024 } as const;
export const nativeProgramItemsChangeSchema = z.object({
  kind: z.literal('items'),
  items: z.array(z.string().min(1).max(ITEMS_CHANGE_LIMITS.songLength)).max(ITEMS_CHANGE_LIMITS.songs),
  removed: z.array(z.string().min(1)).max(ITEMS_CHANGE_LIMITS.songs),
  order: z.array(z.string().min(1)).max(ITEMS_CHANGE_LIMITS.order).optional(),
  shell: z.string().min(1).max(ITEMS_CHANGE_LIMITS.shellLength).optional()
}).strict();
export type NativeProgramItemsChange = z.infer<typeof nativeProgramItemsChangeSchema>;
/** The window's project changed (0.5.9 S7, design 02 §3.3): the attached page sends the new version to the program.
 * `key` names the project; a different project or path is a new open, never a document. `base` is the revision of the
 * same session an increment builds on (S9); a whole document has none. */
export const nativeProgramDocumentSchema = z.object({
  version: z.literal(1), ownerId: z.string().uuid(),
  key: z.object({ sessionId: z.string().uuid(), projectId: z.string().min(1), projectPath: z.string() }).strict(),
  revision: z.number().int().nonnegative(),
  base: z.number().int().nonnegative().nullable(),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('full'), document: z.string().min(1).max(128 * 1024 * 1024) }).strict(),
    nativeProgramItemsChangeSchema
  ])
}).strict().refine(request => (request.change.kind === 'full') === (request.base === null),
  { message: '整份工程不带基准版本，增量必须带基准版本', path: ['base'] });
export type NativeProgramDocument = z.infer<typeof nativeProgramDocumentSchema>;
/** `applied`: the program took the version; `stopped`, no song was held and the next song plays it; `live`, a song is
 * held: it plays on as it started and takes of this version only its saved volume, its own end action and the
 * executors its lighting may run (0.5.9 S8a), the next song plays it. `resync`: the program has no `base` for an
 * increment, the window sends the whole document. */
export const nativeProgramDocumentAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied'), revision: z.number().int().nonnegative(), effect: z.enum(['stopped', 'live']) }).strict(),
  z.object({ kind: z.literal('resync'), reason: z.string() }).strict()
]);
export type NativeProgramDocumentAnswer = z.infer<typeof nativeProgramDocumentAnswerSchema>;
/** How a window's open request attached: a new program, or the program that kept
 * playing after the previous window's renderer exited. `outdated` means that
 * program had a different document than the reloaded window shows: it takes the window's from now on, and the song
 * it holds plays on as it started (0.5.9 S8a). */
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
/** Controls that may start a song (0.5.9 S7): the window sends its newest version before each, and the program takes the
 * versions sent before one before it acts on it. */
const SONG_STARTS: ReadonlySet<NativeProgramOperation['kind']> = new Set(['play', 'seek', 'scrub', 'skip', 'toggle', 'resume', 'midi', 'preload']);
export function nativeProgramStartsSong(kind: NativeProgramOperation['kind']): boolean { return SONG_STARTS.has(kind); }
export const nativeProgramEventSchema = z.object({
  version: z.literal(1), ownerId: z.string().uuid(), sequence: z.number().int().nonnegative(), state: programPlayerStateSchema,
  clock: z.object({ positionMs: time, durationMs: time, ready: z.boolean(), playing: z.boolean(), seeking: z.boolean() }).strict(),
  boundary: z.enum(['pause', 'seek', 'end']).optional(), currentCueId: z.string().nullable(),
  /** The newest version of the project the program holds (0.5.9 S7, S8a): the next song plays it. */
  documentVersion: nativeProgramDocumentVersionSchema,
  /** The version the picture of the song on stage follows (0.5.9 S8a): while a song is held, the one it started with;
   * with none held, `documentVersion`. */
  pictureVersion: nativeProgramDocumentVersionSchema
}).strict();
export type NativeProgramEvent = z.infer<typeof nativeProgramEventSchema>;
/** The quit closed the program the window `ownerId` opened, and the operator went back to the app (返回软件, or a quit
 * step that failed): the window opens a new program, as after a project change, so the next song plays. */
export const nativeProgramClosedSchema = z.object({ version: z.literal(1), ownerId: z.string().uuid() }).strict();
export type NativeProgramClosed = z.infer<typeof nativeProgramClosedSchema>;
