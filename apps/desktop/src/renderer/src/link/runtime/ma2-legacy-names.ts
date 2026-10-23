import { confirmMa2RenameCommand, consoleLabelText, legacyMa2Renames, toConsoleLabel } from '@tb/core/link';
import { ma2RenameResultSchema, type LinkProject, type Ma2RenameRecord } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { archiveMa2Project } from './ma2-project-archive';
import { ma2SongSyncSettings, startMa2SongSync, useMa2SongSyncStore } from './ma2-song-sync';
import { useMa2AutoSyncStore } from '../stores/ma2-auto-sync-store';
import { useMa2RealtimePreference } from './ma2-realtime-preference';

/** Names an earlier version wrote to the console in Chinese and the console still holds. */
export function legacyMa2ConsoleNames(project: LinkProject | null): { songs: string[]; renames: Ma2RenameRecord[]; count: number } {
  const saved = project?.ma2MaterialLibrary;
  const library = saved?.library;
  if (!project || !saved || !library) return { songs: [], renames: [], count: 0 };
  const chinese = (name: string | null | undefined): name is string => !!name && consoleLabelText(name) !== name;
  let count = 0;
  const songs = project.rundown.flatMap(item => {
    const song = item.lighting?.consoleSong;
    if (!item.lighting || !song || song.endpoint !== saved.source || song.show !== library.directory.show) return [];
    const sequence = library.sequences.find(value => value.sequence === song.sequence);
    if (!sequence) return [];
    const labels = new Map(item.lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).flatMap(event => event.kind === 'ma2' || event.kind === 'empty-cue' ? [[event.id, event.label] as const] : []));
    const cues = song.points.filter(point => {
      const label = labels.get(point.id);
      return chinese(label) && sequence.cues.find(cue => Number(cue.number) === Number(point.cue))?.name === label;
    }).length;
    const total = cues + (chinese(song.name) && sequence.name === song.name ? 1 : 0);
    count += total;
    return total ? [item.id] : [];
  });
  const renames = legacyMa2Renames(project).filter(change => change.endpoint === saved.source && change.show === library.directory.show);
  return { songs, renames, count: count + renames.length };
}

/** The operator's explicit request: rewrite those names as pinyin, songs through their next sync. */
export async function convertMa2LegacyNames(documentId: number): Promise<number> {
  const current = (): LinkProject => {
    const state = useDocumentStore.getState();
    if (state.documentId !== documentId) throw new Error('工程已切换，名称转换已取消');
    if (!state.project || !state.path) throw new Error('请先保存工程，再把控台名称改为拼音');
    return state.project;
  };
  const playback = useMa2AutoSyncStore.getState();
  if (playback.timelinePlaying || playback.previewPlaying) throw new Error('播放中不改控台名称，请停止后再转换');
  const project = current();
  const legacy = legacyMa2ConsoleNames(project);
  if (!legacy.count) return 0;
  if (legacy.songs.length && !useMa2RealtimePreference.getState().enabled) throw new Error('请先开启实时同步，歌曲名称会在同步时改为拼音');
  for (const itemId of legacy.songs) {
    if (!useMa2SongSyncStore.getState().songs[itemId] || useMa2SongSyncStore.getState().songs[itemId]?.state === 'paused') {
      const item = project.rundown.find(value => value.id === itemId)!;
      startMa2SongSync(itemId, item.lighting?.consoleSong?.name ?? item.title, ma2SongSyncSettings(project, itemId));
    }
    useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, [itemId]: { ...state.songs[itemId]!, rewriteLegacyNames: true, state: 'pending', nextCheckAt: 0, message: '等待把控台上的中文名称改为拼音' } } }));
  }
  if (!legacy.renames.length) return legacy.count;
  const status = await window.tbLink.getMa2NetworkStatus();
  if (status.state !== 'connected' || !status.settings) throw new Error('请先连接控台');
  const { host, port, monitorPort, username } = status.settings;
  const library = current().ma2MaterialLibrary?.library;
  if (!library) throw new Error('请先读取控台素材');
  await archiveMa2Project(documentId, current());
  for (const change of legacy.renames) {
    const result = ma2RenameResultSchema.parse(await window.tbLink.renameMa2Object({ dataDirectory: '', network: { host, port, monitorPort, username }, generation: library.directory.generation, change }));
    if (result.name !== toConsoleLabel(change.name) || result.sequence !== change.sequence || result.kind !== change.kind || Number(result.cue) !== Number(change.cue)) throw new Error('名称回读与目标不一致，未确认转换');
    useDocumentStore.getState().executeForDocument(documentId, confirmMa2RenameCommand(change));
    useDocumentStore.getState().markConsoleSynced(documentId);
  }
  return legacy.count;
}
