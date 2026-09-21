import { WandSparkles, CheckCheck, LoaderCircle } from 'lucide-react';
import { cuesFromAudioMarks, hasAutomaticCueBatch } from '@tb/core/link';
import type { LightingTimelineProps } from './LightingTimeline';
import type { AudioEditor } from './useAudioEditor';

export function TimelineAutoAnalyze({ editor, lighting }: { editor: AudioEditor; lighting: LightingTimelineProps | undefined }): JSX.Element {
  const stamp = (points: number[]): void => {
    if (!lighting || !editor.audio) return;
    try { const next = cuesFromAudioMarks(lighting.document, points, editor.audio.durationMs, lighting.selectedClipId, editor.audio.sha256); if (next !== lighting.document) lighting.onChange(next, '自动生成 Cue'); }
    catch (error) { lighting.onError?.(String(error)); }
  };
  const count = lighting?.document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.kind === 'ma2' && (!event.effectGroupId || event.effectGroupId === event.id)))).length ?? 0;
  const generated = Boolean(lighting && editor.audio && hasAutomaticCueBatch(lighting.document, editor.audio.sha256, editor.audio.durationMs));
  return <div className="timeline-auto-analyze">
    <button type="button" aria-label="自动打 Cue" aria-busy={editor.busy} disabled={editor.disabled || !editor.audio || !lighting || generated}
      title={`${editor.busy ? '正在分析音乐节奏' : generated ? '本首音频已生成 Cue，保留你移动和删除后的结果' : '自动打 Cue：分析音乐节奏并生成卡点'}${count ? ` · ${count} 个 Cue` : ''}`} onClick={() => void editor.analyze(stamp)}>
      {editor.busy ? <LoaderCircle className="analysis-spinner" /> : generated ? <CheckCheck /> : <WandSparkles />}
    </button>
  </div>;
}
