import { checkMa2TimelineStart, editMa2TimelinePropertiesCommand, ma2MtcConflictTargets, ma2TimelineOwner, pairSongWithMa2ShowCommand, songDurationMs } from '@tb/core/link';
import { ma2LabelSchema, type LinkProject, type Ma2CatalogRequest, type Ma2TimecodeRanges } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { currentShowWait } from '../stores/show-state-store';
import { archiveMa2Project } from './ma2-project-archive';
import { readMa2ShowNow } from './ma2-console-version';
import { stopMa2SongSync } from './ma2-song-sync';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { syncMa2Once } from './ma2-realtime-session';
import { useMa2RealtimePreference } from './ma2-realtime-preference';

export function timelineActionWait(itemId: string): string | null {
  const state = useMa2SyncStore.getState().songs[itemId];
  return state?.requestId || state?.checking || state?.writing ? '当前节目正在同步，请等待完成' : currentShowWait('ma2.sync.write');
}

/** The same action for the list button and context menu; no additional import/append mode. */
export async function selectMa2Timeline(itemId: string, target: number): Promise<string> {
  const before = useDocumentStore.getState(); const project = before.project;
  const item = project?.rundown.find(value => value.id === itemId);
  if (!project || !item) throw new Error('请先选择节目');
  const wait = timelineActionWait(itemId); if (wait) throw new Error(wait);
  const own = item.lighting?.consoleSong?.timecode?.number ?? item.lighting?.timelineDestination?.timecode;
  if (own === target) { syncMa2Once(itemId); return '同步请求已提交，结果见当前时间线状态。'; }
  const fresh = await readMa2ShowNow(target, undefined);
  if (useDocumentStore.getState().project !== project) throw new Error('读取期间工程已改变，请重试');
  const command = pairSongWithMa2ShowCommand(itemId, target, fresh ?? undefined);
  command.execute(project);
  const lighting = item.lighting;
  if (lighting && (lighting.tracks.length || lighting.consoleSong || lighting.ma2Bindings?.length || lighting.timelineDestination)) {
    if (!await archiveMa2Project(before.documentId, project, 'manual')) throw new Error('原编排未能存档，未更换时间线');
  }
  const latest = useDocumentStore.getState();
  if (latest.project !== project || latest.documentId !== before.documentId) throw new Error('存档期间工程有变化，请重试');
  const waiting = timelineActionWait(itemId); if (waiting) throw new Error(waiting);
  stopMa2SongSync(itemId); latest.execute(command);
  const result = useDocumentStore.getState().project?.rundown.find(value => value.id === itemId)?.lighting;
  const count = result?.tracks.reduce((sum, track) => sum + track.clips.reduce((n, clip) => n + clip.events.length, 0), 0) ?? 0;
  return `已关联 Timecode ${target}，载入 ${count} 个 Cue${fresh ? '（刚从控台读取）' : '（使用上次读取结果）'}。`;
}


function checkRangeSource(project: LinkProject, connection: Ma2CatalogRequest, ranges: Ma2TimecodeRanges, conflict: boolean): void {
  const read = project.ma2ReadState;
  const material = conflict ? project.ma2MaterialLibrary : undefined;
  const directory = material?.library?.directory ?? read?.catalog.directory;
  const source = connection.network ? `${connection.network.host}:${connection.network.port}` : '本机 onPC';
  if (directory && ((material?.source ?? read?.source) !== source || directory.show !== ranges.show || directory.generation !== ranges.generation)) {
    throw new Error('控台或 Show 已改变，请刷新控台时间线后再修改');
  }
}

export async function readMa2EditingRanges(conflict = false): Promise<Ma2TimecodeRanges> {
  const before = useDocumentStore.getState();
  const connection = await ma2MaterialConnection(true);
  const ranges = await window.tbLink.ma2TimecodeRanges(connection.network ?? { dataDirectory: connection.dataDirectory });
  const latest = useDocumentStore.getState();
  if (!latest.project || latest.documentId !== before.documentId) throw new Error('工程已切换，请重新打开时间线');
  checkRangeSource(latest.project, connection, ranges, conflict);
  return ranges;
}

