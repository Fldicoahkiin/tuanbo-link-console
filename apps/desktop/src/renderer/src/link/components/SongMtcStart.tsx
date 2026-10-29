import { RefreshCw, TriangleAlert } from 'lucide-react';
import { formatMtcOffset, readSongMtcStart, songLightingStatus, songMtcOverlaps, songsNeedingMtcStart, type SongLightingStatus } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useMtcStartAllocationStore } from '../stores/mtc-start-allocation-store';
import '../song-mtc-start.css';

/**
 * `matched`: a console Timecode show starts where the song starts, so playing the song runs its lights.
 * `set`: the song sends its timecode, no console show starts there. The two differ only in colour
 * (2026-10-28: no pairing or editing labels). `warning` is something to fix; `unset` and `invalid` have no start.
 */
export type SongMtcView = { state: 'matched' | 'set' | 'warning' | 'unset' | 'invalid'; text: string; detail: string; /** Edits not on the console yet (matched songs only). */ pending?: number };

// Overlaps and pairs compare every song; edits replace the project object, so one result per project version.
const overlapsByProject = new WeakMap<LinkProject, Map<string, string[]>>();
function overlapsOf(project: LinkProject): Map<string, string[]> {
  let overlaps = overlapsByProject.get(project);
  if (!overlaps) { overlaps = songMtcOverlaps(project); overlapsByProject.set(project, overlaps); }
  return overlaps;
}
const statuses = new WeakMap<LinkProject, Map<string, SongLightingStatus>>();
function statusOf(project: LinkProject, itemId: string): SongLightingStatus {
  let songs = statuses.get(project);
  if (!songs) { songs = new Map(); statuses.set(project, songs); }
  let status = songs.get(itemId);
  if (!status) { status = songLightingStatus(project, itemId); songs.set(itemId, status); }
  return status;
}

/** MA2 keeps a show's offset in 1/30 s whatever its frame format. */
const consoleFrames = (ms: number): number => Math.round(ms * 30 / 1000);

/**
 * The song's MTC start as the lighting flow shows it: the timecode the song sends from its first
 * frame, and whether a console Timecode show starts there. `allocationError` is why the last
 * automatic allocation failed for the songs still waiting for one.
 */
export function songMtcView(project: LinkProject, item: RundownItem, allocationError: string | null = null): SongMtcView {
  const reading = readSongMtcStart(item);
  const frameRate = project.timebase.frameRate;
  switch (reading.state) {
    case 'invalid': return { state: 'invalid', text: 'MTC 起点无效', detail: reading.reason };
    case 'unset':
      if (allocationError && songsNeedingMtcStart(project).includes(item.id)) return { state: 'invalid', text: 'MTC 未分配', detail: `自动分配失败：${allocationError}` };
      if (!item.referenceAudio) return { state: 'unset', text: 'MTC 未分配', detail: '添加音频后才能分配' };
      return { state: 'unset', text: 'MTC 未分配', detail: item.lighting
        ? '连上控台后自动分配，避开控台已有的时间码节目和其他歌曲'
        : '开始编灯后连上控台自动分配；也可以在歌曲属性里填写，和控台上节目的起点一样就会自动对上' };
    case 'set': {
      const code = formatMtcOffset(reading.startMs, frameRate);
      const text = `MTC ${code}`;
      const sends = `本曲从 ${code} 开始发送时间码`;
      const warnings: string[] = [];
      const others = overlapsOf(project).get(item.id);
      if (others) warnings.push(`和「${others.join('」「')}」的 MTC 范围重叠，这段时间码会同时跑两首歌的控台节目，请改开其中一首的起点`);
      const own = item.lighting?.consoleSong;
      if (own?.timecode && own.timecode.offset !== consoleFrames(reading.startMs)) warnings.push(`控台 Timecode ${own.timecode.number} 的起点还是 ${formatMtcOffset(own.timecode.offset * 1000 / 30, frameRate)}，下次同步改成 ${code}`);
      const status = item.referenceAudio ? statusOf(project, item.id) : { state: 'unmatched' as const, reason: null };
      switch (status.state) {
        case 'duplicate': warnings.push(`控台上 Timecode ${status.timecodes.join('、')} 的起点都是 ${code}，分不清用哪一个，请在控台上改开它们的起点或删掉多余的`); break;
        case 'unmatched':
          // A song's own show not on the console yet is made by the next sync; any other reason needs a hand.
          if (status.reason && !(own?.executor && !own.timecode)) warnings.push(status.reason);
          break;
        case 'matched': warnings.push(...status.problems); break;
      }
      if (warnings.length) return { state: 'warning', text, detail: [sends, ...warnings].join('；') };
      if (status.state !== 'matched') return { state: 'set', text, detail: own?.executor && !own.timecode
        ? `${sends}；控台上还没有这首歌的时间码节目，同步时自动建立`
        : `${sends}；控台上没有从这个起点开始的时间码节目，播放不会跑灯` };
      const pending = status.pending ? `还有 ${status.pending} 项改动没同步到控台，停止播放后自动同步` : '';
      return { state: 'matched', text: `${text} · Timecode ${status.timecode}`, detail: [`${sends}；控台 Timecode ${status.timecode} 从同一起点跑灯`, pending, ...status.notes].filter(Boolean).join('；'), ...status.pending ? { pending: status.pending } : {} };
    }
  }
}

/** The MTC badge; with `detail` the explanation follows it as text instead of only as a tooltip. */
export function SongMtcStart({ project, item, detail = false }: { project: LinkProject; item: RundownItem; detail?: boolean }): JSX.Element {
  const allocationError = useMtcStartAllocationStore(state => state.error);
  const view = songMtcView(project, item, allocationError);
  const badge = <span className="song-mtc-start" data-state={view.state} title={view.detail} aria-label={`${view.text}。${view.detail}`}>
    {view.state === 'warning' || view.state === 'invalid' ? <TriangleAlert aria-hidden /> : null}<span className="song-mtc-text">{view.text}</span>{view.pending ? <RefreshCw className="song-mtc-pending" aria-hidden /> : null}
  </span>;
  return detail ? <span className="song-mtc-detail">{badge}<small>{view.detail}</small></span> : badge;
}
