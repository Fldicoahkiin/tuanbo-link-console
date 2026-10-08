import { z } from 'zod';

export const musicMarkerKinds = ['hit', 'roll', 'build', 'drop', 'stop', 'change', 'ending', 'last', 'custom'] as const;
export const musicMarkerNames: Record<typeof musicMarkerKinds[number], string> = { hit: '重鼓点 / 重击', roll: '连续鼓点 / 滚奏', build: '渐强 / 蓄力', drop: '爆发点 / Drop', stop: '停顿 / 切断', change: '段落切换', ending: '结尾 / Ending', last: '最后一击', custom: '自定义' };
export const lightingMusicSchema = z.object({
  version: z.literal(1), firstBeatMs: z.number().finite().nonnegative(),
  gridBeats: z.number().finite().positive().max(1024), triplet: z.boolean(),
  showGrid: z.boolean(), accentBars: z.boolean(), snap: z.boolean(),
  align: z.enum(['nearest', 'previous', 'next']), ruler: z.enum(['time', 'beats', 'both']),
  sections: z.array(z.object({ id: z.string().min(1), name: z.string().trim().min(1), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().positive(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), notes: z.string() }).strict())
}).strict().superRefine((music, context) => {
  const sorted = [...music.sections].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.endMs <= sorted[i]!.startMs || i > 0 && sorted[i]!.startMs < sorted[i - 1]!.endMs) context.addIssue({ code: 'custom', message: '歌曲段落终点必须晚于起点，且段落不能重叠' });
  if (new Set(sorted.map(section => section.id)).size !== sorted.length) context.addIssue({ code: 'custom', message: '歌曲段落 ID 重复' });
});
export type LightingMusic = z.infer<typeof lightingMusicSchema>;
export function createLightingMusic(): LightingMusic {
  return { version: 1, firstBeatMs: 0, gridBeats: 8, triplet: false, showGrid: true, accentBars: true, snap: true, align: 'nearest', ruler: 'both', sections: [] };
}
