import { z } from 'zod';

export const nativeMidiCheckSchema = z.object({ version: z.literal(1), portName: z.string().min(1).max(256).refine(value => !value.includes('\0')) }).strict();
export type NativeMidiCheck = z.infer<typeof nativeMidiCheckSchema>;

const generation = z.number().int().min(1).max(0xffffffff);
const timeMs = z.number().finite().min(0).max(86_399_999);
const audioDeviceIdSchema = z.string().min(1).max(1023).refine(value => !value.includes('\0'));
const envelope = { protocol: z.literal(4), requestId: generation, generation };
const fadeDuration = z.number().finite().min(0).max(30000);
export const playbackAnalysisSchema = z.object({
  fftSize: z.literal(2048), spectrum: z.array(z.number().int().min(0).max(255)).length(1024),
  peaks: z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)])
}).strict();
export type PlaybackAnalysis = z.infer<typeof playbackAnalysisSchema>;
export const nativePlaybackCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('prepare'), pcmPath: z.string().min(1).max(4096).refine(value => !value.includes('\0')),
    audioDeviceId: audioDeviceIdSchema.optional(), pcmBaseMs: timeMs.optional(), streaming: z.boolean().optional(),
    sampleRate: z.union([z.literal(44100), z.literal(48000)]), midiDevice: z.number().int().min(0).max(65535).nullable(),
    frameRate: z.union([z.literal(24), z.literal(25), z.literal(30)]), startMs: timeMs, endMs: timeMs,
    offsetMs: timeMs, volume: z.number().finite().min(0).max(1) }).strict().refine(value => (value.pcmBaseMs ?? 0) <= value.startMs && value.endMs > value.startMs && value.endMs + value.offsetMs < 86_400_000, '播放范围或时间码超过一天'),
  z.object({ ...envelope, kind: z.literal('play') }).strict(),
  z.object({ ...envelope, kind: z.literal('pause') }).strict(),
  z.object({ ...envelope, kind: z.literal('seek'), positionMs: timeMs }).strict(),
  z.object({ ...envelope, kind: z.literal('stop') }).strict(),
  z.object({ ...envelope, kind: z.literal('stop-mtc') }).strict(),
  z.object({ ...envelope, kind: z.literal('volume'), volume: z.number().finite().min(0).max(1), durationMs: fadeDuration.optional() }).strict(),
  z.object({ ...envelope, kind: z.literal('close') }).strict()
]);
export type NativePlaybackCommand = z.infer<typeof nativePlaybackCommandSchema>;
export const nativePlaybackEventSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(4), kind: z.literal('ack'), requestId: generation, generation,
    ok: z.boolean(), code: z.number().int() }).strict(),
  z.object({ protocol: z.literal(4), kind: z.literal('clock'), generation: z.number().int().nonnegative(),
    state: z.enum(['empty', 'ready', 'playing', 'paused', 'stopped', 'ended', 'error']),
    positionMs: z.number().finite().nonnegative(), qpc100ns: z.string().regex(/^\d+$/), clockFrequency: z.number().nonnegative(),
    sampleRate: z.number().int().nonnegative(), underruns: z.number().int().nonnegative(),
    midiSent: z.number().int().nonnegative(), midiError: z.number().int(), audioError: z.number().int(),
    maxMidiLatenessMs: z.number().finite().nonnegative(), bufferedFrames: z.number().int().nonnegative(),
    midiTiming: z.object({ wakeGapMs: z.number().finite().nonnegative(), midiLockWaitMs: z.number().finite().nonnegative(),
      audioLockWaitMs: z.number().finite().nonnegative(), sendMs: z.number().finite().nonnegative() }).strict().optional(),
    gain: z.number().finite().min(0).max(1), analysis: playbackAnalysisSchema }).strict(),
  z.object({ protocol: z.literal(4), kind: z.literal('ready'), pid: z.number().int().positive(), title: z.string().min(1), windowClass: z.literal('Static') }).strict()
]);
export type NativePlaybackEvent = z.infer<typeof nativePlaybackEventSchema>;

