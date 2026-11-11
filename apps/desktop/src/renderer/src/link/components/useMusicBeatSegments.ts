import { useCallback, useEffect, useState } from 'react';
import { acceptMusicStructure, clearedSongMusic, editMusicStructure, setSongMusicCommand, songBeats, songMusicAudio, songMusicSource, songTimeToMusicSource, type PlacedSongBeats, type SongBeatSegment } from '@tb/core/link';
import type { RundownItem, SongMusic } from '@tb/schema';
import type { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import { useRuntimeStore } from '../stores/runtime-store';
import { useDocumentStore } from '../stores/document-store';

// Mounting a tab again must not undo cancellation or reapply an undone result.
const attempted = new Set<string>();
const delivered = new Set<string>();
const requested = new Set<string>();
const remember = (set: Set<string>, key: string): void => { set.add(key); if (set.size > 2000) set.delete(set.values().next().value!); };

/**
 * The song's beats and sections for the lighting workspace, from `songBeats(item)`: the same beats the editor shows
 * (useAudioEditor), on the song's own time. Recognition runs on `songMusicSource(item)`, the music track's source file,
 * and every change is a `setSongMusicCommand` on the song, never on its lighting.
 */
export function useMusicBeatSegments(item: RundownItem | undefined, analysis: ReturnType<typeof useAutomaticMusicAnalysis>, scope: string, projectPath: string | null, playing: boolean) {
  const runtimeBusy = useRuntimeStore(state => state.state !== 'idle');
  const blocked = playing || runtimeBusy;
  const [error, setError] = useState('');
  const [selectedId, select] = useState<string | null>(null);
  const source = item ? songMusicSource(item) : undefined;
  const placed = item ? songBeats(item) : undefined;
  const data: PlacedSongBeats | undefined = placed && (placed.state === 'ready' || placed.state === 'cleared') ? placed : undefined;
  const stale = placed?.state === 'stale' ? placed.reason : null;
  const points = data?.segments ?? noSegments;
  const snapPoints = data?.state === 'ready' ? data.editPointsMs : noPoints;
  const busy = analysis.submitting || Boolean(analysis.job && ['queued', 'checking', 'running', 'pausing', 'cancelling'].includes(analysis.job.state));
  const itemId = item?.id;
  /** The song as it is now: an edit always starts from the store, not from the last render. */
  const current = useCallback((): RundownItem => {
    const song = useDocumentStore.getState().project?.rundown.find(entry => entry.id === itemId);
    if (!song) throw new Error('节目已经不在了，这次没有修改节拍');
    return song;
  }, [itemId]);
  const commit = useCallback((music: SongMusic, label: string, background = false): void => {
    // The beats belong to the audio they came from: beats from before 0.5.9 keep the song audio they were analysed from.
    const song = current(), audio = songMusicAudio(song, music);
    if (!audio) throw new Error('这首歌的音乐换了，这次没有修改节拍。请重新识别');
    useDocumentStore.getState().execute(setSongMusicCommand(song.id, audio, music, { label, background }));
  }, [current]);
  const run = useCallback((action: () => void): void => { if (blocked) return; try { action(); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, [blocked]);
  useEffect(() => {
    if (!item || !source || !projectPath || blocked || !analysis.status?.available || data || analysis.job || attempted.has(scope)) return;
    remember(attempted, scope); void analysis.start();
  }, [item, source, projectPath, blocked, analysis, data, scope]);
  useEffect(() => {
    const job = analysis.job;
    if (!item || !source || blocked || job?.state !== 'completed' || !job.candidates) return;
    const key = `${scope}:${job.taskId}`;
    if (delivered.has(key) || data && !requested.has(scope)) return;
    const background = !requested.has(scope);
    remember(delivered, key); requested.delete(scope);
    run(() => commit(acceptMusicStructure(current(), source, job.candidates!, job.taskId), '自动识别音乐节拍与段落', background));
  }, [analysis.job, item, source, scope, blocked, data, run, commit, current]);
  const start = (): void => {
    if (blocked || busy) return;
    remember(requested, scope); remember(attempted, scope); setError('');
    void analysis.start();
  };
  const clear = (): void => run(() => {
    if (!source) return;
    const song = current();
    commit(data && song.music ? editMusicStructure(song, { kind: 'clear' }) : clearedSongMusic(source, 'dismissed'), '清除音乐识别标记');
    remember(attempted, scope); requested.delete(scope); analysis.clear(); select(null);
  });
  const cancel = (): void => {
    remember(attempted, scope); requested.delete(scope);
    if (analysis.job) remember(delivered, `${scope}:${analysis.job.taskId}`);
    if (!blocked && !data && source) run(() => commit(clearedSongMusic(source, 'cancelled'), '取消音乐分析'));
    void analysis.control('cancel');
  };
  const sourceSegment = (id: string): SongBeatSegment => {
    const segment = points.find(entry => entry.id === id);
    if (!segment) throw new Error('段落已不存在');
    return segment;
  };
  const remove = (id: string): void => run(() => { commit(editMusicStructure(current(), { kind: 'remove-segment', id: sourceSegment(id).sourceId }), '删除音乐段落'); select(null); });
  const removeBeat = (id: string): void => run(() => {
    const beat = data?.beats.find(entry => entry.id === id);
    if (!beat) throw new Error('拍点已不存在');
    commit(editMusicStructure(current(), { kind: 'remove-beat', id: beat.sourceId }), '删除音乐拍点');
  });
  /** `segment` in song time, as the panel shows it; saved in the time of the audio the beats belong to. */
  const update = (segment: SongBeatSegment): void => run(() => {
    if (!data) throw new Error('还没有音乐识别结果');
    const startMs = songTimeToMusicSource(data, segment.startMs), endMs = songTimeToMusicSource(data, segment.endMs);
    if (startMs === undefined || endMs === undefined) throw new Error('这个位置的音乐被剪掉了，段落的开始和结束要放在有音乐的地方');
    const { sourceId, ...fields } = segment;
    commit(editMusicStructure(current(), { kind: 'segment', segment: { ...fields, id: sourceId, startMs, endMs } }), '修改音乐段落');
  });
  return { data, stale, snapPoints, points, error, blocked, busy, selected: points.find(segment => segment.id === selectedId), select, remove, removeBeat, update, start, cancel, clear };
}
const noSegments: readonly SongBeatSegment[] = [];
const noPoints: readonly number[] = [];
export type MusicBeatSegments = ReturnType<typeof useMusicBeatSegments>;
