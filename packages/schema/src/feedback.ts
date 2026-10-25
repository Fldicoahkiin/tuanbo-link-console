import { z } from 'zod';
import { licenseMachineCodeSchema } from './license';

/**
 * In-app problem feedback: the desktop app sends a short report, then (when the server grants an upload slot)
 * the gzip diagnostic package for it. Shared by the desktop app and the licensing server.
 */
export const FEEDBACK_LIMITS = {
  descriptionMin: 5,
  descriptionMax: 2000,
  contactMax: 100,
  /** A licensed machine's diagnostic package; an unlicensed one gets `unlicensedAttachmentBytes`. */
  attachmentBytes: 8 * 1024 * 1024,
  unlicensedAttachmentBytes: 2 * 1024 * 1024
} as const;

export const feedbackCategorySchema = z.enum(['playback', 'picture', 'lighting', 'timecode', 'license', 'other']);
export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>;
export const feedbackCategoryLabels: Readonly<Record<FeedbackCategory, string>> = {
  playback: '播放与音频', picture: '画面与 OBS', lighting: '灯光与 MA2', timecode: '时间码与 MIDI', license: '激活与更新', other: '界面与其他'
};

const shortText = (max: number) => z.string().max(max);
export const feedbackDescriptionSchema = z.string().trim()
  .min(FEEDBACK_LIMITS.descriptionMin, `请至少写 ${FEEDBACK_LIMITS.descriptionMin} 个字说明现象`)
  .max(FEEDBACK_LIMITS.descriptionMax, `现象说明最多 ${FEEDBACK_LIMITS.descriptionMax} 字`);
export const feedbackContactSchema = z.string().trim().max(FEEDBACK_LIMITS.contactMax, `联系方式最多 ${FEEDBACK_LIMITS.contactMax} 字`);
/** What the console shows next to the report without opening the diagnostic package. */
export const feedbackEnvironmentSchema = z.object({
  os: shortText(160), obs: shortText(80), ma2: shortText(80), playback: shortText(160),
  /** This machine's license state, or why it could not be read. */
  license: shortText(160)
}).strict();
export type FeedbackEnvironment = z.infer<typeof feedbackEnvironmentSchema>;
const appVersionSchema = z.string().max(40).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * POST /v1/feedback. `license` is this machine's signed license, when it has one; the server checks it.
 * `machineCode` is null only when this machine's license could not be read; `environment.license` says why.
 */
export const feedbackSubmissionSchema = z.object({
  product: z.literal('tuanbo-link-console'),
  version: appVersionSchema,
  category: feedbackCategorySchema,
  description: feedbackDescriptionSchema,
  contact: feedbackContactSchema,
  occurredAt: z.string().datetime(),
  machineCode: licenseMachineCodeSchema.nullable(),
  license: z.string().max(16384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).nullable(),
  environment: feedbackEnvironmentSchema,
  diagnostic: z.object({ bytes: z.number().int().min(1).max(FEEDBACK_LIMITS.attachmentBytes), sha256: sha256Schema }).strict().nullable()
}).strict();
export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;

export const feedbackNumberSchema = z.string().regex(/^FB-\d{8}-[A-Z0-9]{4}$/);
export const feedbackUploadTokenSchema = z.string().regex(/^TBF-[A-F0-9]{64}$/);
/** The answer to a submission: the number to quote to support, and an upload slot for the package, if granted. */
export const feedbackReceiptSchema = z.object({
  id: z.string().uuid(),
  number: feedbackNumberSchema,
  upload: z.object({ token: feedbackUploadTokenSchema, expiresAt: z.string().datetime() }).strict().nullable(),
  /** Why the package was not accepted although one was declared (size or server space); null otherwise. */
  attachmentIssue: z.string().max(300).nullable()
}).strict();
export type FeedbackReceipt = z.infer<typeof feedbackReceiptSchema>;
/** PUT /v1/feedback/<id>/diagnostic. */
export const feedbackUploadResponseSchema = z.object({ received: z.literal(true), bytes: z.number().int().positive() }).strict();

/** Window → main: the form. The main process adds the machine, license, version and diagnostic package. */
export const linkFeedbackDraftSchema = z.object({
  category: feedbackCategorySchema,
  description: feedbackDescriptionSchema,
  contact: feedbackContactSchema,
  occurredAt: z.string().datetime(),
  includeDiagnostics: z.boolean(),
  includeMa2: z.boolean(),
  /** The window's own view (project summary, connections), as in a diagnostic export. */
  context: z.record(z.string(), z.unknown())
}).strict();
export type LinkFeedbackDraft = z.infer<typeof linkFeedbackDraftSchema>;

export const linkFeedbackResultSchema = z.discriminatedUnion('outcome', [
  /** The server holds the report; `attachment` says what became of the diagnostic package. */
  z.object({ outcome: z.literal('submitted'), number: feedbackNumberSchema, attachment: z.enum(['uploaded', 'none', 'refused', 'failed']), attachmentIssue: z.string().nullable() }).strict(),
  /** Saved to a file the operator chose, for sending by hand. */
  z.object({ outcome: z.literal('saved'), path: z.string() }).strict(),
  z.object({ outcome: z.literal('cancelled') }).strict()
]);
export type LinkFeedbackResult = z.infer<typeof linkFeedbackResultSchema>;
