import { TriangleAlert } from 'lucide-react';
import { formatMtcOffset, readSongMtcStart, songMtcOverlaps, songsNeedingMtcStart } from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useMtcStartAllocationStore } from '../stores/mtc-start-allocation-store';
import '../song-mtc-start.css';

export type SongMtcView = { state: 'set' | 'warning' | 'unset' | 'invalid'; text: string; detail: string };

// Overlaps compare every song; edits replace the project object, so one result per project version.
const overlapsByProject = new WeakMap<LinkProject, Map<string, string[]>>();
function overlapsOf(project: LinkProject): Map<string, string[]> {
  let overlaps = overlapsByProject.get(project);
  if (!overlaps) { overlaps = songMtcOverlaps(project); overlapsByProject.set(project, overlaps); }
  return overlaps;
}

/** MA2 keeps a show's offset in 1/30 s whatever its frame format. */
const consoleFrames = (ms: number): number => Math.round(ms * 30 / 1000);

/**
 * The song's MTC start as the lighting flow shows it: the timecode the song sends from its first
 * frame, which is also where its own console Timecode show starts. `allocationError` is why the last
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
        : '开始编灯后连上控台自动分配；配对控台已有的时间线时用节目起点；也可以在歌曲属性里填写' };
    case 'set': {
      const code = formatMtcOffset(reading.startMs, frameRate);
      const show = item.lighting?.consoleSong?.timecode;
      const warnings: string[] = [];
      const others = overlapsOf(project).get(item.id);
      if (others) warnings.push(`和「${others.join('」「')}」的 MTC 范围重叠，这段时间码会同时跑两首歌的控台节目，请改开其中一首的起点`);
      if (show && show.offset !== consoleFrames(reading.startMs)) warnings.push(`控台 Timecode ${show.number} 的起点还是 ${formatMtcOffset(show.offset * 1000 / 30, frameRate)}，下次同步改成 ${code}`);
      if (warnings.length) return { state: 'warning', text: `MTC ${code}`, detail: warnings.join('；') };
      return { state: 'set', text: `MTC ${code}`, detail: show
        ? `本曲从 ${code} 开始发送时间码；控台 Timecode ${show.number}（${show.slot}）从同一起点跑灯`
        : `本曲从 ${code} 开始发送时间码` };
    }
  }
}

/** The MTC badge; with `detail` the explanation follows it as text instead of only as a tooltip. */
export function SongMtcStart({ project, item, detail = false }: { project: LinkProject; item: RundownItem; detail?: boolean }): JSX.Element {
  const allocationError = useMtcStartAllocationStore(state => state.error);
  const view = songMtcView(project, item, allocationError);
  const badge = <span className="song-mtc-start" data-state={view.state} title={view.detail} aria-label={`${view.text}。${view.detail}`}>
    {view.state === 'warning' || view.state === 'invalid' ? <TriangleAlert aria-hidden /> : null}{view.text}
  </span>;
  return detail ? <span className="song-mtc-detail">{badge}<small>{view.detail}</small></span> : badge;
}
