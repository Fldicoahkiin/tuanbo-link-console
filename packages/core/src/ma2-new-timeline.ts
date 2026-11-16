import { createLightingDocument, ma2TimelineDestinationSchema, parseLinkProject, type Ma2TimelineDestination } from '@tb/schema';
import { songDurationMs } from './audio-edit';
import type { LinkCommand } from './link-command';
import { programTimeOrigin } from './ma2-time-origin';
import { ma2ShowStartTicks, sameMtcStart } from './ma2-program-matching';

export function newMa2TimelineCommand(itemId: string, input: Ma2TimelineDestination, startMs: number): LinkCommand {
  const destination = ma2TimelineDestinationSchema.parse(input);
  return { id: crypto.randomUUID(), label: '新建控台时间线', undo: before => before, execute(project) {
    const item = project.rundown.find(value => value.id === itemId);
    if (!item?.referenceAudio) throw new Error('请先给节目添加音乐');
    if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs >= 86400000) throw new Error('MTC 起始码无效');
    const usedSequences = new Set<number>();
    const usedTimecodes = new Set<number>(project.ma2ReadState?.catalog.directory.entries.map(entry => entry.target));
    const usedExecutors = new Set<string>();
    for (const song of project.rundown) {
      const own = song.lighting?.consoleSong; const planned = song.lighting?.timelineDestination;
      if (own) usedSequences.add(own.sequence);
      if (planned) { usedSequences.add(planned.sequence); usedTimecodes.add(planned.timecode); usedExecutors.add(planned.executor); }
      if (own?.timecode) usedTimecodes.add(own.timecode.number);
      if (own?.executor) usedExecutors.add(own.executor);
      for (const binding of song.lighting?.ma2Bindings ?? []) usedTimecodes.add(binding.timecode);
    }
    for (const other of project.rundown) {
      if (other.id === itemId) continue;
      if (other.referenceAudio && (other.playback || other.p1Media) && sameMtcStart(startMs, programTimeOrigin(other) * 30 / 1000)) throw new Error(`MTC 起始码与「${other.title}」重复，请使用不同的起始码`);
    }
    for (const entry of project.ma2ReadState?.catalog.entries ?? []) {
      usedTimecodes.add(entry.target);
      const ticks = ma2ShowStartTicks(entry);
      if (ticks !== null && sameMtcStart(startMs, ticks)) throw new Error(`该 MTC 起始码对应控台 Timecode ${entry.target}；若要新建，请使用不同的起始码`);
    }
    const resolved = { ...destination };
    const sameNumber = resolved.sequence === resolved.timecode;
    while ((usedSequences.has(resolved.sequence) || sameNumber && usedTimecodes.has(resolved.sequence)) && resolved.sequence < 99999) resolved.sequence++;
    if (usedSequences.has(resolved.sequence) || sameNumber && usedTimecodes.has(resolved.sequence)) throw new Error('指定编号之后没有空闲的序列编号');
    if (sameNumber) resolved.timecode = resolved.sequence;
    while (usedTimecodes.has(resolved.timecode) && resolved.timecode < 99999) resolved.timecode++;
    if (usedTimecodes.has(resolved.timecode)) throw new Error('指定编号之后没有空闲的 Timecode 编号');
    let [page, slot] = resolved.executor.split('.').map(Number) as [number, number];
    const firstSlot = slot >= 201 ? 201 : slot >= 101 ? 101 : 1;
    const lastSlot = firstSlot === 201 ? 240 : firstSlot === 101 ? 190 : 90;
    while (usedExecutors.has(`${page}.${slot}`)) { if (slot >= lastSlot) { page++; slot = firstSlot; } else slot++; }
    if (page > 9999) throw new Error('指定位置之后没有空闲的执行器格位');
    resolved.executor = `${page}.${slot}`;
    const lighting = createLightingDocument();
    lighting.timelineDestination = resolved;
    lighting.tracks = [{ id: crypto.randomUUID(), kind: 'ma2', name: destination.name, color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
      clips: [{ id: crypto.randomUUID(), name: destination.name, start: 0, duration: Math.max(1, songDurationMs(item.referenceAudio)), timeLock: 'time', events: [], muted: false }] }];
    const playback = { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, shortcut: '', ...item.playback, mtcOffsetMs: startMs };
    return parseLinkProject({ ...project, schemaVersion: Math.max(2, project.schemaVersion), updatedAt: new Date().toISOString(), rundown: project.rundown.map(value => value.id === itemId ? { ...value, playback, lighting } : value) });
  } };
}
