import type { AutomaticMusicJob } from '@tb/schema';

/** Counts completed stages, never estimates elapsed-time percentage. */
export function musicAnalysisProgress(job: AutomaticMusicJob | null, submitting: boolean): { completed: number; total: number; detail: string; active: boolean } | null {
  if (!job && !submitting) return null;
  const stages: Record<string, number> = {
    'verify-assets': 0, 'decode-48000-stereo': 1,
    'beat-this-final0': 2, 'beat-this-final1': 3, 'beat-this-final2': 4,
    'audio-structure': 5, 'all-in-one-harmonix-all': 5,
    'cached-research-only': 6, 'completed-research-only': 6
  };
  const complete = job?.state === 'completed';
  const completed = complete ? 7 : stages[job?.stage ?? ''] ?? 0;
  return { completed, total: 7, detail: submitting ? '正在提交识别任务' : job?.message ?? '准备分析',
    active: submitting || Boolean(job && ['queued', 'checking', 'running', 'pausing', 'cancelling'].includes(job.state)) };
}
