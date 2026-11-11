import { AudioLines } from 'lucide-react';
import type { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import { musicAnalysisHeading, musicAnalysisShortHeading } from '../view-models/music-analysis-display';
import { musicSegmentAt } from '../view-models/music-segment-display';
import { usePlayheadValue, type EditorPlayhead } from './editor-playhead';
import { isSimpleBeats, type MusicBeatSegments } from './useMusicBeatSegments';

/**
 * The 音乐识别 button on the timeline toolbar of the editor and the lighting workbench (0.5.9 E11): the BPM of the section
 * at the playhead or how the recognition is going, and it opens the song's music panel. `compact` (the editor) keeps
 * only the icon and the BPM, so the editor's toolbar stays one row at 1280×720.
 */
export function MusicAnalysisButton({ beats, analysis, playhead, open, onOpen, compact = false }: {
  beats: MusicBeatSegments; analysis: ReturnType<typeof useAutomaticMusicAnalysis>; playhead: EditorPlayhead;
  open: boolean; onOpen: () => void; compact?: boolean;
}): JSX.Element {
  const job = analysis.job;
  // The section at the playhead: drawn again only when the playhead enters another one (0.5.9 E2).
  const current = usePlayheadValue(playhead, positionMs => musicSegmentAt(beats.points, positionMs));
  // Beats from the simple detection say so wherever the BPM is read (0.5.9 design 6.3).
  const status = beats.busy ? '分析中' : beats.simple.detecting ? '检测中' : job?.state === 'failed' ? '失败' : isSimpleBeats(beats) ? '简易检测的节拍' : beats.data?.beatsPerBar ? `每小节 ${beats.data.beatsPerBar} 拍` : '';
  const heading = musicAnalysisHeading(beats.data, current, job, analysis.submitting, analysis.error);
  const title = job?.message || (current ? `${current.name} · 当前段落估算速度` : '音乐识别：打开查看节拍和段落');
  return <button type="button" className="music-analysis-button" data-compact={compact} aria-label="音乐分析" aria-pressed={open} title={compact ? `音乐识别 · ${heading}${status ? ` · ${status}` : ''}` : undefined} onClick={onOpen}>
    <AudioLines /><strong className="music-bpm" title={compact ? undefined : title}>{compact ? musicAnalysisShortHeading(beats.data, current, job, analysis.submitting, analysis.error) : heading}</strong>
    {compact ? null : <><span>音乐识别</span>{status ? <small>{status}</small> : null}</>}
  </button>;
}
