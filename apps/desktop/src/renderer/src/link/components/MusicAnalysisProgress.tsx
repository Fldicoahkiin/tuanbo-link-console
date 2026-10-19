import type { AutomaticMusicJob } from '@tb/schema';
import { musicAnalysisProgress } from '../view-models/music-analysis-progress';

export function MusicAnalysisProgress({ job, submitting, compact = false }: { job: AutomaticMusicJob | null; submitting: boolean; compact?: boolean }): JSX.Element | null {
  const progress = musicAnalysisProgress(job, submitting);
  if (!progress || compact && !progress.active) return null;
  const count = `已完成 ${progress.completed}/${progress.total} 个阶段`;
  if (compact) return <span className="music-progress-compact" title={`${progress.detail} · ${count}`}><progress aria-label="音乐识别阶段进度" value={progress.completed} max={progress.total}/><small>{progress.completed}/{progress.total}</small></span>;
  return <div className="ma2-read-progress music-analysis-progress" role="status" aria-live="polite">
    <div><strong>{progress.detail}</strong><span>{count}</span></div>
    <progress aria-label="音乐识别阶段进度" value={progress.completed} max={progress.total}/>
    {progress.active ? <small>各阶段耗时不同；当前阶段完成后进度会继续，切换页面不影响后台任务。</small> : null}
  </div>;
}
