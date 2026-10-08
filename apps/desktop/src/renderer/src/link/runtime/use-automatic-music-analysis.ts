import { useEffect, useRef, useState } from 'react';
import type { AutomaticMusicJob, AutomaticMusicStatus, ReferenceAudio } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { reportCoordinatorError } from './runtime-action-log';

// Preview dismissal survives tab/song remounts for this application session.
const dismissedTasks = new Set<string>();

export function useAutomaticMusicAnalysis(projectPath: string | null, source: ReferenceAudio | undefined) {
  const [status, setStatus] = useState<AutomaticMusicStatus | null>(null);
  const [job, setJob] = useState<AutomaticMusicJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<'cpu' | 'cuda' | null>(null);
  const device = selectedDevice ?? status?.device ?? 'cpu';
  const generation = useRef(0);
  const owned = useRef<string | null>(null);
  const sha256 = source?.sha256;
  const relativePath = source?.relativePath;
  const durationMs = source?.durationMs;
  const receive = (value: AutomaticMusicJob | null): void => setJob(current => value && dismissedTasks.has(value.taskId) ? null : current && value && current.taskId === value.taskId && current.revision > value.revision ? current : value);
  const fail = (cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message); reportCoordinatorError(message, setError);
  };
  useEffect(() => {
    const current = ++generation.current;
    setError(null); setJob(null); setStatus(null); setSubmitting(false);
    const unsubscribe = linkDesktopViewModel.onAutomaticMusicJob(value => {
      if (generation.current === current && value.projectPath === projectPath && value.sourceSha256 === sha256) receive(value);
    });
    void linkDesktopViewModel.getAutomaticMusicStatus().then(value => {
      if (generation.current !== current) return;
      setStatus(value); receive(value.jobs.filter(candidate => candidate.projectPath === projectPath && candidate.sourceSha256 === sha256).at(-1) ?? null);
    }).catch((cause: unknown) => { if (generation.current === current) fail(cause); });
    return () => {
      generation.current = current + 1; unsubscribe();
      const taskId = owned.current; owned.current = null;
      if (taskId) void linkDesktopViewModel.controlAutomaticMusicAnalysis({ version: 1, taskId, action: 'cancel' }).catch((cause: unknown) => reportCoordinatorError(cause instanceof Error ? cause.message : String(cause), message => console.error(message)));
    };
  }, [projectPath, sha256, relativePath, durationMs]);

  const start = async (): Promise<void> => {
    if (!projectPath || !source || !status?.available || submitting) return;
    const current = generation.current; setSubmitting(true); setError(null);
    try {
      const value = await linkDesktopViewModel.startAutomaticMusicAnalysis({ version: 1, taskId: crypto.randomUUID(), projectPath, device,
        source: { assetId: source.assetId, relativePath: source.relativePath, sha256: source.sha256, durationMs: source.durationMs } });
      if (generation.current !== current) { await linkDesktopViewModel.controlAutomaticMusicAnalysis({ version: 1, taskId: value.taskId, action: 'cancel' }); return; }
      owned.current = value.taskId; receive(value);
    } catch (cause) { if (generation.current === current) fail(cause); }
    finally { if (generation.current === current) setSubmitting(false); }
  };
  const control = async (action: 'cancel' | 'resume'): Promise<void> => {
    if (!job) return;
    setError(null);
    try { await linkDesktopViewModel.controlAutomaticMusicAnalysis({ version: 1, taskId: job.taskId, action }); }
    catch (cause) { fail(cause); }
  };
  const visibleJob = job?.projectPath === projectPath && job.sourceSha256 === sha256
    && (!job.candidates || durationMs !== undefined && Math.abs(job.candidates.durationMs - durationMs) <= 50) ? job : null;
  return { status, job: visibleJob, error, submitting, device, setDevice: setSelectedDevice, start, control, clear: () => {
    if (job) dismissedTasks.add(job.taskId);
    if (dismissedTasks.size > 200) dismissedTasks.delete(dismissedTasks.values().next().value!);
    setJob(null); setError(null);
  } };
}
