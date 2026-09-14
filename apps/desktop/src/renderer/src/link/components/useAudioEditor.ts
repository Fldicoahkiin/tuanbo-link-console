import { useEffect, useRef, useState } from 'react';
import { audioSegments, editedAudio, editReferenceAudioCommand, splitAudioSegments, updateAudioSegment } from '@tb/core/link';
import { audioBeatAnalysisSchema, referenceAudioSchema, type AudioBeatAnalysis, type AudioBeatLevel, type AudioSegment, type RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export function useAudioEditor(item: RundownItem | null, projectPath: string | null, disabled: boolean, notify: (message: string, tone?: 'info' | 'error') => void) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AudioBeatAnalysis | null>(null);
  const [level, setLevel] = useState<AudioBeatLevel>('standard');
  const [busy, setBusy] = useState(false);
  const processing = useRef(false);
  const audio = item?.referenceAudio;
  useEffect(() => { setAnalysis(null); }, [item?.id, audio?.sha256]);
  useEffect(() => { setSelectedId(null); }, [item?.id]);
  useEffect(() => { setLevel(audio?.beats?.level ?? 'standard'); }, [item?.id, audio?.beats?.level]);
  const segments = audio ? audioSegments(audio) : [];
  const selected = segments.find((segment) => segment.id === selectedId) ?? null;
  const points = analysis?.[level] ?? audio?.beats?.levels?.[level] ?? audio?.beats?.pointsMs ?? [];
  const current = (): boolean => useDocumentStore.getState().project?.rundown.find((entry) => entry.id === item?.id)?.referenceAudio === audio;
  const commit = (next: NonNullable<RundownItem['referenceAudio']>, label: string, kind: 'audio' | 'markers' = 'audio'): void => {
    if (!item || !current()) throw new Error('节目或音频已改变，请重新执行操作');
    if (kind === 'audio' && (disabled || useRuntimeStore.getState().state !== 'idle')) throw new Error('请停止播放后应用音频修改');
    useDocumentStore.getState().execute(editReferenceAudioCommand(item.id, next, label));
  };
  const run = async (operation: () => void | Promise<void>): Promise<void> => {
    if (processing.current) { notify('请等待音频处理完成', 'info'); return; }
    processing.current = true; setBusy(true);
    try { await operation(); } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { processing.current = false; setBusy(false); }
  };
  const render = async (next: AudioSegment[], label: string): Promise<void> => {
    if (disabled || useRuntimeStore.getState().state !== 'idle') throw new Error('请停止播放后编辑音频片段');
    if (!audio || !projectPath) throw new Error('请先保存工程并添加歌曲音频');
    if (!next.length) throw new Error('至少保留一个音频片段；可在节目属性中更换歌曲');
    const rendered = referenceAudioSchema.parse(await linkDesktopViewModel.renderAudioSegments({ projectPath, source: audio.timeline?.source ?? audio, segments: next }));
    commit(editedAudio(audio, next, rendered), label);
  };
  return {
    audio, title: item?.title ?? '歌曲音频', segments, selected, selectedId, setSelectedId, level, setLevel, points, busy, disabled: disabled || busy,
    select: (id: string | null) => setSelectedId(id),
    analyze: () => run(async () => {
      if (!audio || !projectPath) throw new Error('请先保存工程并添加歌曲音频');
      const result = audioBeatAnalysisSchema.parse(await linkDesktopViewModel.analyzeAudioBeats({ projectPath, source: audio }));
      if (!current()) throw new Error('分析期间音频已改变，请重新分析');
      setAnalysis(result);
      if (!result.dense.length) notify('没有检测到明显节奏点，请按听感手动放置灯光 Cue', 'info');
    }),
    mark: () => run(() => { if (audio) commit({ ...audio, beats: { sourceSha256: audio.sha256, level, pointsMs: points, levels: analysis ?? audio.beats?.levels } }, '应用音频节拍标记', 'markers'); }),
    clearMarks: () => run(() => { if (audio) { const next = { ...audio }; delete next.beats; commit(next, '清除音频节拍标记', 'markers'); setAnalysis(null); } }),
    split: (timeMs: number) => run(() => {
      if (!audio) return;
      const target = selected ? [selected] : segments;
      const split = splitAudioSegments(target, [timeMs]);
      if (split.length === target.length) throw new Error('播放头需要位于音频片段内部');
      const next = selected ? segments.flatMap((segment) => segment.id === selected.id ? split : [segment]) : split;
      commit(editedAudio(audio, next), '分割歌曲音频');
    }),
    update: (id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>) => run(async () => {
      if (audio) await render(updateAudioSegment(audio, id, patch), '编辑音频片段');
    }),
    remove: () => run(async () => { if (selected) { await render(segments.filter((segment) => segment.id !== selected.id), '删除音频片段'); setSelectedId(null); } })
  };
}

export type AudioEditor = ReturnType<typeof useAudioEditor>;