export async function changeMa2TimelineProperties(target: number, name: string, startMs: number, options?: { ranges?: Ma2TimecodeRanges; keepName?: boolean; conflictItemId?: string }): Promise<{ message: string; warning?: string }> {
  const before = useDocumentStore.getState(); const project = before.project;
  if (!project) throw new Error('请先打开工程');
  const item = ma2TimelineOwner(project, target);
  const wait = timelineActionWait(item?.id ?? ''); if (wait) throw new Error(wait);
  const owned = item?.lighting?.consoleSong?.timecode?.number === target;
  const reserved = item?.lighting?.timelineDestination?.timecode === target && !item.lighting.consoleSong?.timecode;
  if (options?.ranges) checkMa2TimelineStart(project, options.ranges, target, startMs);
  if (item && (reserved && !options?.ranges?.entries.some(entry => entry.target === target) || owned && !options?.ranges)) {
    if (reserved && options?.ranges) {
      const live = await readMa2EditingRanges();
      if (live.show !== options.ranges.show || live.generation !== options.ranges.generation) throw new Error('控台或 Show 已改变，请重新检查起始码');
      if (live.entries.some(entry => entry.target === target)) throw new Error(`控台刚占用了 Timecode ${target}，请刷新时间线后再修改`);
      checkMa2TimelineStart(project, live, target, startMs);
      if (useDocumentStore.getState().project !== project) throw new Error('工程已变化，请重试');
    }
    before.execute(editMa2TimelinePropertiesCommand(target, name, startMs));
    syncMa2Once(item.id); return { message: '已保存修改，正在同步到原控台位置。' };
  }
  const binding = item?.lighting?.ma2Bindings?.find(value => value.timecode === target);
  const entry = project.ma2ReadState?.catalog.entries.find(value => value.target === target);
  const sourceEntry = options?.ranges?.entries.find(value => value.target === target) ?? entry;
  const verifiedDirectory = options?.conflictItemId ? project.ma2MaterialLibrary?.library?.directory : undefined;
  const directory = verifiedDirectory ?? project.ma2ReadState?.catalog.directory;
  const external = !item && !entry && Boolean(verifiedDirectory && options?.ranges);
  if (!sourceEntry || !directory || (!external && (!entry || project.ma2ReadState?.catalog.sourceUnverified))) throw new Error('请先刷新并读取这条控台时间线');
  ma2LabelSchema.parse(name);
  if (item && !await archiveMa2Project(before.documentId, project, 'manual')) throw new Error('原编排未能存档，未修改控台');
  const connection = await ma2MaterialConnection(true);
  if (options?.ranges) checkRangeSource(project, connection, options.ranges, Boolean(options.conflictItemId));
  function currentDocument() {
    const latest = useDocumentStore.getState();
    if (!latest.project || latest.documentId !== before.documentId || ma2TimelineOwner(latest.project, target) !== item
      || latest.project.ma2ReadState?.catalog.entries.find(value => value.target === target) !== entry
      || latest.project.ma2ReadState?.catalog.directory !== project?.ma2ReadState?.catalog.directory) throw new Error('这条时间线或工程已改变，请重新打开后再修改');
    return latest;
  }
  const currentProject = currentDocument().project;
  if (currentProject && options?.ranges) checkMa2TimelineStart(currentProject, options.ranges, target, startMs);
  const waiting = timelineActionWait(item?.id ?? ''); if (waiting) throw new Error(waiting);
  const resume = item && useMa2RealtimePreference.getState().enabled && useMa2SyncStore.getState().songs[item.id]?.state !== 'paused';
  if (item) stopMa2SongSync(item.id);
  let confirmed = false;
  try {
    const result = await window.tbLink.editMa2Timeline({ ...connection, target, name, startMs, ...(options?.keepName ? { keepName: true } : {}),
      bindingSourceXml: binding?.sourceXml, minimumDurationMs: item?.referenceAudio ? songDurationMs(item.referenceAudio) : 0,
      expectedName: options?.ranges ? sourceEntry.name : entry?.preview?.name ?? sourceEntry.name, expectedOffset: Number(sourceEntry.offset ?? 0),
      expectedSource: { show: directory.show, generation: directory.generation, version: directory.version } });
    confirmed = true;
    const fresh = await window.tbLink.previewMa2({ ...connection, target, timeOriginMs: startMs,
      expectedSource: { show: directory.show, generation: directory.generation, version: directory.version } });
    const latest = currentDocument();
    const sameName = fresh.name === result.name || !result.name && fresh.name === `Timecode ${target}`;
    if (fresh.timing?.offsetNative === undefined || Number(fresh.timing.offsetNative) !== Math.round(startMs * 30 / 1000) || !sameName) throw new Error('控台时间线又有改动');
    if (!external) latest.execute(editMa2TimelinePropertiesCommand(target, options?.keepName && result.name || name, startMs, fresh, result.bindingSourceXml));
    if (!result.selectionWarning && options?.conflictItemId) {
      syncMa2Once(options.conflictItemId);
    } else if (item && resume && useMa2RealtimePreference.getState().enabled) syncMa2Once(item.id);
    if (!result.selectionWarning && !options?.conflictItemId && useMa2RealtimePreference.getState().enabled) {
      for (const song of Object.values(useMa2SyncStore.getState().songs)) {
        if (song.state === 'blocked' && ma2MtcConflictTargets(song.message)?.includes(target)) syncMa2Once(song.itemId);
      }
    }
    const saved = `Timecode ${target} 的修改已由控台确认。`;
    return { message: saved, ...(result.selectionWarning ? { warning: `控台选曲尚未就绪：${result.selectionWarning}` } : {}) };
  } catch (error) {
    if (!confirmed) throw error;
    throw new Error(`控台已修改，工程尚未更新，请刷新时间线：${error instanceof Error ? error.message : String(error)}`);
  }
}
