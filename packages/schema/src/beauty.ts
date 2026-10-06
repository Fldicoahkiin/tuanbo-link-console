import { z } from 'zod';

const amount = z.number().int().min(0).max(100);
const signed = z.number().int().min(-100).max(100);
export const beautyValuesSchema = z.object({
  smooth: amount, white: amount, texture: amount, blemish: amount, evenSkin: amount,
  darkCircles: amount, nasolabial: amount, shine: amount,
  slim: amount, eye: amount, jaw: amount, cheek: amount, chin: signed,
  forehead: signed, nose: amount, noseLength: signed, eyeDistance: signed, mouth: signed,
  bodySlim: amount, waist: amount, shoulder: signed, neck: amount, legLength: amount, legSlim: amount,
  teeth: amount.default(0), lipstick: amount, blush: amount, lipstickTone: signed.default(0), blushTone: signed.default(0), brow: amount, eyeliner: amount,
  exposure: signed, contrast: signed, saturation: signed, temperature: signed, sharpen: amount
}).strict();
export type BeautyValues = z.infer<typeof beautyValuesSchema>;
export type BeautyParameter = keyof BeautyValues;
export const neutralBeautyValues: BeautyValues = {
  smooth: 0, white: 0, texture: 0, blemish: 0, evenSkin: 0, darkCircles: 0, nasolabial: 0, shine: 0,
  slim: 0, eye: 0, jaw: 0, cheek: 0, chin: 0, forehead: 0, nose: 0, noseLength: 0, eyeDistance: 0, mouth: 0,
  bodySlim: 0, waist: 0, shoulder: 0, neck: 0, legLength: 0, legSlim: 0,
  teeth: 0, lipstick: 0, blush: 0, lipstickTone: 0, blushTone: 0, brow: 0, eyeliner: 0,
  exposure: 0, contrast: 0, saturation: 0, temperature: 0, sharpen: 0
};
export const beautyPresetSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(30), values: beautyValuesSchema
}).strict();
export type BeautyPreset = z.infer<typeof beautyPresetSchema>;
export const beautyLibrarySchema = z.object({
  format: z.literal('tblink-beauty'), version: z.literal(1),
  values: beautyValuesSchema, presets: z.array(beautyPresetSchema).max(30)
}).strict().refine(value => new Set(value.presets.map(preset => preset.id)).size === value.presets.length, '预设 ID 重复');
export type BeautyLibrary = z.infer<typeof beautyLibrarySchema>;

export const beautyTargetSchema = z.object({ sourceName: z.string().min(1).max(512), filterName: z.string().min(1).max(512) }).strict();
export const beautyBasicValuesSchema = beautyValuesSchema.pick({ smooth: true, white: true, slim: true, eye: true,
  exposure: true, contrast: true, saturation: true, temperature: true, sharpen: true, texture: true, evenSkin: true, shine: true,
  nose: true, noseLength: true, mouth: true, eyeDistance: true, teeth: true, lipstick: true, lipstickTone: true, blushTone: true, brow: true, eyeliner: true, blush: true,
  jaw: true, cheek: true, chin: true, forehead: true, darkCircles: true, nasolabial: true, blemish: true, bodySlim: true, waist: true, shoulder: true, neck: true, legSlim: true, legLength: true });
export const beautyRuntimeKeys = ['smooth', 'white', 'slim', 'eye', 'exposure', 'contrast', 'saturation', 'temperature', 'sharpen', 'texture', 'evenSkin', 'shine', 'nose', 'noseLength', 'mouth', 'eyeDistance', 'teeth', 'lipstick', 'lipstickTone', 'blushTone', 'brow', 'eyeliner', 'blush', 'jaw', 'cheek', 'chin', 'forehead', 'darkCircles', 'nasolabial', 'blemish', 'bodySlim', 'waist', 'shoulder', 'neck', 'legSlim', 'legLength'] as const;
export const beautyApplySchema = beautyTargetSchema.extend({ values: beautyBasicValuesSchema }).strict();
export const beautyFilterStateSchema = z.object({
  sourceName: z.string(), filterName: z.string(), enabled: z.boolean(), liveMode: z.boolean(),
  uniform: z.boolean(), values: beautyBasicValuesSchema
}).strict();
export type BeautyTarget = z.infer<typeof beautyTargetSchema>;
export const beautyComparisonFrameSchema = z.object({ width: z.number().int().min(1).max(640), height: z.number().int().min(1).max(640),
  sequence: z.number().int().positive(), timestampMs: z.number().int().positive().safe(), original: z.instanceof(Uint8Array), processed: z.instanceof(Uint8Array)
}).strict().refine(frame => frame.original.byteLength === frame.width * frame.height * 4 && frame.processed.byteLength === frame.width * frame.height * 4, '美颜对比像素长度无效');
export type BeautyComparisonFrame = z.infer<typeof beautyComparisonFrameSchema>;
export type BeautyApply = z.infer<typeof beautyApplySchema>;
export type BeautyFilterState = z.infer<typeof beautyFilterStateSchema>;
export const beautyStartSchema = z.object({ sourceName: z.string().min(1).max(512) }).strict();
export type BeautyStart = z.infer<typeof beautyStartSchema>;
export const beautyRuntimeSchema = z.object({
  phase: z.enum(['idle', 'starting', 'waiting', 'tracking', 'error']), sourceName: z.string().nullable(),
  filterName: z.string().nullable(), faces: z.number().int().min(0).max(6), message: z.string()
}).strict();
export type BeautyRuntimeState = z.infer<typeof beautyRuntimeSchema>;
