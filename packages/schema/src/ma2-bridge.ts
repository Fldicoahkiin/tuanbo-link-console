import { z } from 'zod';
export const ma2NetworkSettingsSchema = z.object({
  host: z.ipv4(), port: z.number().int().min(1).max(65535).default(30000), monitorPort: z.number().int().min(1).max(65535).default(30001),
  username: z.string().trim().min(1).max(256).regex(/^[^"\\\u0000-\u001f\u007f]+$/),
  autoConnect: z.boolean().default(false)
}).strict();
export type Ma2NetworkSettings = z.infer<typeof ma2NetworkSettingsSchema>;
export const ma2NetworkTargetSchema = ma2NetworkSettingsSchema.pick({ host: true, port: true, monitorPort: true, username: true });
export type Ma2NetworkTarget = z.infer<typeof ma2NetworkTargetSchema>;
/** The bridge's answer to ASSIGNSEQ: the executor a Sequence was placed on. */
export const ma2SequenceAssignmentSchema = z.object({ sequence: z.number().int().min(1).max(99999), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/) }).strict();
export const ma2NetworkSaveSchema = z.object({ settings: ma2NetworkSettingsSchema, password: z.string().max(256).regex(/^[^"\\\u0000-\u001f\u007f]*$/).optional() }).strict();
export type Ma2NetworkSave = z.infer<typeof ma2NetworkSaveSchema>;
export const ma2NetworkCatalogSchema = z.object({
  format: z.literal(1), active: ma2NetworkSettingsSchema, profiles: z.array(ma2NetworkSettingsSchema).min(1).max(128)
}).strict();
export const ma2DiscoverySchema = z.object({
  hosts: z.array(z.object({ host: z.ipv4(), port: z.number().int(), identity: z.enum(['ma2', 'candidate']) }).strict()),
  ranges: z.array(z.string()), warnings: z.array(z.string())
}).strict();
export type Ma2Discovery = z.infer<typeof ma2DiscoverySchema>;
export const ma2CapabilitiesSchema = z.object({
  version: z.string(), lua: z.string(), plugin: z.boolean(), objects: z.boolean(), files: z.boolean(), message: z.string()
}).strict();
export type Ma2Capabilities = z.infer<typeof ma2CapabilitiesSchema>;
/** A line to the console logging in again on its own after it dropped (C2, M5): which attempt, since when, and why the
 * last one did not get through. */
export const ma2ReloginWaitSchema = z.object({ kind: z.literal('relogin'), attempt: z.number().int().min(1).max(10_000), since: z.number().finite(), reason: z.string().max(512) }).strict();
/** It stopped and waits for the operator (`limit`: the recovery table's limit was reached; otherwise `reason` says what needs a person). */
export const ma2ReloginStoppedSchema = z.object({ kind: z.literal('stopped'), reason: z.string().max(512), limit: z.boolean() }).strict();
export const ma2NetworkStatusSchema = z.object({
  settings: ma2NetworkSettingsSchema.nullable(), passwordSaved: z.boolean(),
  profiles: z.array(ma2NetworkSettingsSchema).optional(), capabilities: ma2CapabilitiesSchema.nullable().optional(),
  state: z.enum(['disconnected', 'connecting', 'authenticating', 'connected']), version: z.string().nullable(), error: z.string().nullable(),
  /** Which connection this is: a new login gets a new number. A check made on an earlier connection does not stand for this one. */
  connection: z.number().int().nonnegative().optional(),
  /** The last connect reached nothing at the saved address: the console is off, unplugged or at another IP. */
  unreachable: z.literal(true).optional(),
  /** The Telnet line dropped during the show and logs in again on its own, or stopped doing so (M5). */
  relogin: z.discriminatedUnion('kind', [ma2ReloginWaitSchema, ma2ReloginStoppedSchema]).optional(),
  /** Logged in, but the console's plugin is missing or old and is installed only when the show has stopped (M5): what uses
   * the plugin waits until then, and this says why. */
  pluginWait: z.string().max(512).optional()
}).strict();
export type Ma2NetworkStatus = z.infer<typeof ma2NetworkStatusSchema>;
import { lightingDocumentSchema, lightingMa2EventMappingSchema, lightingMa2TrackMappingSchema, lightingMa2CueCatalogSchema } from './lighting';

export const ma2BridgeRequestSchema = z.object({
  dataDirectory: z.string().max(4096),
  network: ma2NetworkTargetSchema.optional(),
  operation: z.enum(['PING', 'READ', 'SNAPSHOT', 'APPLY']),
  target: z.number().int().min(1).max(99999),
  expected: z.string().max(32 * 1024 * 1024).default(''),
  desired: z.string().max(32 * 1024 * 1024).default('')
}).strict();
export type Ma2BridgeRequest = z.infer<typeof ma2BridgeRequestSchema>;
export const ma2ReadRequestSchema = ma2BridgeRequestSchema.pick({ dataDirectory: true, network: true, target: true }).extend({ timeOriginMs: z.number().int().min(0).max(86399999).optional() });
export type Ma2ReadRequest = z.infer<typeof ma2ReadRequestSchema>;
export const ma2CreateRequestSchema = ma2ReadRequestSchema.extend({ name: z.string().trim().min(1).max(512).regex(/^[^\u0000-\u001f]+$/) });
export type Ma2CreateRequest = z.infer<typeof ma2CreateRequestSchema>;
export const ma2ExecutorReadRequestSchema = ma2ReadRequestSchema.extend({ executor: z.string().regex(/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/) });
export type Ma2ExecutorReadRequest = z.infer<typeof ma2ExecutorReadRequestSchema>;
export const ma2ExecutorPreviewSchema = z.object({
  target: z.number().int().min(1).max(99999), executor: z.string().regex(/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/),
  assignmentName: z.string().min(1), executorName: z.string().min(1).max(512).regex(/^[^\u0000-\u001f]+$/), readAt: z.string().datetime(), cueCatalog: lightingMa2CueCatalogSchema
}).strict().refine((value) => value.cueCatalog.length === 1, '执行器必须对应一个明确序列');
export type Ma2ExecutorPreview = z.infer<typeof ma2ExecutorPreviewSchema>;
export const ma2TimecodePreviewSchema = z.object({
  timing: z.object({ frameFormat: z.literal('30 FPS'), unit: z.literal('frames-30'), offsetNative: z.string(), absoluteEventTimesMs: z.array(z.number().finite().nonnegative()) }).strict().optional(),
  timeOriginMs: z.number().int().min(0).max(86399999).optional(),
  target: z.number().int().min(1).max(99999), name: z.string(), readAt: z.string().datetime(),
  document: lightingDocumentSchema, sourceXml: z.string().min(1).max(32 * 1024 * 1024),
  mappings: z.array(lightingMa2EventMappingSchema),
  trackMappings: z.array(lightingMa2TrackMappingSchema).optional(),
  cueCatalog: lightingMa2CueCatalogSchema.optional(),
  unconverted: z.array(z.object({ path: z.string(), reason: z.string() }).strict()), warnings: z.array(z.string())
}).strict();
export type Ma2TimecodePreview = z.infer<typeof ma2TimecodePreviewSchema>;
/**
 * How a sync treats the console (2026-11-04, the operator picks):
 * - write: merge keeps Cues the console has beyond the timeline; overwrite leaves the song's own
 *   Sequence holding only the timeline's Cues, with its names and content; direct never deletes a Cue.
 * - consoleChanges: read-back takes what was changed on the console into the timeline; software writes
 *   the timeline over it.
 */
export const ma2WriteModeSchema = z.enum(['merge', 'overwrite', 'direct']);
export type Ma2WriteMode = z.infer<typeof ma2WriteModeSchema>;
export const ma2ConsoleChangesSchema = z.enum(['read-back', 'software']);
export type Ma2ConsoleChanges = z.infer<typeof ma2ConsoleChangesSchema>;
export const ma2CompareRequestSchema = z.object({
  document: lightingDocumentSchema, bindingId: z.string().min(1), readback: ma2TimecodePreviewSchema,
  consoleChanges: ma2ConsoleChangesSchema.optional()
}).strict();
export type Ma2CompareRequest = z.infer<typeof ma2CompareRequestSchema>;
export const ma2ApplyRequestSchema = ma2CompareRequestSchema.extend({
  dataDirectory: z.string().max(4096),
  network: ma2NetworkTargetSchema.optional(),
  timeAlignment: z.enum(['exact', 'nearest-frame']).optional(),
  conflicts: z.array(z.tuple([z.string().min(1), z.enum(['local', 'remote'])])).refine((entries) => new Set(entries.map(([id]) => id)).size === entries.length, '重复的冲突选择')
}).strict();
export type Ma2ApplyRequest = z.infer<typeof ma2ApplyRequestSchema>;
export const ma2ApplyResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('verified'), confirmed: ma2TimecodePreviewSchema, backupFile: z.string().nullable() }).strict(),
  z.object({ status: z.literal('incomplete'), stage: z.enum(['preflight', 'read', 'write', 'verify']), message: z.string(), mayHaveWritten: z.boolean(), backupFile: z.string().nullable() }).strict()
]);
export type Ma2ApplyResult = z.infer<typeof ma2ApplyResultSchema>;

/** Sequence Pool references use their sequence number, never a fabricated executor. */
export const ma2PlaybackActionSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('sequence'), sequence: z.number().int().min(1).max(99999), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/, 'Cue 编号须为 1–9999，最多 3 位小数').refine(value => Number(value) > 0, 'Cue 编号须大于 0').optional(), action: z.enum(['goto', 'go', 'off']) }).strict(),
  z.object({ target: z.literal('executor'), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).optional(), action: z.enum(['goto', 'go', 'off']) }).strict()
]).superRefine((value, ctx) => { if (value.action === 'goto' && !value.cue) ctx.addIssue({ code: 'custom', message: '播放指定 Cue 需要 Cue 编号' }); });
export type Ma2PlaybackAction = z.infer<typeof ma2PlaybackActionSchema>;
export const ma2PlaybackRequestSchema = z.object({ network: ma2NetworkTargetSchema, action: ma2PlaybackActionSchema, sessionId: z.uuid(), deadlineAt: z.number().finite().positive() }).strict();
export type Ma2PlaybackRequest = z.infer<typeof ma2PlaybackRequestSchema>;

export const ma2PreviewStateSchema = z.object({
  selectedCue: z.string().nullable(),
  command: z.enum(['idle', 'sending', 'sent', 'failed']),
  activity: z.discriminatedUnion('state', [
    z.object({ state: z.literal('unsupported'), reason: z.string() }).strict(),
    z.object({ state: z.literal('current'), cue: z.string().nullable(), observedAt: z.number() }).strict(),
    z.object({ state: z.enum(['stale', 'disconnected']), lastCue: z.string().nullable() }).strict()
  ])
}).strict();
export type Ma2PreviewState = z.infer<typeof ma2PreviewStateSchema>;
