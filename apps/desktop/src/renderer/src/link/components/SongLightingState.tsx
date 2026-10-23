import { songLightingStatus, type SongLightingStatus } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import '../song-lighting-state.css';

export type SongLightingView = { state: 'unmatched' | 'unconfirmed' | 'editing' | 'ready' | 'attention'; label: string; detail: string };

// The status reads the whole project; edits replace the project object, so one entry per song per project version.
const statuses = new WeakMap<LinkProject, Map<string, SongLightingStatus>>();
function statusOf(project: LinkProject, itemId: string): SongLightingStatus {
  let songs = statuses.get(project);
  if (!songs) { songs = new Map(); statuses.set(project, songs); }
  let status = songs.get(itemId);
  if (!status) { status = songLightingStatus(project, itemId); songs.set(itemId, status); }
  return status;
}

/** The song's lighting state as the lighting flow (2026-10-23) names it. A song
 * with a start code but no confirmed console pairing still sends timecode. */
export function songLightingView(project: LinkProject, item: RundownItem): SongLightingView {
  const status = statusOf(project, item.id);
  switch (status.state) {
    case 'ready': return { state: 'ready', label: '可演出', detail: `控台 Timecode ${status.timecode} 已核对；播放时发送时间码，控台按节目跑灯` };
    case 'editing': return { state: 'editing', label: '编灯中', detail: `控台节目还没同步最新改动（${status.pending} 项）；现在播放会跑控台上的旧版本` };
    case 'attention': return { state: 'attention', label: '需处理', detail: status.reasons.join('；') };
    case 'unmatched': return item.p1Media || (item.playback?.mtcOffsetMs ?? 0) > 0
      ? { state: 'unconfirmed', label: '未确认配对', detail: '有起始码，播放时照发时间码；控台上对应的时间码节目还没有确认配对，请在控台时间线中核对' }
      : { state: 'unmatched', label: '未匹配', detail: '控台上没有这首歌的时间码节目；开始编灯后会自动建立' };
  }
}

export function SongLightingState({ project, item }: { project: LinkProject; item: RundownItem }): JSX.Element {
  const view = songLightingView(project, item);
  return <span className="song-lighting-state" data-state={view.state} title={view.detail} aria-label={`灯光：${view.label}。${view.detail}`}>{view.label}</span>;
}
