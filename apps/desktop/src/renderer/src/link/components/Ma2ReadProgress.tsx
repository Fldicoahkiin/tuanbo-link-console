import type { Ma2ReadProgress } from '@tb/schema';

export function Ma2ReadProgress({ progress, waiting }: { progress: Ma2ReadProgress | null; waiting: string }): JSX.Element {
  const title = progress?.phase === 'library' ? '读取序列与 Cue' : progress?.phase === 'timecodes' ? '扫描时间线' : progress?.phase === 'verification' ? '复核序列与 Cue' : progress?.phase === 'previews' ? '读取已配对灯光' : progress?.phase === 'raw' ? '收集原始时间线' : waiting;
  return <div className="ma2-read-progress" role="status" aria-live="polite">
    <div><strong>{title}</strong><span>{progress && progress.total > 0 ? `${progress.completed} / ${progress.total}` : '正在获取总数'}</span></div>
    {progress && progress.total > 0 ? <progress aria-label="控台读取进度" value={progress.completed} max={progress.total} /> : <progress aria-label="控台读取进度" />}
    <small>{progress?.detail ?? waiting}</small>
  </div>;
}
