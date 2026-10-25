import { useEffect, useRef, useState } from 'react';
import type { AutomaticMusicJob } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useMa2AttributeStore } from '../stores/ma2-attribute-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { musicAnalysisOutcome } from '../view-models/music-analysis-progress';
import { Ma2ReadProgress } from './Ma2ReadProgress';
import { MusicAnalysisProgress } from './MusicAnalysisProgress';
import { useMa2SongSyncStore } from '../runtime/ma2-song-sync';
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
  const songs = useMa2SongSyncStore(state => state.songs);
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
  return <div className="sidebar-task-progress" aria-label="后台任务进度">
    <div id="ma2-sidebar-read-actions"/>
    {Object.values(songs).filter(song => song.documentId === documentId && song.state === 'syncing').map(song => <div className="ma2-read-progress" role="status" key={song.itemId}>
      <div><strong>同步歌曲 Cue</strong><span>{song.progress?.total ? `${Math.floor(song.progress.completed / song.progress.total * 100)}%` : '核对中'}</span></div>
      <progress aria-label="歌曲同步阶段进度" value={song.progress?.completed ?? 0} max={song.progress?.total || 1}/>
      <small>{song.progress?.detail ?? song.message}</small>
      <button onClick={pauseMa2RealtimeSession}>停止同步</button>
    </div>)}
    {attributes.busy ? <Ma2ReadProgress progress={attributes.progress} waiting="读取属性并分类"/> : null}
    {materials.documentId === documentId && materials.busy ? <Ma2ReadProgress progress={materials.progress} waiting="连接控台并读取素材"/> : null}
    {catalog.busy ? <Ma2ReadProgress progress={catalog.progress} waiting="读取控台时间线"/> : null}
    {music ? <MusicAnalysisProgress job={music} submitting={false}/> : null}
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
