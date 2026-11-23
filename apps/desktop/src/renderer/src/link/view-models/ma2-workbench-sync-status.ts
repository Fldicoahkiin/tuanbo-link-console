import type { Ma2NetworkStatus, Ma2SongBinding, Ma2SongConsoleEdits } from '@tb/schema';
import { ma2LatestChoiceText } from '@tb/core/link';
import { ma2ExecutorLocationLabel } from './ma2-console-page';
import type { Ma2SessionCheck, SongSync } from '../stores/ma2-sync-store';

type Input = {
  selected: boolean;
  target: boolean;
  connection: Ma2NetworkStatus['state'] | 'unknown';
  connectionId?: number | undefined;
  session: Ma2SessionCheck;
  song?: Pick<SongSync, 'state' | 'checking' | 'writing' | 'checkedAt' | 'checkedConnection' | 'waitingForConnection' | 'recheckRevision' | 'needsSourceCheck' | 'playbackClockNote'> | undefined;
  requested: boolean;
  changed: boolean;
  wait: string | null;
  recoveryError: string | null;
};

type Status = { label: string; tone: 'idle' | 'writing' | 'verified' | 'warning' | 'error' };

export function ma2WorkbenchSyncStatus(input: Input): Status {
  const idle = (label: string): Status => ({ label, tone: 'idle' });
  const working = (label: string): Status => ({ label, tone: 'writing' });
  const song = input.song;
  if (!input.selected) return idle('未选择节目');
  if (!input.target) return idle('未关联控台时间线');
  if (input.connection === 'disconnected') return idle('等待连接控台');
  if (input.connection === 'connecting') return working('正在连接控台');
  if (input.connection === 'authenticating') return working('正在登录控台');
  if (song?.waitingForConnection && input.connection === 'connected') return idle(input.changed ? '有待同步的修改' : '尚未核对');
  if (input.recoveryError || input.session.status === 'blocked' || song?.state === 'blocked') return { label: '同步需要处理', tone: 'error' };
  if (song?.writing) return working('正在写入控台');
  if (song?.checking) return working('正在核对控台');
  if (input.requested) {
    if (input.wait) return idle(input.wait);
    if (input.session.status === 'waiting') return idle(input.session.message);
    return working('正在核对控台');
  }
  if (song?.state === 'paused') return idle('同步已暂停');
  if (input.changed) return idle('有待同步的修改');
  if (song?.state === 'verified' && song.checkedAt !== undefined && song.checkedConnection === input.connectionId && !song.needsSourceCheck && song.recheckRevision === undefined && input.connection === 'connected') {
    return song.playbackClockNote ? { label: '编排已同步 · 核对时码槽', tone: 'warning' } : { label: '已同步', tone: 'verified' };
  }
  return idle('尚未核对');
}

export function confirmedMessage(binding: Ma2SongBinding, edits?: Ma2SongConsoleEdits): string {
  const location = binding.executor ? ma2ExecutorLocationLabel(Number(binding.executor.split('.')[0]), Number(binding.executor.split('.')[1])) : `Layout ${binding.layout}`;
  const taken = edits ? [edits.moved.length ? `挪了 ${edits.moved.length} 个` : '', edits.removed.length ? `删了 ${edits.removed.length} 个` : '', edits.added.length ? `加了 ${edits.added.length} 个` : ''].filter(Boolean) : [];
  const chosen = edits?.conflicts ? ` · ${ma2LatestChoiceText('这首歌', edits.conflicts.count, edits.conflicts.winner, edits.conflicts.operatorChoice)}` : '';
  return `${location} · 序列 ${binding.sequence}${binding.timecode ? ` · Timecode ${binding.timecode.number}` : ''} · ${binding.points.length} 步已确认${taken.length ? ` · 控台上${taken.join('、')} Cue，已同步到联动台` : ''}${chosen}`;
}
