import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acceptMusicStructure, editMusicStructure, matchingMusicStructure, musicStructureSegments, recognizeMusicStructure } from '@tb/core/link';
import type { ReferenceAudio, LightingDocument, MusicStructureSegment } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import type { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import { useRuntimeStore } from '../stores/runtime-store';

// Mounting a tab again must not undo cancellation or reapply an undone result.
const attempted = new Set<string>();
const delivered = new Set<string>();
const remember = (set: Set<string>, key: string): void => { set.add(key); if (set.size > 2000) set.delete(set.values().next().value!); };

export function useMusicBeatSegments(lighting: LightingTimelineProps | undefined, source: ReferenceAudio | undefined, analysis: ReturnType<typeof useAutomaticMusicAnalysis>, scope: string, projectPath: string | null, playing: boolean) {
  const runtimeBusy = useRuntimeStore(state => state.state !== 'idle');
  const blocked = playing || runtimeBusy;
  const [error, setError] = useState('');
  const [selectedId, select] = useState<string | null>(null);
  const rerun = useRef<string | null>(null);
  const data = matchingMusicStructure(lighting?.document, source);
  const points = useMemo(() => data ? musicStructureSegments(data) : [], [data]);
  const snapPoints = useMemo(() => data?.state === 'ready' ? [...data.beats.map(beat => beat.atMs), ...data.segments.flatMap(segment => [segment.startMs, segment.endMs])] : [], [data]);
  const busy = analysis.submitting || Boolean(analysis.job && ['queued', 'checking', 'running', 'pausing', 'cancelling'].includes(analysis.job.state));
  const commit = useCallback((next: LightingDocument, label: string): void => {
    const result: unknown = lighting?.onChange(next, label);
    if (result === false) throw new Error('工程保存失败，请处理提示后重试');
  }, [lighting]);
  const run = useCallback((action: () => void): void => { if (blocked) return; try { action(); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, [blocked]);
  useEffect(() => {
    if (!lighting || !source || !projectPath || blocked || !analysis.status?.available || data || analysis.job || attempted.has(scope)) return;
    remember(attempted, scope); void analysis.start();
  }, [lighting, source, projectPath, blocked, analysis, data, scope]);
  useEffect(() => {
    const job = analysis.job;
    if (!lighting || !source || blocked || job?.state !== 'completed' || !job.candidates) return;
    const key = `${scope}:${job.taskId}`;
    if (delivered.has(key) || data && rerun.current !== scope) return;
    remember(delivered, key); rerun.current = null;
    run(() => commit(acceptMusicStructure(lighting.document, source, job.candidates!, job.taskId), '自动识别音乐节拍与段落'));
  }, [analysis.job, lighting, source, scope, blocked, data, run, commit]);
  const start = (): void => {
    if (blocked || busy) return;
    rerun.current = scope; remember(attempted, scope); setError('');
    void analysis.start();
  };
  const clear = (): void => run(() => {
    if (!lighting || !source) return;
    const document = data ? lighting.document : { ...lighting.document, version: 2 as const, musicAnalysis: recognizeMusicStructure({ sourceSha256: source.sha256, durationMs: source.durationMs, bpm: null, items: [] }, 'dismissed') };
    commit(editMusicStructure(document, { kind: 'clear' }), '清除音乐识别标记');
    remember(attempted, scope); rerun.current = null; analysis.clear(); select(null);
  });
  const cancel = (): void => run(() => {
    remember(attempted, scope); rerun.current = null;
    if (analysis.job) remember(delivered, `${scope}:${analysis.job.taskId}`);
    if (!data && lighting && source) {
      const result = recognizeMusicStructure({ sourceSha256: source.sha256, durationMs: source.durationMs, bpm: null, items: [] }, 'cancelled');
      commit({ ...lighting.document, version: 2, musicAnalysis: { ...result, state: 'cleared' } }, '取消音乐分析');
    }
    void analysis.control('cancel');
  });
  const remove = (id: string): void => run(() => { if (lighting) { commit(editMusicStructure(lighting.document, { kind: 'remove-segment', id }), '删除音乐段落'); select(null); } });
  const removeBeat = (id: string): void => run(() => { if (lighting) commit(editMusicStructure(lighting.document, { kind: 'remove-beat', id }), '删除音乐拍点'); });
  const update = (segment: MusicStructureSegment): void => run(() => { if (lighting) commit(editMusicStructure(lighting.document, { kind: 'segment', segment }), '修改音乐段落'); });
  return { data, snapPoints, points, error, blocked, busy, selected: points.find(segment => segment.id === selectedId), select, remove, removeBeat, update, start, cancel, clear };
}
export type MusicBeatSegments = ReturnType<typeof useMusicBeatSegments>;
