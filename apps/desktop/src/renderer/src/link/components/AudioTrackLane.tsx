import { useAudioWaveformSamples } from './useAudioWaveformSamples';
import { useEffect, useState, type HTMLAttributes } from 'react';
import type { AudioTrack } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { useReferenceWaveformPeaks } from './ReferenceWaveform';
import { AudioTimelineSegments } from './AudioTimelineSegments';
import type { AudioEditor } from './useAudioEditor';
import type { EditorPlayhead } from './editor-playhead';

const EMPTY_PEAKS: readonly number[] = [];

export function AudioTrackLane(props: { readOnly?: boolean; referencePointer?: Pick<HTMLAttributes<HTMLDivElement>, 'onPointerDown'|'onPointerMove'|'onPointerUp'|'onPointerCancel'> | undefined; playhead: EditorPlayhead; rhythm?: boolean; detailed?: boolean; track: AudioTrack; editor: AudioEditor; projectPath: string | null; pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; onSelect: (id: string) => void; onSeek: (ms: number) => void; snapTime: (ms: number) => number }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { projectPath, track } = props;
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError(null);
    if (projectPath) void linkDesktopViewModel.resolveReferenceAudioUrl({ projectPath, relativePath: track.source.relativePath }).then(value => { if (!cancelled) setUrl(value); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [projectPath, track.source.relativePath]);
  const waveform = useReferenceWaveformPeaks(projectPath && url && !props.detailed ? { projectPath, url, sha256: track.source.sha256, durationMs: track.source.durationMs } : null);
  const detail = useAudioWaveformSamples(url, props.detailed === true, props.rhythm === true);
  return <div className="timeline-lane waveform-lane" onPointerDown={event => { if (event.target === event.currentTarget) props.onSeek(event.nativeEvent.offsetX / props.pixelsPerSecond * 1000); }} {...(props.readOnly ? props.referencePointer : {})}>
    <AudioTimelineSegments readOnly={props.readOnly === true} playhead={props.playhead} samples={detail.buffer} editor={props.editor.trackEditor(track)} snapTime={props.snapTime} sourceWaveform peaks={props.detailed ? EMPTY_PEAKS : waveform.peaks} scrollLeft={props.scrollLeft} viewportWidth={props.viewportWidth} pixelsPerSecond={props.pixelsPerSecond} onSelect={props.onSelect} onSeek={props.onSeek} />
    {props.detailed && !detail.buffer && !detail.error ? <span className="timeline-lane-empty">正在读取原始采样…</span> : null}
    {detail.error ? <span className="timeline-lane-error">{detail.error}</span> : null}
    {error || waveform.error ? <span className="timeline-lane-error">{error ?? waveform.error}</span> : null}
  </div>;
}
