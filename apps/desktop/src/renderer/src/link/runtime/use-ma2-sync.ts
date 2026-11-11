import { useEffect, useRef } from 'react';
import { markPendingMa2Songs, tickMa2SongSync } from './ma2-song-sync';
import { prepareMa2RealtimeSession } from './ma2-realtime-session';
import { ma2SyncActive, useMa2RealtimePreference } from './ma2-realtime-preference';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { currentShowGate, useShowStateStore } from '../stores/show-state-store';

type Notify = (message: string, tone?: 'info' | 'error') => void;

/** Says once when a sync stops after failing, and when a rename is confirmed on the console. The song's title goes in
 * 「」, as names do in on-screen text: toUserErrorMessage, which puts the red text into everyday words, does not look
 * inside 「」, so a title such as HAPPY does not make the sentence read as a technical error. */
export function announceMa2Sync(notify: Notify, state: ReturnType<typeof useMa2SyncStore.getState>, previous: ReturnType<typeof useMa2SyncStore.getState>): void {
  if (state.names.state === 'verified' && previous.names.state !== 'verified' && state.names.message === '名称已写入控台并回读确认') notify(state.names.message);
  if (state.names.state === 'blocked' && previous.names.state !== 'blocked') notify(state.names.message, 'error');
  // A stopped song is announced once per failure text (2026-11-11), not each time an edit tries it again.
  for (const song of Object.values(state.songs)) {
    if (song.state !== 'blocked' || !song.announcedFailure || song.announcedFailure === previous.songs[song.itemId]?.announcedFailure) continue;
    const title = useDocumentStore.getState().project?.rundown.find(item => item.id === song.itemId)?.title ?? song.name;
    notify(`「${title}」：${song.message}`, 'error');
  }
}

/**
 * The one console sync: the session check, then each song (either way it was lit) and the renamed
 * console objects. Edits made while the program moves are kept and synced once it is paused or stopped
 * (showGate's `ma2.sync.write`, 第 3 题); paused, paused at the end and P1 waiting for the next song sync at once.
 */
export function useMa2Sync(notify: Notify): void {
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
        if (ready && active && useMa2ModeStore.getState().method === 'network' && ma2SyncActive()) await tickMa2SongSync();
      } finally { busy = false; }
    };
    const documents = useDocumentStore.subscribe((state, previous) => { if (state.project !== previous.project) { changedAt = performance.now(); markPendingMa2Songs(); } });
    const preferences = useMa2RealtimePreference.subscribe(() => { void tick(); });
    const modes = useMa2ModeStore.subscribe(() => { void prepareMa2RealtimeSession(); });
    const sync = useMa2SyncStore.subscribe((state, previous) => { announceMa2Sync(notifyRef.current, state, previous); });
    // The program pausing or stopping carries on from the step a pass stopped at, without waiting for the next poll.
    // That is no retry: nothing failed, the sync only waited (02 §4.4).
    let gate = currentShowGate('ma2.sync.write').kind;
    const show = useShowStateStore.subscribe(() => {
      const next = currentShowGate('ma2.sync.write').kind;
      if (next === gate) return;
      gate = next;
      if (next === 'allow') void tick();
    });
    const poll = setInterval(() => { void tick(); }, 500);
    void tick();
    return () => { active = false; clearInterval(poll); documents(); preferences(); modes(); sync(); show(); };
  }, []);
}