export const nativePlaybackDevicesSchema = z.object({ protocol: z.literal(4),
  audio: z.array(z.object({ id: audioDeviceIdSchema, name: z.string().min(1).max(2048), isDefault: z.boolean() }).strict()).max(256),
  midiOutputs: z.array(z.object({ id: z.number().int().min(0).max(65535), name: z.string().min(1).max(256) }).strict()).max(65536)
}).strict();
export type NativePlaybackDevices = z.infer<typeof nativePlaybackDevicesSchema>;
export const nativeDeviceResponseSchema = z.object({ version: z.literal(1), requestId: generation,
  devices: nativePlaybackDevicesSchema, ok: z.boolean() }).strict();

/** Immutable audio portion of the running program; authored edits create a new
 * revision instead of mutating this instance underneath the output clock. */
export const playbackSnapshotSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1).max(256), itemId: z.string().min(1).max(256), revision: z.number().int().nonnegative(),
  audio: z.object({ relativePath: z.string().min(1).max(4096).refine(value => !value.includes('\0')),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), durationMs: timeMs }).strict(),
  startMs: timeMs, endMs: timeMs, positionMs: timeMs, offsetMs: timeMs,
  frameRate: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  sampleRate: z.union([z.literal(44100), z.literal(48000)]), volume: z.number().finite().min(0).max(1)
}).strict().refine(value => value.startMs < value.endMs && value.endMs <= value.audio.durationMs
  && value.positionMs >= value.startMs && value.positionMs < value.endMs && value.offsetMs + value.endMs < 86_400_000,
'播放快照的范围或原始偏移无效');
export type PlaybackSnapshot = z.infer<typeof playbackSnapshotSchema>;

const playerSession = { version: z.literal(1), sessionId: z.string().uuid(), generation };
export const nativePlayerPrepareSchema = z.object({ ...playerSession, projectPath: z.string().min(1).max(4096), snapshot: playbackSnapshotSchema,
  nextSnapshot: playbackSnapshotSchema.optional(),
  audioDeviceId: audioDeviceIdSchema, midiPortName: z.string().min(1).max(256).nullable(), autoDetectMtc: z.boolean().optional() }).strict()
  .refine(value => !value.nextSnapshot || value.nextSnapshot.projectId === value.snapshot.projectId
    && value.nextSnapshot.revision === value.snapshot.revision && value.nextSnapshot.sampleRate === value.snapshot.sampleRate,
  '下一节目必须属于同一工程修订和音频采样率');
export type NativePlayerPrepare = z.infer<typeof nativePlayerPrepareSchema>;
export const nativePlayerControlSchema = z.discriminatedUnion('kind', [
  z.object({ ...playerSession, kind: z.literal('play') }).strict(),
  z.object({ ...playerSession, kind: z.literal('pause') }).strict(),
  z.object({ ...playerSession, kind: z.literal('seek'), positionMs: timeMs }).strict(),
  z.object({ ...playerSession, kind: z.literal('stop') }).strict(),
  z.object({ ...playerSession, kind: z.literal('stop-mtc') }).strict(),
  z.object({ ...playerSession, kind: z.literal('volume'), volume: z.number().finite().min(0).max(1), durationMs: fadeDuration.optional() }).strict()
]);
export type NativePlayerControl = z.infer<typeof nativePlayerControlSchema>;
export const nativePlayerStatusSchema = z.object({ ...playerSession, itemId: z.string().min(1).max(256),
  status: z.enum(['preparing', 'ready', 'playing', 'paused', 'stopped', 'ended', 'error']), positionMs: timeMs,
  offsetMs: timeMs, sampleRate: z.union([z.literal(44100), z.literal(48000)]),
  enginePid: z.number().int().positive().nullable(), engineTitle: z.string().max(256).nullable(),
  mtcPortName: z.string().max(256).nullable(), mtcSent: z.number().int().nonnegative(),
  audioError: z.string().nullable(), mtcError: z.string().nullable(), underruns: z.number().int().nonnegative(),
  gain: z.number().finite().min(0).max(1), analysis: playbackAnalysisSchema.nullable()
}).strict();
export type NativePlayerStatus = z.infer<typeof nativePlayerStatusSchema>;

export const outputHealthSchema = z.object({
  channel: z.enum(['audio', 'obs', 'mtc', 'lighting']), generation,
  state: z.enum(['ready', 'running', 'not-participating', 'failed', 'stale', 'write-unknown']),
  reason: z.string().nullable(), updatedAt: z.number().finite().nonnegative()
}).strict();
export type OutputHealth = z.infer<typeof outputHealthSchema>;
