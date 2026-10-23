import { z } from 'zod';
import { integrationProfileSchema } from './integration-profile';
import { linkMediaKindSchema, linkProjectSchema, referenceCanvasTransformSchema, referenceAudioSourceSchema, audioTracksSchema } from './link-project';
import { audioSegmentSchema } from './audio-edit';

export const audioAnalysisRequestSchema = z.object({ projectPath: z.string().min(1), source: referenceAudioSourceSchema }).strict();
export const musicAnalysisRequestSchema = audioAnalysisRequestSchema.extend({ version: z.literal(1), taskId: z.string().uuid() }).strict();
export type MusicAnalysisRequest = z.infer<typeof musicAnalysisRequestSchema>;
export const automaticMusicRequestSchema = musicAnalysisRequestSchema.extend({ device: z.enum(['cpu', 'cuda']) }).strict();
export type AutomaticMusicRequest = z.infer<typeof automaticMusicRequestSchema>;
export const audioRenderRequestSchema = audioAnalysisRequestSchema.extend({ segments: z.array(audioSegmentSchema).min(1).max(10_000), tracks: audioTracksSchema.optional() });

export const linkExternalApplicationIdSchema = z.enum(['obs', 'p1', 'ma2', 'ma3d']);

export const linkProjectNameSchema = z.string().trim().min(1, '工程名称不能为空');
export const linkFilePathSchema = z.string().min(1, '文件路径不能为空');
export const linkOptionalFilePathSchema = linkFilePathSchema.nullable();
/** What the main process needs to protect the open document on quit: reported by the window on every change. */
export const linkDocumentStateSchema = z.object({ version: z.literal(1), dirty: z.boolean(), consoleSynced: z.boolean(),
  name: z.string().max(512).nullable(), projectPath: z.string().min(1).max(4096).nullable(), projectId: z.string().min(1).max(200).nullable() }).strict();
export type LinkDocumentState = z.infer<typeof linkDocumentStateSchema>;
/** Actions in the window that replace the open document ask the same 保存 / 不保存 / 取消 question as quitting. */
export const linkUnsavedChangesReasonSchema = z.enum(['open', 'new', 'restore-archive']);
export const linkUnsavedChangesDecisionSchema = z.enum(['clean', 'saved', 'discarded', 'cancelled']);
export const linkSaveRequestSchema = z.object({ version: z.literal(1), id: z.number().int().positive() }).strict();
export const linkSaveResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved') }).strict(),
  z.object({ status: z.literal('canceled') }).strict(),
  z.object({ status: z.literal('failed'), message: z.string().min(1).max(8192) }).strict()
]);
export const linkSaveResponseSchema = linkSaveRequestSchema.extend({ result: linkSaveResultSchema }).strict();
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

export const linkMediaInspectionPayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  assets: z.array(z.object({ id: z.string().min(1), relativePath: z.string().min(1),
    name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(512)
}).strict();
export type LinkMediaInspectionPayload = z.infer<typeof linkMediaInspectionPayloadSchema>;

const linkProjectAssetFileSchema = z.object({ relativePath: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const linkProjectAssetFilesPayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  files: z.array(linkProjectAssetFileSchema).min(1).max(512)
}).strict();
export type LinkProjectAssetFilesPayload = z.infer<typeof linkProjectAssetFilesPayloadSchema>;
/** Small batches: each file may be a multi-gigabyte video that is hashed and copied. */
export const linkProjectAssetRelinkPayloadSchema = z.object({
  projectPath: linkFilePathSchema,
  sourceDirectory: linkFilePathSchema,
  files: z.array(linkProjectAssetFileSchema).min(1).max(8)
}).strict();
export type LinkProjectAssetRelinkPayload = z.infer<typeof linkProjectAssetRelinkPayloadSchema>;
export const linkProjectAssetRelinkResultSchema = z.array(z.object({
  relativePath: z.string(),
  status: z.enum(['restored', 'present', 'not-found', 'mismatch'])
}).strict());
export type LinkProjectAssetRelinkResult = z.infer<typeof linkProjectAssetRelinkResultSchema>;

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
  peaks: z.array(z.number().finite().min(-1).max(1)).min(1).max(500_000)
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
  result: linkLogResultSchema.optional(),
  limit: z.number().int().min(1).max(5000).optional()
});

export const linkDiagnosticContextSchema = z.record(z.string(), z.unknown());

export type LinkExternalApplicationId = z.infer<typeof linkExternalApplicationIdSchema>;
