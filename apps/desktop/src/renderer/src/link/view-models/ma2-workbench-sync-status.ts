import type { Ma2SessionCheck, NameSync, SongSync } from '../stores/ma2-sync-store';

type Status = { label: '已同步'; tone: 'verified' } | { label: '正在同步'; tone: 'writing' } | { label: null; tone: 'idle' };
type Input = {
  songs: ReadonlyArray<Pick<SongSync, 'state' | 'writing' | 'waitingForConnection' | 'recheckRevision'>>;
  targetCount: number;
  names: NameSync['state'];
  session: Ma2SessionCheck;
  localCount: number;
  recoveryError: string | null;
  manual: boolean;
  reading: boolean;
};

const confirmed: Status = { label: '已同步', tone: 'verified' };
const syncing: Status = { label: '正在同步', tone: 'writing' };
const idle: Status = { label: null, tone: 'idle' };

/** The status describes actual work or confirmed results. The details button remains available when work has stopped. */
export function ma2WorkbenchSyncStatus(input: Input): Status {
  const { songs, names, session, localCount } = input;
  if (input.reading) return syncing;
  if (session.status === 'blocked' || input.recoveryError) return idle;
  const wait = session.status === 'waiting' ? session.waitFor : undefined;
  if (!input.manual && (wait === 'reading' || wait === 'check')) return syncing;
  if (!input.manual && session.status === 'waiting' && wait !== 'show') {
    // A project can use console materials without pairing any song. A completed name
    // write has its own readback and remains confirmed when there is no other edit to send.
    if ((wait === 'empty' || wait === 'unmatched') && !input.targetCount && !localCount && !songs.length && names === 'verified') return confirmed;
    return idle;
  }
  if (songs.some(song => song.waitingForConnection)) return idle;
  if (names === 'syncing' || songs.some(song => song.writing)) return syncing;
  const canSync = !input.manual && session.status === 'ready';
  if (canSync && (names === 'pending' || songs.some(song => song.state === 'syncing' || song.state === 'pending' && song.recheckRevision === undefined))) return syncing;
  if (names === 'blocked' || songs.some(song => song.state === 'blocked')) return idle;
  if (songs.some(song => song.state === 'paused' || song.recheckRevision !== undefined)) return idle;
  if (localCount || names === 'pending' || input.targetCount > songs.length) return canSync ? syncing : idle;
  if (songs.length ? songs.every(song => song.state === 'verified') : names === 'verified') return confirmed;
  return idle;
}
