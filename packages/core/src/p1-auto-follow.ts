import type { LinkProject } from '@tb/schema';
import { frameNumberToTimecode, nominalFramesPerSecond, type MtcSample } from './mtc-timecode';

/** P1 emits its own offset MTC; no local clock generates playback position. */
export function allocateP1TimecodeRanges(project: LinkProject): NonNullable<LinkProject['p1AutoFollow']> {
  if (project.timebase.frameRate === '29.97df') throw new Error('P1 自动选歌暂支持 24、25、30 fps；请使用实测的 30 fps');
  let startSeconds = 60;
  const ranges = project.rundown.filter((item) => item.referenceAudio).map((item) => {
    const durationMs = item.referenceAudio?.durationMs;
    if (!durationMs) throw new Error(`节目缺少音频时长：${item.title}`);
    const range = { itemId: item.id, startSeconds, durationMs };
    startSeconds += Math.ceil(durationMs / 1000) + 10;
    return range;
  });
  if (!ranges.length) throw new Error('请先导入 P1 工程或为节目添加参考音频');
  // Real P1 captures verified hours 1 and 15; hour 16 loses the high hour bit.
  if (startSeconds >= 54_000) throw new Error('此版 P1 的自动选歌工程总时长（含歌曲间隔）必须小于 15 小时；请拆分工程');
  return { enabled: true, ranges };
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
      throw new Error('P1 自动映射已过期，请重新生成点击播放联动工程');
    }
    if (range.startSeconds < end || range.startSeconds + range.durationMs / 1000 + 1 >= 54_000) {
      throw new Error('P1 自动映射区间重叠或超出已验证范围');
    }
    ids.add(range.itemId);
    end = range.startSeconds + range.durationMs / 1000 + 1;
  }
  if (project.rundown.some((item) => item.referenceAudio && !ids.has(item.id))) {
    throw new Error('新增歌曲尚未同步到 P1，请重新生成点击播放联动工程');
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
