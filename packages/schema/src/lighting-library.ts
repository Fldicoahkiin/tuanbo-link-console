import { z } from 'zod';
import { lightingTemplateTrackSchema } from './lighting';
import { ma2RenameRecordSchema } from './ma2-rename';

export const lightingCategorySchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(64),
  section: z.enum(['front', 'rim', 'effect']),
  view: z.enum(['music', 'shape', 'beat']).optional(),
  beats: z.number().finite().positive().max(32).optional(),
  tone: z.enum(['bright', 'middle', 'dark']).optional(),
  people: z.number().int().positive().optional(),
  zone: z.enum(['front', 'middle', 'back']).optional()
}).strict();
export const lightingLibraryEntrySchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(512), originalName: z.string(),
  revision: z.number().int().positive(), kind: z.enum(['single', 'sequence', 'combination']),
  categoryIds: z.array(z.string().min(1)), favorite: z.boolean(),
  source: z.object({ endpoint: z.string(), show: z.string(), verified: z.boolean() }).strict(),
  track: lightingTemplateTrackSchema,
  members: z.array(z.object({ name: z.string(), sequence: z.number().int().positive(), cue: z.string().regex(/^\d+(?:\.\d+)?$/), executor: z.union([z.literal(''), z.string().regex(/^[1-9]\d*\.[1-9]\d*$/)]), delayMs: z.number().finite().nonnegative() }).strict()).optional()
}).strict();
const selectionZone = z.enum(['front','middle','back']);
export const lightingLibrarySelectionsSchema = z.object({
  bright:z.object({people:z.union([z.literal(3),z.literal(7),z.literal(12)]),zone:selectionZone}).strict(),
  middle:z.object({people:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(7)]),zone:selectionZone}).strict(),
  dark:z.object({people:z.literal(1),zone:selectionZone}).strict(),
  rim:z.object({people:z.union([z.literal(1),z.literal(3),z.literal(7),z.literal(12)]),zone:selectionZone}).strict()
}).strict();
export const lightingLibraryViewSchema = z.object({section:z.enum(['front','rim','effect']),tone:z.enum(['bright','middle','dark']),people:z.number().int().positive(),zone:z.enum(['front','middle','back']),view:z.enum(['music','shape']),effectCategory:z.string(),scope:z.enum(['category','all','favorites','unclassified']),query:z.string().max(512),selections:lightingLibrarySelectionsSchema.optional()}).strict();
export const lightingUserLibrarySchema = z.object({
  consoleRenames: z.array(ma2RenameRecordSchema).optional(),
  version: z.literal(1), categories: z.array(lightingCategorySchema), entries: z.array(lightingLibraryEntrySchema), view:lightingLibraryViewSchema.optional(),
  hiddenConsoleCues: z.array(z.object({ endpoint:z.string(), show:z.string(), sequence:z.number().int().positive(), cue:z.string(), kind:z.enum(['single','sequence']) }).strict()).optional()
}).strict().superRefine((library, context) => {
  const categories = new Set(library.categories.map(value => value.id));
  if (categories.size !== library.categories.length || new Set(library.entries.map(value => value.id)).size !== library.entries.length) context.addIssue({ code: 'custom', message: '灯光分类或素材 ID 重复' });
  for (const entry of library.entries) if (entry.categoryIds.some(id => !categories.has(id))) context.addIssue({ code: 'custom', message: '灯光素材引用不存在的分类' });
});
export type LightingCategory = z.infer<typeof lightingCategorySchema>;
export type LightingLibraryEntry = z.infer<typeof lightingLibraryEntrySchema>;
export type LightingUserLibrary = z.infer<typeof lightingUserLibrarySchema>;

export function createLightingUserLibrary(): LightingUserLibrary {
  const categories: LightingCategory[] = [];
  const zones = [['front', '前区'], ['middle', '中区'], ['back', '后区']] as const;
  for (const [tone, name, people] of [['bright', '亮调', [3, 7, 12]], ['middle', '中调', [1, 2, 3, 7]], ['dark', '暗调', [1]]] as const) {
    for (const count of people) for (const [zone, area] of zones) categories.push({ id: `front:${tone}:${count}:${zone}`, section: 'front', tone, people: count, zone, name: `${name} · ${count}人 · ${area}` });
  }
  for (const people of [1, 3, 7, 12]) for (const [zone, area] of zones) categories.push({ id: `rim:${people}:${zone}`, section: 'rim', people, zone, name: `${people}人 · ${area}` });
  ['重击', '滚奏', '渐强', '爆发', '停顿', '段落切换', '结尾', '最后一击', '自定义'].forEach((name,index)=>categories.push({id:`effect:music:${index}`,section:'effect',view:'music',name}));
  for (const [beats,name] of [[.25,'每四分之一拍'],[.5,'每半拍'],[1,'每拍'],[2,'每两拍'],[4,'每四拍'],[8,'每八拍'],[16,'每十六拍'],[32,'每三十二拍']] as const) categories.push({id:`effect:beat:${beats}`,section:'effect',view:'beat',beats,name});
  return { version: 1, categories, entries: [] };
}
