import { z } from 'zod';
import { ma2ExecutorPageRequestSchema } from './ma2-executor-page';
import { ma2NetworkTargetSchema } from './ma2-bridge';

const button = z.object({ id: z.number().int().min(0).max(2), name: z.string().max(128), active: z.boolean() }).strict();
const fader = z.object({ value: z.number().finite(), min: z.number().finite(), max: z.number().finite(), name: z.string().max(128), text: z.string().max(128) }).strict();
export const ma2LiveRequestSchema = ma2ExecutorPageRequestSchema.extend({ start: z.number().int().min(1).max(76).refine(value => (value - 1) % 15 === 0) }).strict();
export const ma2LiveConnectSchema = ma2LiveRequestSchema.extend({
  username: z.string().trim().min(1).max(256), password: z.string().max(256)
}).strict();
export const ma2LiveSnapshotSchema = z.object({
  page: z.number().int().min(1).max(9999), start: z.number().int().min(1).max(76), readAt: z.number().finite(),
  items: z.array(z.object({
    slot: z.number().int().min(1).max(90), width: z.number().int().min(1).max(5), name: z.string().max(512),
    objectType: z.string().max(128), objectNumber: z.string().max(128), running: z.boolean(), cue: z.string().max(1024),
    blocks: z.array(z.object({ slot: z.number().int().min(1).max(90), fader: fader.nullable(), buttons: z.array(button).max(3) }).strict()).max(5)
  }).strict()).max(15)
}).strict();
export const ma2LiveInputSchema = ma2LiveRequestSchema.extend({
  slot: z.number().int().min(1).max(90), deadlineAt: z.number().finite().positive(),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fader'), value: z.number().finite() }).strict(),
    z.object({ kind: z.literal('button'), id: z.number().int().min(0).max(2), pressed: z.boolean() }).strict()
  ])
}).strict().refine(value => value.slot >= value.start && value.slot < value.start + 15, '执行器不在当前推杆范围内');
export type Ma2LiveRequest = z.infer<typeof ma2LiveRequestSchema>;
export type Ma2LiveConnect = z.infer<typeof ma2LiveConnectSchema>;
export type Ma2LiveSnapshot = z.infer<typeof ma2LiveSnapshotSchema>;
export type Ma2LiveInput = z.infer<typeof ma2LiveInputSchema>;

/** One row of 15 Button executors (101, 116, … 176) the console page shows the console's state for (C1). */
export const ma2ButtonLiveRequestSchema = ma2ExecutorPageRequestSchema.extend({ start: z.number().int().min(101).max(176).refine(value => (value - 101) % 15 === 0) }).strict();
/**
 * What the Button session read for that row, or why there is nothing: `plugin`, the keys go on the console plugin (no
 * Button session, nothing read); `unverified`, the web remote was chosen but the console's Button area was not read back
 * (`reason`); `disconnected`, the Button session is not connected now (it logs in again on the next key, not for this);
 * `stopped`, it dropped and logging in again on its own stopped (`reason`; the next key still logs in). `relogin`: it
 * dropped and logs in again on its own now (C2), attempt `attempt`.
 */
export const ma2ButtonLiveSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('live'), page: z.number().int().min(1).max(9999), start: z.number().int().min(101).max(176), readAt: z.number().finite(),
    items: z.array(z.object({ slot: z.number().int().min(101).max(190), width: z.number().int().min(1).max(15), name: z.string().max(512), objectNumber: z.string().max(128), running: z.boolean(), cue: z.string().max(1024) }).strict()).max(15)
  }).strict(),
  z.object({ kind: z.literal('off'), why: z.enum(['plugin', 'unverified', 'disconnected', 'stopped']), reason: z.string().max(512) }).strict(),
  z.object({ kind: z.literal('relogin'), attempt: z.number().int().min(1).max(10_000) }).strict()
]);
export type Ma2ButtonLiveRequest = z.infer<typeof ma2ButtonLiveRequestSchema>;
export type Ma2ButtonLive = z.infer<typeof ma2ButtonLiveSchema>;

/**
 * One web remote session the console page uses (C2), as the main process knows it: `idle`, not connected in this run for
 * this console (nothing is logged in for it); `connected`; `relogin`, it dropped and logs in again on its own with the
 * saved user, attempt `attempt` now or next (`since`: when it dropped); `stopped`, it stopped and waits for the operator
 * (`limit`: the recovery table's limit was reached; otherwise `reason` says what needs a person).
 */
export const ma2WebRemoteSessionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }).strict(),
  z.object({ kind: z.literal('connected') }).strict(),
  z.object({ kind: z.literal('relogin'), attempt: z.number().int().min(1).max(10_000), since: z.number().finite(), reason: z.string().max(512) }).strict(),
  z.object({ kind: z.literal('stopped'), reason: z.string().max(512), limit: z.boolean() }).strict()
]);
/** The fader view's session and the Button area's, for one console and Show. */
export const ma2WebRemoteStateSchema = z.object({ fader: ma2WebRemoteSessionSchema, buttons: ma2WebRemoteSessionSchema }).strict();
export type Ma2WebRemoteSession = z.infer<typeof ma2WebRemoteSessionSchema>;
export type Ma2WebRemoteState = z.infer<typeof ma2WebRemoteStateSchema>;

/** One executor read back during playback, to confirm the console runs with the timecode. Slots 1–90 are fader executors, 101–190 button executors. */
export const ma2ExecutorObserveRequestSchema = z.object({ network: ma2NetworkTargetSchema, page: z.number().int().min(1).max(9999), slot: z.number().int().min(1).max(190) }).strict()
  .refine(value => value.slot <= 90 || value.slot >= 101, '执行器格位须在 1–90 或 101–190');
export const ma2ExecutorObservationSchema = z.discriminatedUnion('kind', [
  /** The console's web remote was never connected for this console: nothing can be read. */
  z.object({ kind: z.literal('unavailable'), reason: z.string().max(512) }).strict(),
  z.object({ kind: z.literal('empty') }).strict(),
  z.object({ kind: z.literal('executor'), running: z.boolean(), cue: z.string().max(1024), name: z.string().max(512) }).strict()
]);
export type Ma2ExecutorObserveRequest = z.infer<typeof ma2ExecutorObserveRequestSchema>;
export type Ma2ExecutorObservation = z.infer<typeof ma2ExecutorObservationSchema>;
