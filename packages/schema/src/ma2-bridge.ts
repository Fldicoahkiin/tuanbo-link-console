import { z } from 'zod';
export const ma2NetworkSettingsSchema = z.object({
  host: z.ipv4(), port: z.number().int().min(1).max(65535).default(30000), monitorPort: z.number().int().min(1).max(65535).default(30001),
  username: z.string().trim().min(1).max(256).regex(/^[^"\\\u0000-\u001f\u007f]+$/),
  autoConnect: z.boolean().default(false)
}).strict();
export type Ma2NetworkSettings = z.infer<typeof ma2NetworkSettingsSchema>;
export const ma2NetworkTargetSchema = ma2NetworkSettingsSchema.pick({ host: true, port: true, monitorPort: true, username: true });
export type Ma2NetworkTarget = z.infer<typeof ma2NetworkTargetSchema>;
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
export const ma2NetworkStatusSchema = z.object({
  settings: ma2NetworkSettingsSchema.nullable(), passwordSaved: z.boolean(),
  profiles: z.array(ma2NetworkSettingsSchema).optional(), capabilities: ma2CapabilitiesSchema.nullable().optional(),
  state: z.enum(['disconnected', 'connecting', 'authenticating', 'connected']), version: z.string().nullable(), error: z.string().nullable()
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
export const ma2CompareRequestSchema = z.object({
  document: lightingDocumentSchema, bindingId: z.string().min(1), readback: ma2TimecodePreviewSchema,
  choices: z.array(z.tuple([z.string().min(1), z.string().min(1).nullable()])).refine((entries) => new Set(entries.map(([id]) => id)).size === entries.length, '重复的事件对应选择')
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
  z.object({ target: z.literal('sequence'), sequence: z.number().int().min(1).max(99999), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).refine(value => Number(value) > 0).optional(), action: z.enum(['goto', 'go', 'off']) }).strict(),
  z.object({ target: z.literal('executor'), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).optional(), action: z.enum(['goto', 'go', 'off']) }).strict()
]).superRefine((value, ctx) => { if (value.action === 'goto' && !value.cue) ctx.addIssue({ code: 'custom', message: '播放指定 Cue 需要 Cue 编号' }); });
export type Ma2PlaybackAction = z.infer<typeof ma2PlaybackActionSchema>;
export const ma2PlaybackRequestSchema = z.object({ network: ma2NetworkTargetSchema, action: ma2PlaybackActionSchema, sessionId: z.uuid(), deadlineAt: z.number().finite().positive() }).strict();
export type Ma2PlaybackRequest = z.infer<typeof ma2PlaybackRequestSchema>;
