import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import type { Ma2ReadRequest, Ma2TimecodePreview } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { updateMa2Song, type SongSync } from '../stores/ma2-sync-store';
import { reportCoordinatorError } from './runtime-action-log';

/** A foreground read or playback preparation owns the console until it releases its read job. */
export function ma2ConsoleReading(): boolean {
  return useMa2ReadStore.getState().busy || useMa2MaterialReadStore.getState().busy;
}

/** A passive comparison yields its remaining reads as soon as this song changes. */
export async function readMa2SongPreview(entry: SongSync, request: Ma2ReadRequest): Promise<Ma2TimecodePreview> {
  if (entry.state !== 'verified' || request.syncSequences) return window.tbLink.previewMa2(request);
  const progressId = crypto.randomUUID();
  const currentLighting = () => {
    const state = useDocumentStore.getState();
    return state.documentId === entry.documentId ? state.project?.rundown.find(item => item.id === entry.itemId)?.lighting : undefined;
  };
  const before = currentLighting();
  const unsubscribe = useDocumentStore.subscribe(() => {
    if (currentLighting() === before) return;
    unsubscribe();
    void window.tbLink.cancelMa2Read(progressId).catch((cause: unknown) => {
      reportCoordinatorError(`中止旧时间线检查时控台没有确认：${String(cause)}`, message => updateMa2Song(entry, { message }));
    });
  });
  try { return await window.tbLink.previewMa2({ ...request, progressId }); }
  finally { unsubscribe(); }
}
