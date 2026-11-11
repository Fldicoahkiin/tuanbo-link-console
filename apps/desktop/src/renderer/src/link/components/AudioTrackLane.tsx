import { useEffect, useState, type HTMLAttributes } from 'react';
import type { AudioTrack } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { waveformDisplayReady, type WaveformDisplay } from '../view-models/waveform-draw';
import { useSongWaveform } from './ReferenceWaveform';
import { AudioTimelineSegments } from './AudioTimelineSegments';
import type { AudioEditor } from './useAudioEditor';
import type { EditorPlayhead } from './editor-playhead';

/** One audio track: each segment draws its part of the source file's waveform. The editor shows the plain
 * waveform; the lighting workbench picks rhythm band, waveform or spectrum. All come from the same levels. */
export function AudioTrackLane(props: { readOnly?: boolean; referencePointer?: Pick<HTMLAttributes<HTMLDivElement>, 'onPointerDown'|'onPointerMove'|'onPointerUp'|'onPointerCancel'> | undefined; playhead: EditorPlayhead; display: WaveformDisplay; track: AudioTrack; editor: AudioEditor; projectPath: string | null; pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; onSelect: (id: string) => void; onSeek: (ms: number) => void; snapTime: (ms: number) => number }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { projectPath, track } = props;
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError(null);
    if (projectPath) void linkDesktopViewModel.resolveReferenceAudioUrl({ projectPath, relativePath: track.source.relativePath }).then(value => { if (!cancelled) setUrl(value); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [projectPath, track.source.relativePath]);
  const waveform = useSongWaveform(projectPath && url ? { projectPath, url, sha256: track.source.sha256, durationMs: track.source.durationMs } : null);
  const waiting = waveform.waveform && !waveformDisplayReady(waveform.waveform, props.display);
  return <div className="timeline-lane waveform-lane" onPointerDown={event => { if (event.target === event.currentTarget) props.onSeek(event.nativeEvent.offsetX / props.pixelsPerSecond * 1000); }} {...(props.readOnly ? props.referencePointer : {})}>
    <AudioTimelineSegments readOnly={props.readOnly === true} playhead={props.playhead} waveform={waveform.waveform} display={props.display} editor={props.editor.trackEditor(track)} snapTime={props.snapTime} sourceWaveform scrollLeft={props.scrollLeft} viewportWidth={props.viewportWidth} pixelsPerSecond={props.pixelsPerSecond} onSelect={props.onSelect} onSeek={props.onSeek} />
    {!waveform.waveform && !error && !waveform.error && url ? <span className="timeline-lane-empty">正在生成波形…</span> : null}
    {/* An older cache stands in until the song is generated again, which waits for the show to stop. */}
    {waiting && !waveform.error ? <span className="timeline-lane-empty">{props.display === 'rhythm' ? '节奏波形' : '频谱'}还没生成，先显示普通波形；停止播放后会自动生成</span> : null}
    {error || waveform.error ? <span className="timeline-lane-error">{error ?? waveform.error}</span> : null}
  </div>;
}
