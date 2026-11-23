import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useMa2NetworkStatusStore } from '../stores/ma2-network-status-store';
import { useLocalMa2Store } from '../stores/ma2-connection-store';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { useShowGate } from '../stores/show-state-store';
import { useRecoveryCopyStore } from '../recovery-copy-writer';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { ma2WorkbenchSyncStatus } from '../view-models/ma2-workbench-sync-status';

export function useMa2StatusForSong() {
  const session = useMa2SyncStore(state => state.session);
  const method = useMa2ModeStore(state => state.method);
  const network = useMa2NetworkStatusStore(state => state.status?.state);
  const connectionId = useMa2NetworkStatusStore(state => state.status?.connection);
  const local = useLocalMa2Store(state => state.status);
  const once = useMa2RealtimePreference(state => state.once);
  const onceItemId = useMa2RealtimePreference(state => state.onceItemId);
  const gate = useShowGate('ma2.sync.write');
  const recoveryError = useRecoveryCopyStore(state => state.error);
  const localConnection = local === 'ready' ? 'connected' : local === 'connecting' ? 'connecting' : 'disconnected';
  return (itemId: string | null, target: boolean, changed: boolean, song: SongSync | undefined) => ma2WorkbenchSyncStatus({
    selected: Boolean(itemId), target, changed: changed || song?.localEditedAt !== undefined, song, session,
    requested: once !== null && (!onceItemId || onceItemId === itemId),
    connection: method === 'network' ? network ?? 'unknown' : method === 'local' ? localConnection : 'disconnected', connectionId,
    wait: gate.kind === 'wait' ? gate.message : null, recoveryError
  });
}

export function useMa2SongStatus(itemId: string | null, documentId: number, target: boolean, changed: boolean) {
  const song = useMa2SyncStore(state => itemId ? state.songs[itemId] : undefined);
  const statusForSong = useMa2StatusForSong();
  const current = song?.documentId === documentId ? song : undefined;
  return statusForSong(itemId, target, changed, current);
}
