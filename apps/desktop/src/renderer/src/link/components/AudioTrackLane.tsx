import { useEffect, useState } from 'react';
import type { AudioTrack } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { useReferenceWaveformPeaks } from './ReferenceWaveform';
import { AudioTimelineSegments } from './AudioTimelineSegments';
import type { AudioEditor } from './useAudioEditor';

export function AudioTrackLane(props: { track: AudioTrack; editor: AudioEditor; projectPath: string | null; pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; onSelect: (id: string) => void; onSeek: (ms: number) => void; snapTime: (ms: number) => number }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { projectPath, track } = props;
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError(null);
    if (projectPath) void linkDesktopViewModel.resolveReferenceAudioUrl({ projectPath, relativePath: track.source.relativePath }).then(value => { if (!cancelled) setUrl(value); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [projectPath, track.source.relativePath]);
  const waveform = useReferenceWaveformPeaks(projectPath && url ? { projectPath, url, sha256: track.source.sha256, durationMs: track.source.durationMs } : null);
  return <div className="timeline-lane waveform-lane" onPointerDown={event => { if (event.target === event.currentTarget) props.onSeek(event.nativeEvent.offsetX / props.pixelsPerSecond * 1000); }}>
    <AudioTimelineSegments editor={props.editor.trackEditor(track)} snapTime={props.snapTime} sourceWaveform peaks={waveform.peaks} scrollLeft={props.scrollLeft} viewportWidth={props.viewportWidth} pixelsPerSecond={props.pixelsPerSecond} onSelect={props.onSelect} onSeek={props.onSeek} />
    {error || waveform.error ? <span className="timeline-lane-error">{error ?? waveform.error}</span> : null}
  </div>;
}
