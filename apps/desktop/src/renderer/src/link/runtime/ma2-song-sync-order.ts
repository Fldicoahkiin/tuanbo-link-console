import { useDocumentStore } from '../stores/document-store';
import { useProgramSelectionStore } from '../stores/program-selection-store';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';

// Each comparison exports the song on the console. The song open in the editor is compared often,
// so console edits show up quickly; the others rarely, so they never hold up the next edit for long.
const FOCUSED_RECHECK_MS = 300;
export const BACKGROUND_RECHECK_MS = 30000;
function focusedItemId(): string | null {
  const project = useDocumentStore.getState().project;
  return project ? useProgramSelectionStore.getState().byProject[project.projectId] ?? null : null;
}
/** When a song is next due: a confirmed song open in the editor comes back early, a reset to 0 always wins. */
export function dueAt(entry: SongSync): number | undefined {
  // Parked until the project changes: any edit makes it due at once.
  if (entry.recheckRevision !== undefined && entry.recheckRevision !== useDocumentStore.getState().revision) return 0;
  if (entry.state !== 'verified' || entry.checkedAt === undefined || entry.itemId !== focusedItemId()) return entry.nextCheckAt;
  return Math.min(entry.nextCheckAt ?? Number.POSITIVE_INFINITY, entry.checkedAt + FOCUSED_RECHECK_MS);
}

/** Reconsider the order between complete song transactions when the operator switches songs or edits the focused song. */
export function songSyncOrder(flushEdits: () => void): { songs: SongSync[]; changed: (entry: SongSync) => boolean } {
  const focus = focusedItemId();
  const lighting = () => useDocumentStore.getState().project?.rundown.find(item => item.id === focus)?.lighting;
  let lastLighting = lighting();
  const priority = { pending: 0, syncing: 0, blocked: 1, verified: 2, paused: 3 } as const;
  const rank = (entry: SongSync): number => priority[entry.state] * 2 + (entry.itemId === focus ? 0 : 1);
  return {
    songs: Object.values(useMa2SyncStore.getState().songs).sort((a, b) => rank(a) - rank(b)),
    changed(entry) {
      if (focusedItemId() !== focus) return true;
      if (!focus || entry.itemId === focus) return false;
      const latest = lighting();
      if (latest === lastLighting) return false;
      lastLighting = latest;
      flushEdits();
      return useMa2SyncStore.getState().songs[focus]?.state === 'pending';
    }
  };
}
