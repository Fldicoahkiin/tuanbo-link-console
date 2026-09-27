import { z } from 'zod';
import { integrationProfileSchema } from './integration-profile';
import { linkMediaKindSchema, linkProjectSchema, referenceCanvasTransformSchema, referenceAudioSourceSchema, audioTracksSchema } from './link-project';
import { audioSegmentSchema } from './audio-edit';

export const audioAnalysisRequestSchema = z.object({ projectPath: z.string().min(1), source: referenceAudioSourceSchema }).strict();
export const audioRenderRequestSchema = audioAnalysisRequestSchema.extend({ segments: z.array(audioSegmentSchema).min(1).max(10_000), tracks: audioTracksSchema.optional() });

export const linkExternalApplicationIdSchema = z.enum(['obs', 'p1']);

export const linkProjectNameSchema = z.string().trim().min(1, '工程名称不能为空');
export const linkFilePathSchema = z.string().min(1, '文件路径不能为空');
export const linkOptionalFilePathSchema = linkFilePathSchema.nullable();
export const linkDocumentDirtySchema = z.boolean();
export const linkRuntimeActiveSchema = z.boolean();
export const linkInternalAudioCaptureSchema = z.object({ enabled: z.boolean(), sceneNames: z.array(z.string().min(1)).max(1000).optional() });
export const linkWindowControlActionSchema = z.enum(['minimize', 'toggleMaximize', 'close']);

export const linkManagedMediaEventSchema = z.object({
  id: z.string().min(1),
  phase: z.enum(['start', 'stop']),
  frameNumber: z.number().int().nonnegative(),
  itemId: z.string().min(1),
  clipId: z.string().min(1),
  layerId: z.string().min(1),
  layerIndex: z.number().int().nonnegative(),
  layerCount: z.number().int().positive(),
  sourceName: z.string().min(1),
  sceneName: z.string().min(1).optional(),
  deferSceneSwitch: z.boolean().optional(),
  assetId: z.string().min(1),
  assetName: z.string().min(1),
  assetKind: z.enum(['video', 'image', 'audio']),
  relativePath: z.string().min(1),
  sourceOffsetMs: z.number().int().nonnegative(),
  embeddedAudioEnabled: z.boolean(),
  transform: referenceCanvasTransformSchema
});

export const linkManagedMediaExecutionPayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  event: linkManagedMediaEventSchema
});

export const linkReferenceAudioImportPayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  sourcePath: linkFilePathSchema,
  durationMs: z.number().int().positive()
});

export const linkReferenceAudioResolvePayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  relativePath: z.string().min(1)
});

export const linkMediaAssetImportPayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  sourcePath: linkFilePathSchema,
  name: z.string().trim().min(1),
  kind: linkMediaKindSchema,
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});

export const linkMediaAssetResolvePayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  relativePath: z.string().min(1)
});

export const linkMediaPreviewPayloadSchema = linkMediaAssetResolvePayloadSchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: linkMediaKindSchema
});

export const linkP1ProjectImportPayloadSchema = z.object({
  p1ProjectPath: linkFilePathSchema,
  linkProjectPath: linkFilePathSchema,
  progressId: z.string().uuid().optional()
});

export const linkP1ProjectImportProgressSchema = z.object({
  id: z.string().uuid(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  song: z.string(),
  state: z.enum(['starting', 'imported', 'skipped'])
}).strict().refine(value => value.completed <= value.total);
export type LinkP1ProjectImportProgress = z.infer<typeof linkP1ProjectImportProgressSchema>;

export const linkP1ProjectExportPreviewPayloadSchema = z.object({
  p1ProjectPath: linkFilePathSchema,
  linkProjectPath: linkFilePathSchema,
  project: linkProjectSchema
});

export const linkP1ProjectExportPayloadSchema = linkP1ProjectExportPreviewPayloadSchema.extend({
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const linkObsSourcePreviewPayloadSchema = z.object({
  sourceName: z.string().trim().min(1),
  width: z.number().int().min(8).max(7680).optional(),
  height: z.number().int().min(8).max(7680).optional()
}).superRefine((payload, context) => {
  if ((payload.width === undefined) !== (payload.height === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'OBS 预览宽高必须同时提供或同时省略' });
  }
});

export const linkWaveformCachePayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const linkWaveformCacheSavePayloadSchema = linkWaveformCachePayloadSchema.extend({
  peaks: z.array(z.number().finite().min(-1).max(1)).min(1)
});

export const linkWaveformGeneratePayloadSchema = linkWaveformCachePayloadSchema.extend({
  url: z.string().regex(/^tblink-asset:\/\/local\/[a-f0-9-]+$/),
  durationMs: z.number().finite().positive().max(86400000)
});

export const linkIntegrationProfileSavePayloadSchema = z.object({
  profile: integrationProfileSchema,
  obsPassword: z.string().optional()
});

export const linkLogResultSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped']);

export const linkLogRecordSchema = z.object({
  level: z.enum(['info', 'warning', 'error']),
  category: z.enum(['state', 'action', 'device', 'preflight', 'operator', 'system']),
  message: z.string().min(1),
  projectId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  cueId: z.string().min(1).optional(),
  actionId: z.string().min(1).optional(),
  executionId: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  result: linkLogResultSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const linkLogFilterSchema = z.object({
  sessionId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  cueId: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  result: linkLogResultSchema.optional()
});

export const linkDiagnosticContextSchema = z.record(z.string(), z.unknown());

export type LinkExternalApplicationId = z.infer<typeof linkExternalApplicationIdSchema>;
