import type { AutomaticMusicJob } from '@tb/schema';
import { musicAnalysisProgress } from '../view-models/music-analysis-progress';
import { Progress } from '../ui';

/** `compact` is the one-line bar in a toolbar; `sidebar` the small card in the task sidebar. */
export function MusicAnalysisProgress({ job, submitting, compact = false, sidebar = false }: { job: AutomaticMusicJob | null; submitting: boolean; compact?: boolean; sidebar?: boolean }): JSX.Element | null {
  const progress = musicAnalysisProgress(job, submitting);
  if (!progress || compact && !progress.active) return null;
  const count = `已完成 ${progress.completed}/${progress.total} 个阶段`;
  if (compact) return <span className="music-progress-compact" title={`${progress.detail} · ${count}`}><progress aria-label="音乐识别阶段进度" value={progress.completed} max={progress.total}/><small>{progress.completed}/{progress.total}</small></span>;
  return <Progress label="音乐识别阶段进度" compact={sidebar} title={progress.detail} status={count} value={progress.completed} max={progress.total}
    detail={progress.active ? '各阶段耗时不同；当前阶段完成后进度会继续，切换页面不影响后台任务。' : undefined} />;
}
