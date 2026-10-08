import { ma2TimecodePreviewSchema, type Ma2TimecodePreview, type LightingDocument, type RundownItem } from '@tb/schema';

/** Playback is the editable origin; P1 retains the imported source value. Old
 * projects may contain only that P1 value. Neither value includes audio trim. */
export function programTimeOrigin(item: Pick<RundownItem, 'playback' | 'p1Media' | 'lighting'>, fallback = 0): number {
  return item.playback?.mtcOffsetMs ?? (item.p1Media ? parseP1TimeOrigin(item.p1Media.midiStartTime) : lightingTimeOrigin(item.lighting, fallback));
}

export function lightingTimeOrigin(document: LightingDocument | undefined, fallback = 0): number {
  const origins = new Set(document?.ma2Bindings?.map(binding => binding.timeOriginMs ?? 0) ?? []);
  if (origins.size > 1) throw new Error('同一歌曲的 MA2 时间线起点不一致，不能输出一个时间码');
  return [...origins][0] ?? fallback;
}

/** P1 stores seconds; colon notation is accepted only as an explicit clock value. */
export function parseP1TimeOrigin(value: string): number {
  let seconds: number;
  if (/^\d+(?:\.\d{1,3})?$/.test(value)) seconds = Number(value);
  else {
    const match = /^(\d{1,2}):([0-5]\d):([0-5]\d(?:\.\d{1,3})?)$/.exec(value);
    if (!match) throw new Error(`P1 起始时间码格式不支持：${value}`);
    seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds >= 86400000) throw new Error('P1 起始时间码超出 24 小时');
  return milliseconds;
}

/** Keep native XML intact; translate only the song-relative editor positions. */
export function withMa2TimeOrigin(input: Ma2TimecodePreview, originMs: number): Ma2TimecodePreview {
  if (!Number.isSafeInteger(originMs) || originMs < 0 || originMs >= 86400000) throw new Error('歌曲时间码起点无效');
  const preview = ma2TimecodePreviewSchema.parse(input);
  const shift = (preview.timeOriginMs ?? 0) - originMs;
  if (shift === 0) return preview;
  for (const track of preview.document.tracks) for (const clip of track.clips) {
    if (clip.timeLock !== 'time') throw new Error('MA2 导入必须使用绝对时间片段');
    const events = clip.events.map(event => ({ ...event, at: event.at + clip.start + shift }));
    if (events.some(event => event.at < -1e-6)) throw new Error('控台包含歌曲起点之前的事件，请拆分跨歌曲时间线或重新配对，不能丢弃事件');
    clip.start = 0;
    clip.events = events.map(event => ({ ...event, at: Math.max(0, event.at) }));
    clip.duration = clip.events.reduce((end, event) => Math.max(end, event.at + 1), 1);
  }
  preview.timeOriginMs = originMs;
  return ma2TimecodePreviewSchema.parse(preview);
}
