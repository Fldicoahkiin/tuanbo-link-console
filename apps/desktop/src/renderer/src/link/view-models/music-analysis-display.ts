import type { AutomaticMusicJob, MusicStructure, MusicStructureSegment } from '@tb/schema';
import { musicSegmentTempoLabel } from './music-segment-display';

/** Do not present an unfinished, cancelled or failed job as an uncertain BPM estimate. */
export function musicAnalysisHeading(data: MusicStructure | undefined, current: MusicStructureSegment | undefined, job: AutomaticMusicJob | null, submitting: boolean, error: string | null): string {
  if (submitting) return '正在提交识别';
  if (error || job?.state === 'failed') return '识别失败';
  if (job && ['queued', 'checking', 'running'].includes(job.state)) return '正在识别';
  if (job?.state === 'cancelling') return '正在取消';
  if (job && ['pausing', 'paused'].includes(job.state)) return '识别已暂停';
  if (job?.state === 'cancelled') return '识别已取消';
  if (job?.state === 'completed' && data?.taskId !== job.taskId) return '分析已完成';
  if (!data) return '还没分析';
  if (data.state === 'cleared') return '标记已清除';
  return musicSegmentTempoLabel(current);
}
