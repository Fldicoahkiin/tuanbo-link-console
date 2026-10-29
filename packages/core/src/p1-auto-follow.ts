import type { LinkProject } from '@tb/schema';
import { frameNumberToTimecode, nominalFramesPerSecond, type MtcSample } from './mtc-timecode';
import { nextMtcStartMs, readSongMtcStart } from './mtc-start';
import { songLightingStatus } from './song-lighting-status';

/** The last second a range may reach: P1 1.14.2 loses the high hour bit at 16 hours. */
const P1_LIMIT_SECONDS = 54_000;

/**
 * P1 emits its own offset MTC; no local clock generates playback position. A song keeps the MTC
 * start it already has (P1's own MidiStartTime or one set here), because its console timeline is
 * lined up with it (lighting workflow rules 1 and 3, 2026-10-26). Only songs without a start, or
 * without console lighting and a start P1 cannot follow on, get one: the first whole second at
 * least ten seconds after every song's range. A song lit on the console whose start cannot be kept
 * stops the layout with the reason instead of being moved.
 */
export function allocateP1TimecodeRanges(project: LinkProject): NonNullable<LinkProject['p1AutoFollow']> {
  if (project.timebase.frameRate === '29.97df') throw new Error('P1 自动选歌目前只支持 24、25、30 fps，建议用实测过的 30 fps');
  const songs = project.rundown.filter((value) => value.referenceAudio);
  if (!songs.length) throw new Error('请先导入 P1 工程或为节目添加参考音频');
  const kept = new Map<string, { startSeconds: number; durationMs: number }>();
  for (const item of songs) {
    const durationMs = item.referenceAudio?.durationMs;
    if (!durationMs) throw new Error(`节目缺少音频时长：${item.title}`);
    const reading = readSongMtcStart(item);
    if (reading.state === 'unset') continue;
    const reason = reading.state === 'invalid' ? reading.reason : keepReason(reading.startMs / 1000, durationMs, kept);
    if (!reason && reading.state === 'set') { kept.set(item.id, { startSeconds: reading.startMs / 1000, durationMs }); continue; }
    if (songLightingStatus(project, item.id).state !== 'unmatched') throw new Error(`「${item.title}」的 MTC 起始码不能用于 P1 点歌：${reason}。它的灯光按这个起始码和控台对齐，没有替它换起始码；请在歌曲属性里改 MTC 起始码，并把控台上的时间线移到同一起点后再生成`);
  }
  // Every range taken so far, kept or allocated, so a new start never lands inside an earlier song.
  const occupied = [...kept.values()].map((range) => ({ startMs: range.startSeconds * 1000, endMs: range.startSeconds * 1000 + range.durationMs }));
  const ranges = songs.map((item) => {
    const durationMs = item.referenceAudio!.durationMs;
    const own = kept.get(item.id);
    if (own) return { itemId: item.id, ...own };
    const startMs = nextMtcStartMs(occupied, durationMs, P1_LIMIT_SECONDS * 1000);
    occupied.push({ startMs, endMs: startMs + durationMs });
    return { itemId: item.id, startSeconds: startMs / 1000, durationMs };
  });
  return { enabled: true, ranges };
}

/** Why P1 cannot follow a song from this start: whole seconds, from one minute, clear of the kept songs and inside 15 hours. */
function keepReason(startSeconds: number, durationMs: number, kept: ReadonlyMap<string, { startSeconds: number; durationMs: number }>): string | null {
  if (!Number.isInteger(startSeconds)) return `${startSeconds} 秒不是整秒`;
  if (startSeconds < 60) return `${startSeconds} 秒早于 1 分钟`;
  const end = startSeconds + durationMs / 1000 + 1;
  if (end >= P1_LIMIT_SECONDS) return '加上歌曲时长超出 15 小时';
  if ([...kept.values()].some((range) => startSeconds < range.startSeconds + range.durationMs / 1000 + 1 && range.startSeconds < end)) return '和另一首歌的时间码范围重叠';
  return null;
}

export function validateP1TimecodeRanges(project: LinkProject): void {
  const config = project.p1AutoFollow;
  if (!config?.enabled) return;
  if (project.timebase.frameRate === '29.97df') throw new Error('自动选歌不支持 29.97df');
  const ids = new Set<string>();
  let end = 0;
  for (const range of [...config.ranges].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const item = project.rundown.find((candidate) => candidate.id === range.itemId);
    if (!item?.referenceAudio || item.referenceAudio.durationMs !== range.durationMs || ids.has(range.itemId)) {
      throw new Error('P1 自动联动的对应关系已过期，请重新生成点歌联动工程');
    }
    if (range.startSeconds < end || range.startSeconds + range.durationMs / 1000 + 1 >= 54_000) {
      throw new Error('P1 自动联动的时间区间重叠或超出范围');
    }
    ids.add(range.itemId);
    end = range.startSeconds + range.durationMs / 1000 + 1;
  }
  if (project.rundown.some((item) => item.referenceAudio && !ids.has(item.id))) {
    throw new Error('新加的歌还没同步到 P1，请重新生成点歌联动工程');
  }
}

export function locateP1Sample(project: LinkProject, sample: MtcSample): { itemId: string; sample: MtcSample } | null {
  if (sample.frameRate !== project.timebase.frameRate || sample.direction !== 'forward') return null;
  const fps = nominalFramesPerSecond(sample.frameRate);
  const range = project.p1AutoFollow?.ranges.find((entry) => sample.totalFrames >= entry.startSeconds * fps
    && sample.totalFrames < (entry.startSeconds + entry.durationMs / 1000 + 1) * fps);
  if (!range || !project.rundown.find((item) => item.id === range.itemId)?.enabled) return null;
  const totalFrames = sample.totalFrames - range.startSeconds * fps;
  return { itemId: range.itemId, sample: { ...sample, totalFrames, timecode: frameNumberToTimecode(totalFrames, sample.frameRate) } };
}
