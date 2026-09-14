import { useEffect, type RefObject, type ReactNode } from 'react';
import {
  Magnet,
  Maximize2,
  Pause,
  Play,
  Square,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import type { MtcFrameRate } from '@tb/schema';
import { playbackFramesPerSecond } from '@tb/core/link';
import { clampTimelineTime, formatTimelineTimecode, snapTimelineTime } from './timeline-geometry';
import type { ReferenceWaveformSource } from './ReferenceWaveform';

type Props = {
  externalTransport?: boolean | undefined;
  onStop?: (() => void) | undefined;
  recordingControl?: ReactNode;
  frameRate: MtcFrameRate;
  durationMs: number;
  playheadMs: number;
  playing: boolean;
  playbackReady?: boolean;
  referenceAudio: ReferenceWaveformSource | null;
  snapEnabled: boolean;
  snapDistance: number;
  onSnapDistanceChange: (distance: number) => void;
  editPoints: readonly number[];
  audioRef: RefObject<HTMLAudioElement>;
  onPlayheadChange: (milliseconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onPlaybackError: (message: string) => void;
  onSnapEnabledChange: (enabled: boolean) => void;
  onZoomOut: () => void;
  onFit: () => void;
  onZoomIn: () => void;
};

export function TimelineToolbar(props: Props): JSX.Element {
  const audioUrl = props.referenceAudio?.url;
  const { audioRef, onPlaybackError, onPlayingChange, onPlayheadChange, playheadMs, playing } = props;
  useEffect(() => {
    const audio = audioRef.current;
    if (props.externalTransport || !audio || !audioUrl || !playing || props.playbackReady === false) return;
    const timer = window.setInterval(() => {
      onPlayheadChange(audio.currentTime * 1000);
      if (audio.ended) onPlayingChange(false);
    }, 16);
    return () => window.clearInterval(timer);
  }, [audioRef, audioUrl, playing, onPlayheadChange, onPlayingChange, props.playbackReady, props.externalTransport]);
  useEffect(() => { if (props.externalTransport) return; const audio = audioRef.current; return () => { audio?.pause(); }; }, [audioRef, audioUrl, props.externalTransport]);
  useEffect(() => {
    const audio = audioRef.current;
    if (props.externalTransport || !audio || !audioUrl) return;
    if (props.playbackReady === false) { audio.pause(); return; }
    const desiredSeconds = playheadMs / 1_000;
    if (Math.abs(audio.currentTime - desiredSeconds) > (playing ? 0.75 : 0.04)) audio.currentTime = desiredSeconds;
    if (Number.isFinite(audio.duration) && desiredSeconds >= audio.duration) {
      audio.pause();
      if (playing) onPlayingChange(false);
      return;
    }
    if (!playing) {
      audio.pause();
      return;
    }
    if (!audio.paused) return;
    void audio.play().catch((error: unknown) => {
      onPlayingChange(false);
      onPlaybackError(error instanceof Error ? error.message : String(error));
    });
  }, [audioRef, audioUrl, onPlaybackError, onPlayingChange, playheadMs, playing, props.playbackReady, props.externalTransport]);

  const seekTo = (milliseconds: number): void => {
    props.onPlayingChange(false);
    const target = props.snapEnabled ? snapTimelineTime(milliseconds, props.frameRate) : milliseconds;
    props.onPlayheadChange(clampTimelineTime(target, props.durationMs));
  };
  const framesPerSecond = playbackFramesPerSecond(props.frameRate);
  const frameDurationMs = 1_000 / framesPerSecond;
  const togglePlayback = (): void => {
    if (!props.playing && (props.playheadMs >= props.durationMs || (props.referenceAudio && props.playheadMs >= props.referenceAudio.durationMs) || props.audioRef.current?.ended)) props.onPlayheadChange(0);
    props.onPlayingChange(!props.playing);
  };

  return <div className="timeline-toolbar">
    <div className="timeline-edit-controls" aria-label="时间线剪辑工具">
      {props.recordingControl}
      <details className="timeline-navigation-menu"><summary>定位</summary><div>
        <button onClick={(event) => { const point = [...props.editPoints].filter((point) => point < props.playheadMs - frameDurationMs / 2).sort((a, b) => b - a)[0]; seekTo(point ?? 0); event.currentTarget.closest('details')?.removeAttribute('open'); }}>上一剪辑点</button>
        <button onClick={(event) => { const point = [...props.editPoints].filter((point) => point > props.playheadMs + frameDurationMs / 2).sort((a, b) => a - b)[0]; seekTo(point ?? props.durationMs); event.currentTarget.closest('details')?.removeAttribute('open'); }}>下一剪辑点</button>
        <p>Space 播放 / 暂停<br />← → 逐帧移动<br />S 在播放头切割<br />Ctrl+C / V 复制粘贴</p>
      </div></details>
    </div>

    <div className="timeline-transport" aria-label="时间线播放控制">
      <button aria-label="回到时间线开头" title="回到开头（Home）" onClick={() => seekTo(0)}><SkipBack /></button>
      <button aria-label="上一帧" title="上一帧（←）" onClick={() => seekTo(props.playheadMs - frameDurationMs)}><StepBack /></button>
      <button className="timeline-play-button" aria-label={props.playing ? '暂停时间线' : '播放时间线'} title={props.playing ? '暂停（Space）' : '播放（Space）'} onClick={togglePlayback}>{props.playing ? <Pause /> : <Play />}</button>
      <button aria-label="下一帧" title="下一帧（→）" onClick={() => seekTo(props.playheadMs + frameDurationMs)}><StepForward /></button>
      <button aria-label="跳到时间线结尾" title="跳到结尾" onClick={() => seekTo(props.durationMs)}><SkipForward /></button>
      {props.externalTransport ? <button aria-label="停止时间线" title="停止播放（Esc）" onClick={props.onStop}><Square /></button> : null}
      <code title="当前播放头时间码">{formatTimelineTimecode(props.playheadMs, props.frameRate)}</code>
    </div>

    <div className="timeline-view-controls">
      <button
        className={`timeline-snap-state ${props.snapEnabled ? 'active' : ''}`}
        aria-pressed={props.snapEnabled}
        title={props.snapEnabled ? '关闭吸附' : '开启吸附'}
        onClick={() => props.onSnapEnabledChange(!props.snapEnabled)}
      ><Magnet />{props.snapEnabled ? '吸附开' : '吸附关'}</button>
      <select className="timeline-snap-distance" aria-label="吸附强度" title="片段两端、机位边缘和播放头之间的吸附距离" value={props.snapDistance} disabled={!props.snapEnabled} onChange={(event) => props.onSnapDistanceChange(Number(event.currentTarget.value))}><option value={8}>轻 · 8 px</option><option value={14}>标准 · 14 px</option><option value={22}>强 · 22 px</option></select>
      <button className="icon-button" aria-label="缩小时间线" title="缩小时间线" onClick={props.onZoomOut}><ZoomOut /></button>
      <button className="timeline-fit-button" aria-label="适合节目时长" title="缩放至全部节目内容" onClick={props.onFit}><Maximize2 /><span>全部</span></button>
      <button className="icon-button" aria-label="放大时间线" title="放大时间线" onClick={props.onZoomIn}><ZoomIn /></button>
    </div>

    {!props.externalTransport && props.referenceAudio ? <audio
      className="timeline-audio-engine"
      ref={props.audioRef}
      preload="auto"
      src={props.referenceAudio.url}
      onEnded={(event) => { props.onPlayheadChange(event.currentTarget.currentTime * 1000); props.onPlayingChange(false); }}
    /> : null}
  </div>;
}
