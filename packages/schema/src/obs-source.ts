import { z } from 'zod';

export const obsSourceKinds = {
  camera: { label: '视频采集设备', inputKind: 'dshow_input', property: 'video_device_id' },
  media: { label: '媒体', inputKind: 'ffmpeg_source', property: '' },
  image: { label: '图片来源', inputKind: 'image_source', property: '' },
  browser: { label: '浏览器', inputKind: 'browser_source', property: '' },
  window: { label: '窗口采集', inputKind: 'window_capture', property: 'window' },
  text: { label: '文本', inputKind: 'text_gdiplus_v3', property: '' },
  display: { label: '显示器采集', inputKind: 'monitor_capture', property: 'monitor_id' },
  audioInput: { label: '音频输入采集', inputKind: 'wasapi_input_capture', property: 'device_id' },
  audioOutput: { label: '音频输出采集', inputKind: 'wasapi_output_capture', property: 'device_id' }
} as const;
export const obsSourceKindSchema = z.enum(['camera', 'media', 'image', 'browser', 'window', 'text', 'display', 'audioInput', 'audioOutput']);
export type ObsSourceKind = z.infer<typeof obsSourceKindSchema>;
export const obsSourceCreateSchema = z.object({ kind: obsSourceKindSchema, name: z.string().trim().min(1).max(100), sceneName: z.string().min(1) }).strict();
export const obsSourceNameSchema = z.string().min(1);
export const obsSourceSettingsSchema = z.object({
  device: z.string().default(''), text: z.string().max(100000).default(''), url: z.string().default(''), path: z.string().default(''),
  width: z.number().int().min(1).max(8192).default(1920), height: z.number().int().min(1).max(8192).default(1080),
  fontSize: z.number().int().min(6).max(1000).default(72), looping: z.boolean().default(false)
}).strict();
export const obsSourceApplySchema = z.object({ inputName: obsSourceNameSchema, settings: obsSourceSettingsSchema,
  projectAsset: z.object({ projectPath: z.string().min(1), relativePath: z.string().min(1) }).strict().optional()
}).strict();
export type ObsSourceSettings = z.infer<typeof obsSourceSettingsSchema>;
export type ObsSourceDraft = { inputName: string; sceneName: string; sceneItemId: number; kind: ObsSourceKind };
export type ObsSourceOption = { label: string; value: string; enabled: boolean };
