import { useEffect, useRef } from 'react';
import { markPendingMa2Songs, tickMa2SongSync } from './ma2-song-sync';
import { prepareMa2RealtimeSession } from './ma2-realtime-session';
import { useMa2RealtimePreference } from './ma2-realtime-preference';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useDocumentStore } from '../stores/document-store';
import { ma2SyncPlaying, useMa2SyncStore } from '../stores/ma2-sync-store';

type Notify = (message: string, tone?: 'info' | 'error') => void;

/** Says once when a sync stops after failing, and when a rename is confirmed on the console. */
function announce(notify: Notify, state: ReturnType<typeof useMa2SyncStore.getState>, previous: ReturnType<typeof useMa2SyncStore.getState>): void {
  if (state.names.state === 'verified' && previous.names.state !== 'verified' && state.names.message === '名称已写入控台并回读确认') notify(state.names.message);
  if (state.names.state === 'blocked' && previous.names.state !== 'blocked') notify(state.names.message, 'error');
  for (const song of Object.values(state.songs)) {
    if (song.state !== 'blocked' || previous.songs[song.itemId]?.state === 'blocked') continue;
    const title = useDocumentStore.getState().project?.rundown.find(item => item.id === song.itemId)?.title ?? song.name;
    notify(`${title}：${song.message}`, 'error');
  }
}

/**
 * The one console sync: the session check, then each song (either way it was lit) and the renamed
 * console objects. Edits made while playing are kept and synced after playback stops.
 */
export function useMa2Sync(playing: boolean, notify: Notify): void {
  useEffect(() => { useMa2SyncStore.setState({ timelinePlaying: playing }); return () => { useMa2SyncStore.setState({ timelinePlaying: false }); }; }, [playing]);
  const playingRef = useRef(playing); playingRef.current = playing;
  const notifyRef = useRef(notify); notifyRef.current = notify;
  useEffect(() => {
    let active = true;
    let busy = false;
    let changedAt = 0;
    const tick = async (): Promise<void> => {
      if (busy || !active || performance.now() - changedAt < 250) return;
      busy = true;
      try {
        const ready = await prepareMa2RealtimeSession();
        if (ready && active && useMa2ModeStore.getState().method === 'network' && useMa2RealtimePreference.getState().enabled) await tickMa2SongSync(playingRef.current || ma2SyncPlaying());
      } finally { busy = false; }
    };
    const documents = useDocumentStore.subscribe((state, previous) => { if (state.project !== previous.project) { changedAt = performance.now(); markPendingMa2Songs(); } });
    const preferences = useMa2RealtimePreference.subscribe(() => { void tick(); });
    const modes = useMa2ModeStore.subscribe(() => { void prepareMa2RealtimeSession(); });
    const sync = useMa2SyncStore.subscribe((state, previous) => {
      announce(notifyRef.current, state, previous);
      // Playback or a preview stopping syncs what was kept meanwhile without waiting for the next poll.
      if (state.timelinePlaying !== previous.timelinePlaying || state.previewPlaying !== previous.previewPlaying) void tick();
    });
    const poll = setInterval(() => { void tick(); }, 500);
    void tick();
    return () => { active = false; clearInterval(poll); documents(); preferences(); modes(); sync(); };
  }, []);
}
