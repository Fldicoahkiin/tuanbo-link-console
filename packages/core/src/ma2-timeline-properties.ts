import { ma2LabelSchema, parseLinkProject, type Ma2TimecodePreview } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { pairSongWithMa2ShowCommand } from './ma2-pairing-state';
import { programTimeOrigin } from './ma2-time-origin';
import { sameMtcStart } from './ma2-program-matching';

export function editMa2TimelinePropertiesCommand(target: number, name: string, startMs: number, fresh?: Ma2TimecodePreview): LinkCommand {
  const label = ma2LabelSchema.parse(name);
  if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs >= 86400000) throw new Error('MTC 起始码无效');
  return { id: crypto.randomUUID(), label: '修改控台时间线', undo: before => before, execute(project) {
    const owner = project.rundown.find(item => item.lighting?.consoleSong?.timecode?.number === target || item.lighting?.timelineDestination?.timecode === target || item.lighting?.ma2Bindings?.some(binding => binding.timecode === target));
    if (owner && project.rundown.some(item => item.id !== owner.id && (item.playback || item.p1Media) && sameMtcStart(programTimeOrigin(item), startMs * 30 / 1000))) throw new Error('起始码与另一个节目重复，请使用不同的起始码');
    const next = structuredClone(project);
    const song = next.rundown.find(item => item.id === owner?.id);
    if (song?.lighting?.consoleSong || song?.lighting?.timelineDestination) {
      if (song.lighting.consoleSong) song.lighting.consoleSong.name = label;
      if (song.lighting.timelineDestination) song.lighting.timelineDestination.name = label;
      song.playback = { volume: 100, startMs: 0, endMs: 0, shortcut: '', ...song.playback, mtcOffsetMs: startMs };
      return parseLinkProject(next);
    }
    if (!fresh || fresh.target !== target) throw new Error('请先从控台读取并确认修改结果');
    const entry = next.ma2ReadState?.catalog.entries.find(value => value.target === target);
    if (!entry) throw new Error('请先刷新控台时间线');
    Object.assign(entry, { name: fresh.name, offset: String(startMs * 30 / 1000), preview: fresh, sourceXml: fresh.sourceXml, error: null });
    delete entry.conversionError;
    if (song) return pairSongWithMa2ShowCommand(song.id, target, fresh).execute(next);
    return parseLinkProject(next);
  } };
}
