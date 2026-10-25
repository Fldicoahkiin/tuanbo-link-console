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

/** Finished jobs leave the sidebar and are announced once in a pop-up (decided 2026-10-24); paused jobs stay listed. */
export function musicAnalysisOutcome(job: AutomaticMusicJob, title: string | null): { message: string; tone: 'info' | 'error' } | null {
  const subject = title ? `「${title}」音乐分析` : '音乐分析';
  switch (job.state) {
    case 'completed': return { message: job.message === '音乐分析完成' ? `${subject}完成` : `${subject}完成：${job.message}`, tone: 'info' };
    case 'failed': return { message: `${subject}失败：${job.message}`, tone: 'error' };
    case 'cancelled': return { message: `${subject}${job.message}`, tone: 'info' };
    case 'queued': case 'checking': case 'running': case 'pausing': case 'paused': case 'cancelling': return null;
  }
}
