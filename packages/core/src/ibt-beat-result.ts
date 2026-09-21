import { audioBeatAnalysisSchema, type AudioBeatAnalysis } from '@tb/schema';

/** IBT emits source-relative seconds, optionally followed by instantaneous BPM. */
export function parseIbtBeats(text: string, durationMs: number): AudioBeatAnalysis {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('音频时长无效');
  const rows = text.trim() ? text.trim().split(/\r?\n/) : [];
  if (rows.length > 100_000) throw new Error('IBT 节拍数量超出限制');
  const dense = rows.map((row, index) => {
    const fields = row.trim().split(/\s+/);
    if (fields.length > 2 || fields.some(field => !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(field) || !Number.isFinite(Number(field)))) throw new Error(`IBT 第 ${index + 1} 行不是有效的节拍时间`);
    const milliseconds = Math.round(Number(fields[0]) * 1000);
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > durationMs) throw new Error('IBT 节拍超出音频范围');
    return milliseconds;
  });
  if (dense.some((time, index) => index > 0 && time <= dense[index - 1]!)) throw new Error('IBT 节拍必须递增且不能重复');
  return audioBeatAnalysisSchema.parse({ dense, standard: dense.filter((_, index) => index % 2 === 0), sparse: dense.filter((_, index) => index % 4 === 0) });
}
