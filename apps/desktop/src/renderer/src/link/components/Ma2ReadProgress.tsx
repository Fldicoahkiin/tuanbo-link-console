import type { Ma2ReadProgress } from '@tb/schema';
import { Progress } from '../ui';

export function Ma2ReadProgress({ progress, waiting, compact = false }: { progress: Ma2ReadProgress | null; waiting: string; compact?: boolean }): JSX.Element {
  const title = progress?.phase === 'library' ? '读取序列与 Cue' : progress?.phase === 'timecodes' ? '扫描时间线' : progress?.phase === 'verification' ? '检查序列与 Cue' : progress?.phase === 'previews' ? '读取已配对灯光' : progress?.phase === 'raw' ? '收集原始时间线' : waiting;
  const finishing = progress && progress.total > 0 && progress.completed === progress.total;
  return <Progress label="控台读取进度" compact={compact} title={title} value={progress?.completed ?? 0} max={progress?.total || 1}
    status={progress && progress.total > 0 ? `本阶段 ${Math.floor(progress.completed / progress.total * 100)}% · ${progress.completed} / ${progress.total}` : '正在获取总数'}
    detail={finishing ? `${progress.detail ?? waiting}。这一阶段已读完，正在检查并保存，全部完成后会显示结果。` : progress?.detail ?? waiting} />;
}
