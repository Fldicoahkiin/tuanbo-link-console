import { useEffect, useRef } from 'react';
import { markPendingMa2Songs, tickMa2SongSync } from './ma2-song-sync';
import { prepareMa2RealtimeSession } from './ma2-realtime-session';
import { ma2SyncActive, useMa2RealtimePreference } from './ma2-realtime-preference';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useDocumentStore } from '../stores/document-store';
import { useProgramSelectionStore } from '../stores/program-selection-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { ma2ConsoleReading } from './ma2-console-reading';
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
  useEffect(() => subscribeMa2Sync((message, tone) => notifyRef.current(message, tone)), []);
}

export function subscribeMa2Sync(notify: Notify): () => void {
  let active = true;
  let busy = false;
  let requested = false;
  const wake = () => {
    if (requested || !active || !ma2SyncActive()) return;
    requested = true;
    if (!busy) queueMicrotask(() => { void tick(); });
  };
  const tick = async (): Promise<void> => {
    if (busy || !active) return;
    requested = false;
    busy = true;
    try {
      const ready = await prepareMa2RealtimeSession();
      if (ready && active && useMa2ModeStore.getState().method === 'network' && ma2SyncActive()) await tickMa2SongSync();
    } finally {
      busy = false;
      if (requested && active) queueMicrotask(() => { void tick(); });
    }
  };
  const documents = useDocumentStore.subscribe((state, previous) => {
    if (state.project === previous.project) return;
    markPendingMa2Songs();
    if (state.project?.rundown !== previous.project?.rundown
      || state.project?.ma2MaterialLibrary?.userLibrary?.consoleRenames !== previous.project?.ma2MaterialLibrary?.userLibrary?.consoleRenames) wake();
  });
  let poll: ReturnType<typeof setInterval> | undefined;
  const updateSchedule = (): void => {
    if (ma2SyncActive()) {
      poll ??= setInterval(wake, 500);
      wake();
    } else {
      clearInterval(poll);
      poll = undefined;
    }
  };
  const preferences = useMa2RealtimePreference.subscribe(updateSchedule);
  const selection = useProgramSelectionStore.subscribe((state, previous) => {
    const id = useDocumentStore.getState().project?.projectId;
    if (id && state.byProject[id] !== previous.byProject[id]) wake();
  });
  const modes = useMa2ModeStore.subscribe(wake);
  const onRead = (state: { busy: boolean }, previous: { busy: boolean }): void => {
    if (previous.busy && !state.busy && !ma2ConsoleReading() && ma2SyncActive()) wake();
  };
  const timelines = useMa2ReadStore.subscribe(onRead);
  const materials = useMa2MaterialReadStore.subscribe(onRead);
  const sync = useMa2SyncStore.subscribe((state, previous) => { announceMa2Sync(notify, state, previous); });
  // The program pausing or stopping carries on from the step a pass stopped at, without waiting for the next poll.
  // That is no retry: nothing failed, the sync only waited (02 §4.4).
  let gate = currentShowGate('ma2.sync.write').kind;
  const show = useShowStateStore.subscribe(() => {
    const next = currentShowGate('ma2.sync.write').kind;
    if (next === gate) return;
    gate = next;
    if (next === 'allow') wake();
  });
  updateSchedule();
  return () => { active = false; clearInterval(poll); documents(); selection(); preferences(); modes(); timelines(); materials(); sync(); show(); };
}
