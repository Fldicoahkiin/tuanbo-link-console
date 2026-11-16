import { editMa2TimelinePropertiesCommand, pairSongWithMa2ShowCommand, ma2PendingChanges } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { currentShowWait } from '../stores/show-state-store';
import { archiveMa2Project } from './ma2-project-archive';
import { readMa2ShowNow } from './ma2-console-version';
import { stopMa2SongSync } from './ma2-song-sync';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { syncMa2Once } from './ma2-realtime-session';

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


export async function changeMa2TimelineProperties(target: number, name: string, startMs: number): Promise<string> {
  const before = useDocumentStore.getState(); const project = before.project;
  if (!project) throw new Error('请先打开工程');
  const item = project.rundown.find(value => value.lighting?.consoleSong?.timecode?.number === target || value.lighting?.timelineDestination?.timecode === target || value.lighting?.ma2Bindings?.some(binding => binding.timecode === target));
  const wait = timelineActionWait(item?.id ?? ''); if (wait) throw new Error(wait);
  if (item?.lighting?.consoleSong || item?.lighting?.timelineDestination) {
    before.execute(editMa2TimelinePropertiesCommand(target, name, startMs));
    syncMa2Once(item.id); return '已保存修改，正在同步到原控台位置。';
  }
  if (ma2PendingChanges(project).some(change => change.itemId === item?.id && change.target === target)) throw new Error('当前 Cue 有未同步修改，请先同步 Cue 后再修改名称和起始码');
  const entry = project.ma2ReadState?.catalog.entries.find(value => value.target === target);
  if (!entry || entry.error || !entry.preview || !project.ma2ReadState || project.ma2ReadState.catalog.sourceUnverified) throw new Error('请先刷新并完整读取这条控台时间线');
  editMa2TimelinePropertiesCommand(target, name, startMs, entry.preview).execute(project);
  if (item && !await archiveMa2Project(before.documentId, project, 'manual')) throw new Error('原编排未能存档，未修改控台');
  const connection = await ma2MaterialConnection();
  if (useDocumentStore.getState().project !== project) throw new Error('工程已变化，请重试');
  const waiting = timelineActionWait(item?.id ?? ''); if (waiting) throw new Error(waiting);
  const directory = project.ma2ReadState.catalog.directory;
  if (item) stopMa2SongSync(item.id);
  await window.tbLink.editMa2Timeline({ ...connection, target, name, startMs, expectedName: entry.name, expectedOffset: Number(entry.offset ?? 0), expectedSource: { show: directory.show, generation: directory.generation, version: directory.version } });
  try {
    const fresh = await window.tbLink.previewMa2({ ...connection, target, timeOriginMs: startMs });
    const latest = useDocumentStore.getState();
    if (latest.project !== project || latest.documentId !== before.documentId) throw new Error('工程在修改期间发生变化');
    latest.execute(editMa2TimelinePropertiesCommand(target, name, startMs, fresh));
    return '控台名称和 MTC 起始码已修改并读回确认。';
  } catch (error) { throw new Error(`控台已修改，但软件尚未更新，请刷新时间线：${error instanceof Error ? error.message : String(error)}`); }
}
