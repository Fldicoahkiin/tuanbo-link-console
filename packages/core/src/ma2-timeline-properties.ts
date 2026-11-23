import { ma2LabelSchema, parseLinkProject, type LinkProject, type Ma2TimecodePreview, type Ma2TimecodeRanges } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { programTimeOrigin } from './ma2-time-origin';
import { sameMtcStart } from './ma2-program-matching';
import { checkMa2MtcStart, ma2MtcSeparation } from './ma2-mtc-selection';
import { MA2_SONG_TIMECODE_SLOT, ma2MtcGapTicks, readSongMtcStart } from './mtc-start';
import { songDurationMs } from './audio-edit';

export function ma2TimelineOwner(project: LinkProject, target: number) {
  return project.rundown.find(item => item.lighting?.consoleSong?.timecode?.number === target || item.lighting?.timelineDestination?.timecode === target || item.lighting?.ma2Bindings?.some(binding => binding.timecode === target));
}

function checkSongStart(project: LinkProject, ownerId: string | undefined, startMs: number): void {
  const other = ownerId && project.rundown.find(item => item.id !== ownerId && (item.playback || item.p1Media) && sameMtcStart(programTimeOrigin(item), startMs * 30 / 1000));
  if (other) throw new Error(`起始码与节目「${other.title}」重复，请使用不同的起始码`);
}

export function checkMa2TimelineStart(project: LinkProject, ranges: Ma2TimecodeRanges, target: number, startMs: number): void {
  const owner = ma2TimelineOwner(project, target);
  checkSongStart(project, owner?.id, startMs);
  const planned = owner?.lighting?.timelineDestination?.timecode === target && !owner.lighting.consoleSong?.timecode;
  const duration = owner?.referenceAudio ? songDurationMs(owner.referenceAudio) : 0;
  const interval = checkMa2MtcStart(ranges.entries, target, startMs, duration, planned, ranges.afterRollSeconds);
  const slots = new Map(ranges.entries.map(entry => [entry.target, entry.slot]));
  const slot = slots.get(target) ?? MA2_SONG_TIMECODE_SLOT;
  for (const song of project.rundown) {
    if (song.id === owner?.id || !song.referenceAudio) continue;
    const otherTarget = song.lighting?.consoleSong?.timecode?.number ?? song.lighting?.timelineDestination?.timecode ?? song.lighting?.ma2Bindings?.[0]?.timecode;
    if ((otherTarget && slots.get(otherTarget) || MA2_SONG_TIMECODE_SLOT) !== slot) continue;
    const reading = readSongMtcStart(song);
    if (reading.state !== 'set') continue;
    const start = Math.round(reading.startMs * 30 / 1000);
    const end = start + Math.ceil(songDurationMs(song.referenceAudio) * 30 / 1000);
    const gap = ma2MtcSeparation(interval, { start, end });
    if (gap >= 0 && slot === MA2_SONG_TIMECODE_SLOT && gap < ma2MtcGapTicks(ranges.afterRollSeconds)) throw new Error(`与节目「${song.title}」至少需要间隔 ${ma2MtcGapTicks(ranges.afterRollSeconds) / 30} 秒`);
    if (gap < 0) throw new Error(`这个时段已分给节目「${song.title}」，请输入其他起始码`);
  }
}

export function editMa2TimelinePropertiesCommand(target: number, name: string, startMs: number, fresh?: Ma2TimecodePreview, movedBindingXml?: string): LinkCommand {
  const label = ma2LabelSchema.parse(name);
  if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs >= 86400000) throw new Error('MTC 起始码无效');
  return { id: crypto.randomUUID(), label: '修改控台时间线', undo: before => before, execute(project) {
    const owner = ma2TimelineOwner(project, target);
    checkSongStart(project, owner?.id, startMs);
    const next = structuredClone(project);
    const song = next.rundown.find(item => item.id === owner?.id);
    const own = song?.lighting?.consoleSong?.timecode?.number === target || song?.lighting?.timelineDestination?.timecode === target;
    if (song) {
      song.playback = { volume: song.p1Media?.volume ?? 100, startMs: 0, endMs: 0, shortcut: song.p1Media?.shortcut ?? '', ...song.playback, mtcOffsetMs: startMs };
    }
    if (own && song?.lighting) {
      if (song.lighting.consoleSong) song.lighting.consoleSong.name = label;
      if (song.lighting.timelineDestination?.timecode === target) song.lighting.timelineDestination.name = label;
      if (!fresh) return parseLinkProject(next);
    }
    if (!fresh || fresh.target !== target) throw new Error('请先从控台读取并确认修改结果');
    const entry = next.ma2ReadState?.catalog.entries.find(value => value.target === target);
    if (!entry) throw new Error('请先刷新控台时间线');
    Object.assign(entry, { name: fresh.name, offset: String(Math.round(startMs * 30 / 1000)), preview: fresh, sourceXml: fresh.sourceXml, error: null });
    delete entry.conversionError;
    const listed = next.ma2ReadState?.catalog.directory.entries.find(value => value.target === target);
    if (listed) listed.name = fresh.name;
    if (own && song?.lighting?.consoleSong?.timecode?.number === target) {
      song.lighting.consoleSong.timecode.offset = Math.round(startMs * 30 / 1000);
    }
    const binding = song?.lighting?.ma2Bindings?.find(value => value.timecode === target);
    if (binding) Object.assign(binding, { name: fresh.name, timeOriginMs: startMs, readAt: fresh.readAt, sourceXml: movedBindingXml ?? fresh.sourceXml });
    if (next.ma2ReadState) next.ma2ReadState.failures = next.ma2ReadState.failures.filter(failure => failure.target !== target);
    return parseLinkProject(next);
  } };
}
