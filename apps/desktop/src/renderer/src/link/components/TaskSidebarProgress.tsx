import { useEffect, useRef, useState } from 'react';
import type { AutomaticMusicJob } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useMa2AttributeStore } from '../stores/ma2-attribute-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { musicAnalysisOutcome } from '../view-models/music-analysis-progress';
import { Ma2ReadProgress } from './Ma2ReadProgress';
import { MusicAnalysisProgress } from './MusicAnalysisProgress';
import { Button, Progress } from '../ui';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { pauseMa2RealtimeSession } from '../runtime/ma2-realtime-session';

type Notify = (message: string, tone?: 'info' | 'error') => void;
const finished = new Set<AutomaticMusicJob['state']>(['completed', 'failed', 'cancelled']);

/**
 * The sidebar lists running tasks only (decided 2026-10-24). A task that ends is
 * announced once in a pop-up: results close by themselves, failures stay until closed.
 */
export function TaskSidebarProgress({ notify }: { notify: Notify }): JSX.Element {
  const attributes = useMa2AttributeStore();
  const materials = useMa2MaterialReadStore();
  const catalog = useMa2ReadStore();
  const songs = useMa2SyncStore(state => state.songs);
  const documentId = useDocumentStore(state => state.documentId);
  const path = useDocumentStore(state => state.path);
  const [jobs, setJobs] = useState<AutomaticMusicJob[]>([]);
  const [error, setError] = useState('');
  useTaskOutcomeNotices(notify);
  useEffect(() => {
    let active = true;
    const receive = (values: AutomaticMusicJob[]): void => setJobs(current => {
      const byId = new Map(current.map(job => [job.taskId, job]));
      for (const job of values) if ((byId.get(job.taskId)?.revision ?? -1) <= job.revision) byId.set(job.taskId, job);
      return [...byId.values()].slice(-200);
    });
    const unsubscribe = linkDesktopViewModel.onAutomaticMusicJob(job => receive([job]));
    void linkDesktopViewModel.getAutomaticMusicStatus().then(status => { if (active) receive(status.jobs); }).catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const projectJobs = jobs.filter(job => job.projectPath === path && !finished.has(job.state));
  const music = projectJobs.find(job => job.state !== 'paused') ?? projectJobs.at(-1) ?? null;
  const scanning = useMa2ExecutorPageStore(state => state.scanning);
  const scanned = useMa2ExecutorPageStore(state => state.completed);
  const pages = useMa2ExecutorPageStore(state => state.total);
  const cancelAttributes = (id: string): void => { void window.tbLink.cancelMa2Read(id).catch((cause: unknown) => notify(`取消读取没有成功：${cause instanceof Error ? cause.message : String(cause)}`, 'error')); };
  return <div className="sidebar-task-progress" aria-label="后台任务进度">
    {Object.values(songs).filter(song => song.documentId === documentId && song.state === 'syncing').map(song => <Progress key={song.itemId} compact label="歌曲同步阶段进度" title="同步歌曲 Cue"
      status={song.progress?.total ? `${Math.floor(song.progress.completed / song.progress.total * 100)}%` : '检查中'} value={song.progress?.completed ?? 0} max={song.progress?.total || 1} detail={song.progress?.detail ?? song.message}>
      <Button variant="secondary" size="sm" onClick={pauseMa2RealtimeSession}>停止同步</Button>
    </Progress>)}
    {attributes.busy ? <Ma2ReadProgress compact progress={attributes.progress} waiting="读取属性并分类"/> : null}
    {attributes.busy && attributes.activeId ? <Button variant="secondary" size="sm" onClick={() => cancelAttributes(attributes.activeId!)}>取消读取</Button> : null}
    {scanning ? <Progress compact label="控台页面读取进度" title="读取全部 Cue 位置" value={scanned} max={pages || 1} status={pages ? `${scanned} / ${pages} 页` : '正在获取页数'} detail="扫描控台上每一页执行器，找出每个 Cue 放在哪里；不会切换控台当前页" /> : null}
    {materials.documentId === documentId && materials.busy ? <Ma2ReadProgress compact progress={materials.progress} waiting="连接控台并读取素材"/> : null}
    {catalog.busy ? <Ma2ReadProgress compact progress={catalog.progress} waiting="读取控台时间线"/> : null}
    {music ? <MusicAnalysisProgress sidebar job={music} submitting={false}/> : null}
    {error ? <details><summary>任务状态读取失败</summary><p>{error}</p></details> : null}
  </div>;
}

/** Pop-ups for tasks that end while this window is open; jobs that ended earlier are not announced. */
function useTaskOutcomeNotices(notify: Notify): void {
  const latest = useRef(notify);
  useEffect(() => { latest.current = notify; }, [notify]);
  useEffect(() => useMa2AttributeStore.subscribe((next, previous) => {
    if (previous.busy && !next.busy && next.message) latest.current(next.message, next.failed ? 'error' : 'info');
  }), []);
  useEffect(() => useMa2MaterialReadStore.subscribe((next, previous) => {
    if (!previous.busy || next.busy || next.documentId !== useDocumentStore.getState().documentId) return;
    if (next.error) latest.current(`素材读取失败：${next.error}`, 'error');
    else if (next.message) latest.current(`素材读取结果：${next.message}`);
  }), []);
  useEffect(() => {
    // A job reports each change once with a higher revision; an ended job is never reported again.
    const revisions = new Map<string, number>();
    return linkDesktopViewModel.onAutomaticMusicJob(job => {
      if ((revisions.get(job.taskId) ?? -1) >= job.revision) return;
      revisions.set(job.taskId, job.revision);
      const current = useDocumentStore.getState();
      if (job.projectPath !== current.path) return;
      const outcome = musicAnalysisOutcome(job, current.project?.rundown.find(item => item.referenceAudio?.sha256 === job.sourceSha256)?.title ?? null);
      if (outcome) latest.current(outcome.message, outcome.tone);
    });
  }, []);
}
